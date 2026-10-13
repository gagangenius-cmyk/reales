import { randomUUID } from "node:crypto";
import { Op, Sequelize, WhereOptions } from "sequelize";
import { mysqlDate, RequestContext } from "@reales/database";
import { authorize, ForbiddenError, hasPermission } from "@reales/rbac";
import { buildCanonicalListing, publishToPortals } from "./portal-publish";
import { resolveListingRule } from "./regulatory";
import { plain, scopeWhere, ScopeColumns } from "./scope";
import { assertSweepAllowed, ConflictError, NotFoundError, Uow, withUow } from "./uow";

export const LISTING_SCOPE: ScopeColumns = { owner: "agentUserId", branch: "branchId", project: "projectId" };
const ref = (l: any) => ({ ownerUserId: l.get("agentUserId"), branchId: l.get("branchId"), projectId: l.get("projectId") });

export interface ListingIssue { code: string; message: string }
export interface ListingEvaluation { publishable: boolean; issues: ListingIssue[]; jurisdiction: string; ruleVersion: number | null }

export class ListingNotPublishableError extends Error {
  status = 422;
  constructor(public evaluation: ListingEvaluation) {
    super("Listing does not meet publication requirements");
    this.name = "ListingNotPublishableError";
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim());

/**
 * The hard compliance gate: listing.publishable = permit.valid && broker.valid && requiredFields.valid (+ jurisdiction extras).
 * Evaluated against the rule version in force today for the listing's jurisdiction; an unknown jurisdiction blocks publication.
 * Validity is checked against the calendar date at evaluation time, so an expired permit blocks even if it was verified earlier.
 */
export async function evaluateListing(u: Uow, listing: any, now = new Date()): Promise<ListingEvaluation> {
  const jurisdiction = listing.get("jurisdictionCode") as string;
  const issues: ListingIssue[] = [];
  const rule = await resolveListingRule(u.sq, jurisdiction, now);
  if (!rule) return { publishable: false, jurisdiction, ruleVersion: null, issues: [{ code: "jurisdiction_unsupported", message: `No publication rules configured for ${jurisdiction}` }] };
  const r = rule.definition;
  const day = now.toISOString().slice(0, 10);

  for (const f of r.requiredListingFields) if (blank(listing.get(f))) issues.push({ code: "field_missing", message: `Listing field "${f}" is required` });
  if (!(Number(listing.get("price")) > 0)) issues.push({ code: "price_invalid", message: "Price must be greater than zero" });

  const unit: any = await u.repo("Unit").findById(listing.get("unitId"), { transaction: u.tx });
  if (!unit) issues.push({ code: "unit_missing", message: "Unit not found" });
  else {
    for (const f of r.requiredUnitFields) if (blank(unit.get(f))) issues.push({ code: "unit_field_missing", message: `Unit field "${f}" is required` });
    if (r.unitMustBeAvailable && unit.get("status") !== "available") issues.push({ code: "unit_unavailable", message: `Unit is ${unit.get("status")}, not available` });
    const building: any = await u.repo("Building").findById(unit.get("buildingId"), { transaction: u.tx });
    const project: any = building ? await u.repo("ReProject").findById(building.get("reProjectId"), { transaction: u.tx }) : null;
    if (project?.get("kind") === "off_plan") {
      if (r.offPlan.requireRegistrationNo && blank(project.get("registrationNo"))) issues.push({ code: "offplan_unregistered", message: "Off-plan project has no registration number" });
      if (r.offPlan.requireEscrowRef && blank(project.get("escrowAccountRef"))) issues.push({ code: "offplan_no_escrow", message: "Off-plan project has no escrow account reference" });
    }
  }

  const images = await u.repo("ListingMedia").count({ where: { kind: "image" , listingId: listing.get("id") }, transaction: u.tx });
  if (images < r.minImages) issues.push({ code: "media_insufficient", message: `At least ${r.minImages} images required (has ${images})` });

  if (r.permit.required) {
    const permits = await u.repo("ListingPermit").findAll({ where: { listingId: listing.get("id") }, transaction: u.tx });
    const ok = permits.some((p: any) => p.get("status") === "valid" && p.get("expiresAt") >= day && (r.permit.authorities.length === 0 || r.permit.authorities.includes(p.get("authority"))));
    if (!ok) {
      const any = permits.length > 0;
      issues.push({ code: any ? "permit_invalid" : "permit_missing", message: any ? "No valid, unexpired advertising permit from an accepted authority" : "An advertising permit is required" });
    }
  }
  if (r.brokerLicence.required) {
    const lic: any = listing.get("brokerLicenceId") ? await u.repo("BrokerLicence").findById(listing.get("brokerLicenceId"), { transaction: u.tx }) : null;
    const ok = lic && lic.get("validationStatus") === "valid" && lic.get("expiresAt") >= day && lic.get("holderType") === "company" && (r.brokerLicence.authorities.length === 0 || r.brokerLicence.authorities.includes(lic.get("authority")));
    if (!ok) issues.push({ code: lic ? "broker_licence_invalid" : "broker_licence_missing", message: lic ? "Brokerage licence is unverified, expired, revoked or from an unaccepted authority" : "A verified brokerage licence is required" });
  }
  if (r.agentLicence.required) {
    const agentId = listing.get("agentUserId");
    const lics = agentId ? await u.repo("BrokerLicence").findAll({ where: { userId: agentId, holderType: "agent" }, transaction: u.tx }) : [];
    const ok = lics.some((l: any) => l.get("validationStatus") === "valid" && l.get("expiresAt") >= day && (r.agentLicence.authorities.length === 0 || r.agentLicence.authorities.includes(l.get("authority"))));
    if (!ok) issues.push({ code: "agent_licence_invalid", message: "The listing agent has no verified, unexpired licence" });
  }
  return { publishable: issues.length === 0, issues, jurisdiction, ruleVersion: rule.ruleVersion };
}

async function scopedListing(u: Uow, ctx: RequestContext, id: string) {
  const scope = await scopeWhere(u, ctx, "listing.read", LISTING_SCOPE);
  const l: any = await u.repo("Listing").findOne({ where: { [Op.and]: [{ id }, scope] }, transaction: u.tx });
  if (!l) throw new NotFoundError("Listing");
  return l;
}

export interface CreateListingInput {
  unitId: string; purpose: "sale" | "rent"; title?: string; description?: string; price?: number; currency?: string;
  agentUserId?: string; brokerLicenceId?: string; branchId?: string; projectId?: string;
}

export async function createListing(sq: Sequelize, ctx: RequestContext, input: CreateListingInput) {
  authorize(ctx, "listing.manage", { ownerUserId: input.agentUserId ?? ctx.userId, branchId: input.branchId ?? ctx.membership.branchIds[0] ?? null, projectId: input.projectId ?? null });
  return withUow(sq, ctx, async (u) => {
    const unit: any = await u.repo("Unit").findById(input.unitId, { transaction: u.tx });
    if (!unit) throw new NotFoundError("Unit");
    const building: any = await u.repo("Building").findById(unit.get("buildingId"), { transaction: u.tx });
    const project: any = await u.repo("ReProject").findById(building.get("reProjectId"), { transaction: u.tx });
    const agent = input.agentUserId ?? ctx.userId;
    if (!(await u.repo("User").findOne({ where: { id: agent, status: "active" }, transaction: u.tx }))) throw new NotFoundError("Agent");
    if (input.brokerLicenceId && !(await u.repo("BrokerLicence").findById(input.brokerLicenceId, { transaction: u.tx }))) throw new NotFoundError("Broker licence");
    if (input.projectId && !(await u.repo("Project").findById(input.projectId, { transaction: u.tx }))) throw new NotFoundError("Project");
    const id = randomUUID();
    const price = input.price ?? (unit.get("listPrice") != null ? Number(unit.get("listPrice")) : null);
    const l = await u.repo("Listing").create({
      id, unitId: input.unitId, purpose: input.purpose, status: "draft", title: input.title ?? null, description: input.description ?? null,
      price, currency: input.currency ?? unit.get("currency"), agentUserId: agent, branchId: input.branchId ?? ctx.membership.branchIds[0] ?? null,
      projectId: input.projectId ?? project.get("crmProjectId") ?? null, jurisdictionCode: project.get("jurisdictionCode"), brokerLicenceId: input.brokerLicenceId ?? null,
    }, { transaction: u.tx });
    if (price != null) await u.repo("ListingPrice").create({ id: randomUUID(), listingId: id, price, currency: (l as any).get("currency"), changedBy: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    await u.emit({ type: "listing.created", aggregateType: "listing", aggregateId: id, projectId: (l as any).get("projectId"), payload: { unitId: input.unitId, purpose: input.purpose } });
    return plain(l);
  });
}

export async function updateListing(sq: Sequelize, ctx: RequestContext, id: string, patch: Partial<Pick<CreateListingInput, "title" | "description" | "price" | "brokerLicenceId" | "agentUserId">>) {
  return withUow(sq, ctx, async (u) => {
    const l = await scopedListing(u, ctx, id);
    authorize(ctx, "listing.manage", ref(l));
    if (patch.agentUserId && patch.agentUserId !== l.get("agentUserId")) {
      authorize(ctx, "lead.assign", ref(l)); // handing a listing to another agent is a manager action
      if (!(await u.repo("User").findOne({ where: { id: patch.agentUserId, status: "active" }, transaction: u.tx }))) throw new NotFoundError("Agent");
    }
    if (patch.brokerLicenceId && !(await u.repo("BrokerLicence").findById(patch.brokerLicenceId, { transaction: u.tx }))) throw new NotFoundError("Broker licence");
    await u.repo("Listing").updateById(id, patch as Record<string, unknown>, { transaction: u.tx });
    if (patch.price !== undefined && patch.price !== null && Number(patch.price) !== Number(l.get("price"))) {
      await u.repo("ListingPrice").create({ id: randomUUID(), listingId: id, price: patch.price, currency: l.get("currency"), changedBy: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    }
    await u.emit({ type: "listing.updated", aggregateType: "listing", aggregateId: id, projectId: l.get("projectId"), payload: { fields: Object.keys(patch) } });
    return plain(await u.repo("Listing").findById(id, { transaction: u.tx }));
  });
}

export async function addListingMedia(sq: Sequelize, ctx: RequestContext, id: string, input: { kind: "image" | "video" | "floorplan"; storageKey: string; position?: number }) {
  return withUow(sq, ctx, async (u) => {
    const l = await scopedListing(u, ctx, id);
    authorize(ctx, "listing.manage", ref(l));
    const count = await u.repo("ListingMedia").count({ where: { listingId: id }, transaction: u.tx });
    return plain(await u.repo("ListingMedia").create({ id: randomUUID(), listingId: id, kind: input.kind, storageKey: input.storageKey, position: input.position ?? count }, { transaction: u.tx }));
  });
}

export async function addPermit(sq: Sequelize, ctx: RequestContext, id: string, input: { permitNo: string; authority: string; issuedAt?: string; expiresAt: string }) {
  return withUow(sq, ctx, async (u) => {
    const l = await scopedListing(u, ctx, id);
    authorize(ctx, "listing.manage", ref(l));
    if (await u.repo("ListingPermit").findOne({ where: { authority: input.authority, permitNo: input.permitNo }, transaction: u.tx })) throw new ConflictError("This permit number is already recorded");
    const p = await u.repo("ListingPermit").create({ id: randomUUID(), listingId: id, permitNo: input.permitNo, authority: input.authority, issuedAt: input.issuedAt ?? null, expiresAt: input.expiresAt, status: "pending", source: "manual" }, { transaction: u.tx });
    await u.emit({ type: "listing.permit_added", aggregateType: "listing", aggregateId: id, projectId: l.get("projectId"), payload: { authority: input.authority } });
    return plain(p);
  });
}

/** A permit becomes "valid" only when a compliance verifier confirms it (manual mode until an authorised API integration exists). */
export async function verifyPermit(sq: Sequelize, ctx: RequestContext, permitId: string, outcome: "valid" | "rejected" | "revoked") {
  return withUow(sq, ctx, async (u) => {
    const p: any = await u.repo("ListingPermit").findById(permitId, { transaction: u.tx });
    if (!p) throw new NotFoundError("Permit");
    const l = await scopedListing(u, ctx, p.get("listingId"));
    authorize(ctx, "compliance.verify", ref(l));
    await u.repo("ListingPermit").updateById(permitId, { status: outcome, verifiedAt: new Date(), verifiedBy: ctx.userId }, { transaction: u.tx });
    await u.audit({ action: `permit.${outcome}`, entityType: "listing_permit", entityId: permitId, before: { status: p.get("status") }, after: { status: outcome, permitNo: p.get("permitNo") } });
    await u.emit({ type: "listing.permit_verified", aggregateType: "listing", aggregateId: l.get("id"), projectId: l.get("projectId"), payload: { outcome } });
    return plain(await u.repo("ListingPermit").findById(permitId, { transaction: u.tx }));
  });
}

export async function addBrokerLicence(sq: Sequelize, ctx: RequestContext, input: { holderType: "company" | "agent"; holderName: string; userId?: string; licenceNo: string; authority: string; issuedAt?: string; expiresAt: string }) {
  authorize(ctx, "compliance.verify");
  return withUow(sq, ctx, async (u) => {
    if (input.holderType === "agent" && !input.userId) throw new ConflictError("Agent licences must be linked to a user");
    if (input.userId && !(await u.repo("User").findById(input.userId, { transaction: u.tx }))) throw new NotFoundError("User");
    if (await u.repo("BrokerLicence").findOne({ where: { authority: input.authority, licenceNo: input.licenceNo }, transaction: u.tx })) throw new ConflictError("This licence is already recorded");
    const lic = await u.repo("BrokerLicence").create({ id: randomUUID(), ...input, userId: input.userId ?? null, issuedAt: input.issuedAt ?? null, validationStatus: "unverified" }, { transaction: u.tx });
    await u.audit({ action: "broker_licence.added", entityType: "broker_licence", entityId: (lic as any).get("id"), after: { authority: input.authority, licenceNo: input.licenceNo, holderType: input.holderType } });
    return plain(lic);
  });
}

export async function verifyBrokerLicence(sq: Sequelize, ctx: RequestContext, id: string, outcome: "valid" | "revoked") {
  authorize(ctx, "compliance.verify");
  return withUow(sq, ctx, async (u) => {
    const lic: any = await u.repo("BrokerLicence").findById(id, { transaction: u.tx });
    if (!lic) throw new NotFoundError("Broker licence");
    await u.repo("BrokerLicence").updateById(id, { validationStatus: outcome, verifiedAt: new Date(), verifiedBy: ctx.userId }, { transaction: u.tx });
    await u.audit({ action: `broker_licence.${outcome}`, entityType: "broker_licence", entityId: id, before: { status: lic.get("validationStatus") }, after: { status: outcome } });
    return plain(await u.repo("BrokerLicence").findById(id, { transaction: u.tx }));
  });
}

export async function validateListing(sq: Sequelize, ctx: RequestContext, id: string): Promise<ListingEvaluation> {
  return withUow(sq, ctx, async (u) => evaluateListing(u, await scopedListing(u, ctx, id)));
}

export async function publishListing(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const l = await scopedListing(u, ctx, id);
    authorize(ctx, "listing.publish", ref(l));
    const evaluation = await evaluateListing(u, l);
    if (!evaluation.publishable) throw new ListingNotPublishableError(evaluation); // hard gate, before any adapter runs
    const action = l.get("status") === "published" ? "update" : "publish";
    await u.repo("Listing").updateById(id, { status: "published", publishedAt: l.get("publishedAt") ?? new Date() }, { transaction: u.tx });
    const snapshot = await buildCanonicalListing(u, await u.repo("Listing").findById(id, { transaction: u.tx }));
    const portals = await publishToPortals(u, ctx, l, snapshot, action);
    await u.audit({ action: "listing.published", entityType: "listing", entityId: id, after: { ruleVersion: evaluation.ruleVersion, portals: portals.length } });
    await u.emit({ type: "listing.published", aggregateType: "listing", aggregateId: id, projectId: l.get("projectId"), payload: { action, ruleVersion: evaluation.ruleVersion, portals: portals.map((p) => p.provider) } });
    return { listing: plain(await u.repo("Listing").findById(id, { transaction: u.tx })), evaluation, publications: portals };
  });
}

export async function unpublishListingInUow(u: Uow, ctx: RequestContext, l: any, reason: string) {
  if (l.get("status") !== "published") return [];
  await u.repo("Listing").updateById(l.get("id"), { status: "unpublished" }, { transaction: u.tx });
  const snapshot = await buildCanonicalListing(u, l);
  const portals = await publishToPortals(u, ctx, l, snapshot, "unpublish");
  await u.audit({ action: "listing.unpublished", entityType: "listing", entityId: l.get("id"), reason });
  await u.emit({ type: "listing.unpublished", aggregateType: "listing", aggregateId: l.get("id"), projectId: l.get("projectId"), payload: { reason } });
  return portals;
}

export async function unpublishListing(sq: Sequelize, ctx: RequestContext, id: string, reason = "manual") {
  return withUow(sq, ctx, async (u) => {
    const l = await scopedListing(u, ctx, id);
    authorize(ctx, "listing.publish", ref(l));
    await unpublishListingInUow(u, ctx, l, reason);
    return plain(await u.repo("Listing").findById(id, { transaction: u.tx }));
  });
}

/**
 * Deadlines live in the database, not in queue timers: this sweep (run by a scheduler) unpublishes any published listing
 * whose permit or licence has since expired or been revoked. Returns the affected listing ids.
 */
export async function unpublishNonCompliant(sq: Sequelize, ctx: RequestContext) {
  assertSweepAllowed(ctx, "listing.publish");
  return withUow(sq, ctx, async (u) => {
    const published = await u.repo("Listing").findAll({ where: { status: "published" }, transaction: u.tx });
    const out: Array<{ id: string; issues: ListingIssue[] }> = [];
    for (const l of published as any[]) {
      const ev = await evaluateListing(u, l);
      if (!ev.publishable) {
        await unpublishListingInUow(u, ctx, l, `non-compliant: ${ev.issues.map((i) => i.code).join(",")}`);
        out.push({ id: l.get("id"), issues: ev.issues });
      }
    }
    return out;
  });
}

export async function listListings(sq: Sequelize, ctx: RequestContext, opts: { limit: number; offset: number; status?: string }) {
  return withUow(sq, ctx, async (u) => {
    const and: WhereOptions[] = [await scopeWhere(u, ctx, "listing.read", LISTING_SCOPE)];
    if (opts.status) and.push({ status: opts.status });
    return (await u.repo("Listing").findAll({ where: { [Op.and]: and }, order: [["createdAt", "DESC"]], limit: opts.limit, offset: opts.offset, transaction: u.tx })).map(plain);
  });
}

export async function getListing(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const l = await scopedListing(u, ctx, id);
    const [media, permits, prices, pubs] = await Promise.all([
      u.repo("ListingMedia").findAll({ where: { listingId: id }, order: [["position", "ASC"]], transaction: u.tx }),
      u.repo("ListingPermit").findAll({ where: { listingId: id }, transaction: u.tx }),
      u.repo("ListingPrice").findAll({ where: { listingId: id }, order: [["createdAt", "ASC"]], transaction: u.tx }),
      u.repo("PortalPublication").findAll({ where: { listingId: id }, order: [["createdAt", "DESC"]], limit: 20, attributes: { exclude: ["payload"] }, transaction: u.tx }),
    ]);
    return { ...plain(l), media: media.map(plain), permits: permits.map(plain), priceHistory: prices.map(plain), publications: pubs.map(plain) };
  });
}

void hasPermission; void ForbiddenError;

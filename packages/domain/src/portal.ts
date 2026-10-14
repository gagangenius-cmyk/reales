import { randomUUID } from "node:crypto";
import { Op, Sequelize } from "sequelize";
import { revokeAllSessions } from "@reales/auth";
import { RequestContext } from "@reales/database";
import { authorize, ForbiddenError } from "@reales/rbac";
import { sendInvite } from "./account";
import { createTicketInUow } from "./maintenance";
import { statementPdfFromRow } from "./pdf";
import { fromMinor, toMinor } from "./money";
import { plain } from "./scope";
import { assertQuota, ConflictError, NotFoundError, Uow, withUow } from "./uow";

const nameOf = (c: any) => [c?.get?.("firstName") ?? c?.firstName, c?.get?.("lastName") ?? c?.lastName].filter(Boolean).join(" ") || c?.get?.("companyName") || c?.companyName || "Unnamed";

// ---------------------------------------------------------------- staff side: invite and revoke
export async function invitePortalUser(sq: Sequelize, ctx: RequestContext, i: { contactId: string; kind: "owner" | "tenant"; email?: string; baseUrl: string }) {
  authorize(ctx, "portaluser.manage");
  const userId = await withUow(sq, ctx, async (u) => {
    const contact: any = await u.repo("Contact").findById(i.contactId, { transaction: u.tx });
    if (!contact) throw new NotFoundError("Contact");
    const email = (i.email ?? contact.get("email") ?? "").trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ConflictError("The contact needs a valid email address to receive an invitation");
    // The link must be earned: owners hold at least one portfolio, tenants sit on at least one lease.
    if (i.kind === "owner" && !(await u.repo("Portfolio").count({ where: { ownerContactId: i.contactId }, transaction: u.tx }))) throw new ConflictError("This contact owns no portfolio");
    if (i.kind === "tenant" && !(await u.repo("LeaseParty").count({ where: { contactId: i.contactId, role: "tenant" }, transaction: u.tx }))) throw new ConflictError("This contact is not a tenant on any lease");
    if (await u.repo("PortalLink").findOne({ where: { contactId: i.contactId, kind: i.kind, status: "active" }, transaction: u.tx })) throw new ConflictError("This contact already has portal access");
    if (await u.repo("User").findOne({ where: { normalizedEmail: email.toLowerCase() }, transaction: u.tx })) throw new ConflictError("A user with this email already exists");
    await assertQuota(u, ctx, "users", "users");
    const role: any = await u.repo("Role").findOne({ where: { key: "portal_user" }, transaction: u.tx });
    if (!role) throw new NotFoundError("Role");
    const id = randomUUID();
    await u.repo("User").create({ id, email, normalizedEmail: email.toLowerCase(), passwordHash: null, status: "invited", failedLoginCount: 0 }, { transaction: u.tx });
    await u.repo("UserProfile").create({ userId: id, firstName: contact.get("firstName") ?? null, lastName: contact.get("lastName") ?? null, locale: "en", timezone: "Asia/Dubai" }, { transaction: u.tx });
    await u.repo("UserRole").create({ userId: id, roleId: role.get("id") }, { transaction: u.tx });
    await u.repo("PortalLink").create({ id: randomUUID(), userId: id, contactId: i.contactId, kind: i.kind, status: "active" }, { transaction: u.tx });
    await u.audit({ action: "portal.invited", entityType: "contact", entityId: i.contactId, after: { kind: i.kind } });
    return id;
  });
  // Staff holding portal.manage may not hold user.create; the invitation e-mail itself is the same one-time-link mechanism.
  const sent = await sendInvite(sq, ctx, userId, i.baseUrl);
  return { userId, delivered: sent.delivered };
}

export async function listPortalUsers(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "portaluser.manage");
  return withUow(sq, ctx, async (u) => {
    const links = (await u.repo("PortalLink").findAll({ order: [["createdAt", "DESC"]], limit: 500, transaction: u.tx })) as any[];
    const out = [];
    for (const l of links) {
      const [user, contact]: any[] = await Promise.all([u.repo("User").findById(l.get("userId"), { transaction: u.tx }), u.repo("Contact").findById(l.get("contactId"), { transaction: u.tx })]);
      out.push({ id: l.get("id"), kind: l.get("kind"), status: l.get("status"), contact: nameOf(contact), email: user?.get("email"), userStatus: user?.get("status") });
    }
    return out;
  });
}

export async function revokePortalAccess(sq: Sequelize, ctx: RequestContext, linkId: string) {
  authorize(ctx, "portaluser.manage");
  const userId = await withUow(sq, ctx, async (u) => {
    const l: any = await u.repo("PortalLink").findById(linkId, { transaction: u.tx });
    if (!l) throw new NotFoundError("Portal access");
    await u.repo("PortalLink").updateById(linkId, { status: "revoked" }, { transaction: u.tx });
    await u.repo("User").updateById(l.get("userId"), { status: "disabled" }, { transaction: u.tx });
    await u.audit({ action: "portal.revoked", entityType: "contact", entityId: l.get("contactId") });
    return l.get("userId") as string;
  });
  await revokeAllSessions(sq, ctx.tenantId, userId);
}

// ---------------------------------------------------------------- portal side
async function myLink(u: Uow, ctx: RequestContext, kind?: "owner" | "tenant") {
  const l: any = await u.repo("PortalLink").findOne({ where: { userId: ctx.userId, status: "active", ...(kind ? { kind } : {}) }, transaction: u.tx });
  if (!l) throw new ForbiddenError("This account has no portal access");
  return l;
}

export async function portalMe(sq: Sequelize, ctx: RequestContext) {
  return withUow(sq, ctx, async (u) => {
    const l = await myLink(u, ctx);
    const c = await u.repo("Contact").findById(l.get("contactId"), { transaction: u.tx });
    return { kind: l.get("kind") as "owner" | "tenant", name: nameOf(c) };
  });
}

async function unitLabel(u: Uow, unitId: string) {
  const unit: any = await u.repo("Unit").findById(unitId, { transaction: u.tx });
  const b: any = unit ? await u.repo("Building").findById(unit.get("buildingId"), { transaction: u.tx }) : null;
  return unit ? `Unit ${unit.get("unitNumber")}${b ? `, ${b.get("name")}` : ""}` : "Unit";
}

const leaseView = async (u: Uow, l: any, withTenantName: boolean) => {
  const sched = (await u.repo("RentSchedule").findAll({ where: { leaseId: l.get("id") }, order: [["seq", "ASC"]], transaction: u.tx })) as any[];
  const total = sched.filter((r) => r.get("status") !== "cancelled").reduce((a, r) => a + toMinor(r.get("amount")), 0);
  const paid = sched.reduce((a, r) => a + toMinor(r.get("paidAmount")), 0);
  let tenant: string | undefined;
  if (withTenantName) {
    const p: any = await u.repo("LeaseParty").findOne({ where: { leaseId: l.get("id"), role: "tenant" }, transaction: u.tx });
    tenant = p ? nameOf(await u.repo("Contact").findById(p.get("contactId"), { transaction: u.tx })) : undefined;
  }
  return {
    id: l.get("id"), unit: await unitLabel(u, l.get("unitId")), status: l.get("status"), startsOn: l.get("startsOn"), endsOn: l.get("endsOn"), annualRent: l.get("annualRent"), currency: l.get("currency"),
    outstanding: fromMinor(total - paid), tenant, schedule: sched.map((r) => ({ seq: r.get("seq"), dueDate: r.get("dueDate"), amount: r.get("amount"), paidAmount: r.get("paidAmount"), status: r.get("status") })),
  };
};

const ticketView = (t: any) => ({ id: t.get("id"), title: t.get("title"), category: t.get("category"), priority: t.get("priority"), status: t.get("status"), createdAt: t.get("createdAt"), slaDueAt: t.get("slaDueAt") });

/** Owner view: only portfolios owned by the linked contact; only ISSUED statements (drafts are internal). */
export async function ownerPortal(sq: Sequelize, ctx: RequestContext) {
  return withUow(sq, ctx, async (u) => {
    const link = await myLink(u, ctx, "owner");
    const portfolios = (await u.repo("Portfolio").findAll({ where: { ownerContactId: link.get("contactId") }, transaction: u.tx })) as any[];
    const ids = portfolios.map((p) => p.get("id"));
    if (!ids.length) return { portfolios: [], leases: [], statements: [], tickets: [] };
    const leases = (await u.repo("Lease").findAll({ where: { portfolioId: { [Op.in]: ids }, status: { [Op.in]: ["active", "ended", "terminated"] } }, order: [["startsOn", "DESC"]], limit: 100, transaction: u.tx })) as any[];
    const statements = (await u.repo("OwnerStatement").findAll({ where: { portfolioId: { [Op.in]: ids }, status: "issued" }, order: [["period", "DESC"]], limit: 60, transaction: u.tx })) as any[];
    const tickets = (await u.repo("Ticket").findAll({ where: { portfolioId: { [Op.in]: ids } }, order: [["createdAt", "DESC"]], limit: 50, transaction: u.tx })) as any[];
    return {
      portfolios: portfolios.map((p) => ({ id: p.get("id"), name: p.get("name") })),
      leases: await Promise.all(leases.map((l) => leaseView(u, l, true))),
      statements: statements.map((s) => ({ id: s.get("id"), portfolioId: s.get("portfolioId"), period: s.get("period"), rentCollected: s.get("rentCollected"), managementFee: s.get("managementFee"), maintenanceCost: s.get("maintenanceCost"), netPayable: s.get("netPayable"), currency: s.get("currency") })),
      tickets: tickets.map(ticketView),
    };
  });
}

export async function ownerStatementPdfForPortal(sq: Sequelize, ctx: RequestContext, statementId: string) {
  const { row, org } = await withUow(sq, ctx, async (u) => {
    const link = await myLink(u, ctx, "owner");
    const s: any = await u.repo("OwnerStatement").findOne({ where: { id: statementId, status: "issued" }, transaction: u.tx });
    const p: any = s ? await u.repo("Portfolio").findOne({ where: { id: s.get("portfolioId"), ownerContactId: link.get("contactId") }, transaction: u.tx }) : null;
    if (!s || !p) throw new NotFoundError("Statement");
    const t = (await u.sq.query<any>("SELECT name FROM tenants WHERE id=:t", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: "SELECT" as any })) as any[];
    return { row: { ...plain(s), portfolioName: p.get("name") }, org: t[0]?.name ?? "" };
  });
  return statementPdfFromRow(row, org);
}

/** Tenant view: leases where the linked contact is a tenant party, with the rent schedule and their own maintenance requests. */
export async function tenantPortal(sq: Sequelize, ctx: RequestContext) {
  return withUow(sq, ctx, async (u) => {
    const link = await myLink(u, ctx, "tenant");
    const parties = (await u.repo("LeaseParty").findAll({ where: { contactId: link.get("contactId"), role: "tenant" }, transaction: u.tx })) as any[];
    const leases = parties.length ? ((await u.repo("Lease").findAll({ where: { id: { [Op.in]: parties.map((p) => p.get("leaseId")) }, status: { [Op.in]: ["active", "ended", "terminated"] } }, order: [["startsOn", "DESC"]], transaction: u.tx })) as any[]) : [];
    const tickets = (await u.repo("Ticket").findAll({ where: { reporterContactId: link.get("contactId") }, order: [["createdAt", "DESC"]], limit: 50, transaction: u.tx })) as any[];
    return { leases: await Promise.all(leases.map((l) => leaseView(u, l, false))), tickets: tickets.map(ticketView) };
  });
}

/** A tenant can raise a request only for a unit they currently rent. Priority is set by staff at triage, not by the tenant. */
export async function tenantRequestMaintenance(sq: Sequelize, ctx: RequestContext, i: { leaseId: string; category: string; title: string; description?: string }) {
  return withUow(sq, ctx, async (u) => {
    const link = await myLink(u, ctx, "tenant");
    const party = await u.repo("LeaseParty").findOne({ where: { leaseId: i.leaseId, contactId: link.get("contactId"), role: "tenant" }, transaction: u.tx });
    const lease: any = party ? await u.repo("Lease").findById(i.leaseId, { transaction: u.tx }) : null;
    if (!lease || lease.get("status") !== "active") throw new ConflictError("Requests can be raised for an active lease only");
    const id = await createTicketInUow(u, ctx, { unitId: lease.get("unitId"), category: i.category, title: i.title.slice(0, 255), description: i.description?.slice(0, 4000), reporterContactId: link.get("contactId") });
    return ticketView(await u.repo("Ticket").findById(id, { transaction: u.tx }));
  });
}

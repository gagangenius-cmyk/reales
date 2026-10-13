import { randomUUID } from "node:crypto";
import { Op, Sequelize, WhereOptions, literal } from "sequelize";
import type { RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { normalizeEmail, normalizePhone } from "./normalize";
import { plain, scopeWhere, ScopeColumns } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow, assertQuota } from "./uow";

export class DuplicateContactError extends ConflictError {
  constructor(public matchCount: number, public visibleMatches: Array<{ id: string; name: string }>) {
    super("A contact with the same email or phone already exists");
    this.name = "DuplicateContactError";
  }
}

export interface ContactInput {
  type?: "person" | "company";
  firstName?: string; lastName?: string; companyName?: string;
  email?: string; phone?: string; language?: string; nationality?: string;
  organizationId?: string; branchId?: string; ownerUserId?: string;
  allowDuplicate?: boolean;
}

export const CONTACT_SCOPE: ScopeColumns = {
  owner: "ownerUserId",
  branch: "branchId",
  // Agents can also read contacts of leads assigned to them (they cannot work a lead without seeing its contact).
  alsoOwnedVia: (ctx) => `id IN (SELECT contact_id FROM leads WHERE tenant_id = '${ctx.tenantId.replace(/[^a-f0-9-]/gi, "")}' AND assigned_user_id = '${ctx.userId.replace(/[^a-f0-9-]/gi, "")}')`,
};

const displayName = (c: any) => [c.get("firstName"), c.get("lastName")].filter(Boolean).join(" ") || c.get("companyName") || c.get("email") || c.get("phoneE164") || "Unnamed";

/** Contacts in this tenant sharing the (normalised) email or phone. */
export async function findDuplicateContacts(u: Uow, ctx: Pick<RequestContext, "tenantId">, email: string | null, phone: string | null, excludeId?: string) {
  const or: WhereOptions[] = [];
  if (email) or.push({ normalizedEmail: email });
  if (phone) or.push({ phoneE164: phone });
  if (!or.length) return [];
  const where: WhereOptions = excludeId ? { [Op.and]: [{ [Op.or]: or }, { id: { [Op.ne]: excludeId } }] } : { [Op.or]: or };
  return u.repo("Contact").findAll({ where, transaction: u.tx });
}

export async function createContactInUow(u: Uow, ctx: RequestContext, input: ContactInput) {
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  if (input.email && !email) throw new ConflictError("Invalid email address");
  if (input.phone && !phone) throw new ConflictError("Invalid phone number");
  if (!email && !phone && !input.firstName && !input.lastName && !input.companyName) throw new ConflictError("A contact needs a name, email or phone");
  await assertQuota(u, ctx, "contacts", "contacts");

  const dups = await findDuplicateContacts(u, ctx, email, phone);
  if (dups.length && !input.allowDuplicate) {
    // Never reveal contacts outside the caller's visibility: report the count, list only what they may read.
    const scope = await scopeWhere(u, ctx, "contact.read", CONTACT_SCOPE).catch(() => null);
    const visible = scope
      ? await u.repo("Contact").findAll({ where: { [Op.and]: [{ id: { [Op.in]: dups.map((d: any) => d.get("id")) } }, scope] }, transaction: u.tx })
      : [];
    throw new DuplicateContactError(dups.length, visible.map((c: any) => ({ id: c.get("id"), name: displayName(c) })));
  }
  const id = randomUUID();
  const c = await u.repo("Contact").create({
    id, type: input.type ?? (input.companyName && !input.firstName ? "company" : "person"),
    firstName: input.firstName ?? null, lastName: input.lastName ?? null, companyName: input.companyName ?? null,
    email: input.email?.trim() ?? null, normalizedEmail: email, phoneE164: phone,
    language: input.language ?? null, nationality: input.nationality ?? null, organizationId: input.organizationId ?? null,
    ownerUserId: input.ownerUserId ?? (ctx.userId === "system" ? null : ctx.userId),
    branchId: input.branchId ?? ctx.membership.branchIds[0] ?? null, status: "active",
  }, { transaction: u.tx });
  await u.emit({ type: "contact.created", aggregateType: "contact", aggregateId: id, payload: { type: (c as any).get("type") } });
  return c;
}

export async function createContact(sq: Sequelize, ctx: RequestContext, input: ContactInput) {
  authorize(ctx, "contact.create");
  return withUow(sq, ctx, async (u) => plain(await createContactInUow(u, ctx, input)));
}

export async function getContact(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const scope = await scopeWhere(u, ctx, "contact.read", CONTACT_SCOPE);
    const c = await u.repo("Contact").findOne({ where: { [Op.and]: [{ id }, scope] }, transaction: u.tx });
    if (!c) throw new NotFoundError("Contact");
    return plain(c);
  });
}

export async function listContacts(sq: Sequelize, ctx: RequestContext, opts: { limit: number; offset: number; q?: string }) {
  return withUow(sq, ctx, async (u) => {
    const scope = await scopeWhere(u, ctx, "contact.read", CONTACT_SCOPE);
    const and: WhereOptions[] = [scope];
    if (opts.q) {
      const like = `%${opts.q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
      and.push({ [Op.or]: [{ firstName: { [Op.like]: like } }, { lastName: { [Op.like]: like } }, { companyName: { [Op.like]: like } }, { normalizedEmail: { [Op.like]: like.toLowerCase() } }, { phoneE164: { [Op.like]: like } }] });
    }
    const rows = await u.repo("Contact").findAll({ where: { [Op.and]: and }, order: [["createdAt", "DESC"]], limit: opts.limit, offset: opts.offset, transaction: u.tx });
    return rows.map(plain);
  });
}

export async function updateContact(sq: Sequelize, ctx: RequestContext, id: string, input: Partial<Omit<ContactInput, "allowDuplicate">>) {
  return withUow(sq, ctx, async (u) => {
    const scope = await scopeWhere(u, ctx, "contact.read", CONTACT_SCOPE);
    const c: any = await u.repo("Contact").findOne({ where: { [Op.and]: [{ id }, scope] }, transaction: u.tx });
    if (!c) throw new NotFoundError("Contact");
    authorize(ctx, "contact.update", { ownerUserId: c.get("ownerUserId"), branchId: c.get("branchId") });
    const patch: Record<string, unknown> = {};
    for (const k of ["firstName", "lastName", "companyName", "language", "nationality", "organizationId"] as const) if (input[k] !== undefined) patch[k] = input[k];
    if (input.email !== undefined) {
      const e = normalizeEmail(input.email);
      if (input.email && !e) throw new ConflictError("Invalid email address");
      patch.email = input.email || null; patch.normalizedEmail = e;
    }
    if (input.phone !== undefined) {
      const p = normalizePhone(input.phone);
      if (input.phone && !p) throw new ConflictError("Invalid phone number");
      patch.phoneE164 = p;
    }
    if (patch.normalizedEmail || patch.phoneE164) {
      const dups = await findDuplicateContacts(u, ctx, (patch.normalizedEmail as string) ?? null, (patch.phoneE164 as string) ?? null, id);
      if (dups.length) throw new DuplicateContactError(dups.length, []);
    }
    if (Object.keys(patch).length) await u.repo("Contact").updateById(id, patch, { transaction: u.tx });
    await u.emit({ type: "contact.updated", aggregateType: "contact", aggregateId: id, payload: { fields: Object.keys(patch) } });
    return plain(await u.repo("Contact").findById(id, { transaction: u.tx }));
  });
}

void literal;

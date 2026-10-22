import { Op, Sequelize, WhereOptions } from "sequelize";
import type { RequestContext } from "@reales/database";
import { hasPermission } from "@reales/rbac";
import { CONTACT_SCOPE } from "./contacts";
import { DEAL_SCOPE } from "./deals";
import { LEAD_SCOPE } from "./leads";
import { LISTING_SCOPE } from "./listings";
import { plain, scopeWhere } from "./scope";
import { withUow } from "./uow";

export interface SearchHit { kind: "contact" | "lead" | "unit" | "listing" | "deal"; id: string; title: string; subtitle: string; href: string }

const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
/** Phone digits without the country code or trunk 0, so 050 123 4567, 0501234567 and +971501234567 all find the same number. */
const digits = (q: string) => q.replace(/[^\d]/g, "").replace(/^(00)?971/, "").replace(/^0/, "");
const name = (c: any) => [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || c.email || c.phoneE164 || "Unnamed";

/**
 * One search box across what the caller may see: contacts (name, company, email, phone), leads (via their contact), units (number, building, community),
 * listings (title) and deals (reference). Every branch goes through the same scope rules as that module's own list screen.
 */
export async function globalSearch(sq: Sequelize, ctx: RequestContext, rawQuery: string, perKind = 5): Promise<SearchHit[]> {
  const q = rawQuery.trim().slice(0, 80);
  if (q.length < 2) return [];
  const lk = like(q);
  const phoneLike = digits(q).length >= 4 ? like(digits(q)) : null;
  return withUow(sq, ctx, async (u) => {
    const hits: SearchHit[] = [];
    let contactIds: string[] = [];

    if (hasPermission(ctx, "contact.read")) {
      const scope = await scopeWhere(u, ctx, "contact.read", CONTACT_SCOPE);
      const or: WhereOptions[] = [{ firstName: { [Op.like]: lk } }, { lastName: { [Op.like]: lk } }, { companyName: { [Op.like]: lk } }, { normalizedEmail: { [Op.like]: lk.toLowerCase() } }];
      if (phoneLike) or.push({ phoneE164: { [Op.like]: phoneLike } }, { phoneSecondary: { [Op.like]: phoneLike } }, { whatsappE164: { [Op.like]: phoneLike } });
      const rows = await u.repo("Contact").findAll({ where: { [Op.and]: [scope, { [Op.or]: or }] }, order: [["updatedAt", "DESC"]], limit: perKind * 3, transaction: u.tx });
      contactIds = (rows as any[]).map((r) => r.get("id"));
      for (const r of (rows as any[]).slice(0, perKind)) hits.push({ kind: "contact", id: r.get("id"), title: name(r), subtitle: [r.get("phoneE164"), r.get("email")].filter(Boolean).join(" · "), href: `/contacts/${r.get("id")}` });
    }

    if (hasPermission(ctx, "lead.read") && contactIds.length) {
      const scope = await scopeWhere(u, ctx, "lead.read", LEAD_SCOPE);
      const leads = await u.repo("Lead").findAll({ where: { [Op.and]: [scope, { contactId: { [Op.in]: contactIds } }] }, order: [["createdAt", "DESC"]], limit: perKind, transaction: u.tx });
      const contacts = await u.repo("Contact").findAll({ where: { id: { [Op.in]: (leads as any[]).map((l) => l.get("contactId")) } }, transaction: u.tx });
      const byId = new Map((contacts as any[]).map((c) => [c.get("id"), c]));
      for (const l of leads as any[]) hits.push({ kind: "lead", id: l.get("id"), title: `${name(byId.get(l.get("contactId")) ?? {})} - ${l.get("purpose")} lead`, subtitle: `${l.get("status")}${l.get("isHot") ? " · hot" : ""}${l.get("campaign") ? ` · ${l.get("campaign")}` : ""}`, href: `/leads/${l.get("id")}` });
    }

    if (hasPermission(ctx, "inventory.read") || hasPermission(ctx, "inventory.manage")) {
      const buildings = await u.repo("Building").findAll({ where: { [Op.or]: [{ name: { [Op.like]: lk } }, { community: { [Op.like]: lk } }] }, limit: 20, transaction: u.tx });
      const bIds = (buildings as any[]).map((b) => b.get("id"));
      const units = await u.repo("Unit").findAll({ where: { [Op.or]: [{ unitNumber: { [Op.like]: lk } }, ...(bIds.length ? [{ buildingId: { [Op.in]: bIds } }] : [])] }, order: [["updatedAt", "DESC"]], limit: perKind, transaction: u.tx });
      const bMap = new Map((buildings as any[]).map((b) => [b.get("id"), b]));
      const missing = (units as any[]).map((x) => x.get("buildingId")).filter((id) => !bMap.has(id));
      if (missing.length) for (const b of await u.repo("Building").findAll({ where: { id: { [Op.in]: missing } }, transaction: u.tx })) bMap.set((b as any).get("id"), b);
      for (const x of units as any[]) {
        const b: any = bMap.get(x.get("buildingId"));
        hits.push({ kind: "unit", id: x.get("id"), title: `Unit ${x.get("unitNumber")}${b ? ` - ${b.get("name")}` : ""}`, subtitle: `${x.get("status")} · ${x.get("bedrooms") ?? "?"} bed ${x.get("type")}${b?.get("community") ? ` · ${b.get("community")}` : ""}`, href: `/inventory?q=${encodeURIComponent(String(x.get("unitNumber")))}` });
      }
    }

    if (hasPermission(ctx, "listing.read")) {
      const scope = await scopeWhere(u, ctx, "listing.read", LISTING_SCOPE);
      const rows = await u.repo("Listing").findAll({ where: { [Op.and]: [scope, { title: { [Op.like]: lk } }] }, order: [["updatedAt", "DESC"]], limit: perKind, transaction: u.tx });
      for (const l of rows as any[]) hits.push({ kind: "listing", id: l.get("id"), title: l.get("title") ?? "(untitled listing)", subtitle: `${l.get("purpose")} · ${l.get("status")}`, href: `/listings?q=${encodeURIComponent(String(l.get("title") ?? ""))}` });
    }

    if (hasPermission(ctx, "deal.read") && /^[0-9a-f-]{6,36}$/i.test(q)) {
      const scope = await scopeWhere(u, ctx, "deal.read", DEAL_SCOPE);
      const rows = await u.repo("Deal").findAll({ where: { [Op.and]: [scope, { id: { [Op.like]: `${q.toLowerCase()}%` } }] }, limit: perKind, transaction: u.tx });
      for (const d of rows as any[]) hits.push({ kind: "deal", id: d.get("id"), title: `Deal ${String(d.get("id")).slice(0, 8)}`, subtitle: `${d.get("dealType")} · ${d.get("stage")} · ${d.get("currency")} ${Number(d.get("amount")).toLocaleString("en-US")}`, href: `/deals/${d.get("id")}` });
    }
    return hits;
  });
}

void plain;

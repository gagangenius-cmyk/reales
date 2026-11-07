import { randomUUID } from "node:crypto";
import { Op, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { ForbiddenError, hasPermission } from "@reales/rbac";
import { plain } from "./scope";
import { ConflictError, NotFoundError, withUow } from "./uow";

export const VIEW_ENTITIES = { leads: "lead.read", listings: "listing.read", contacts: "contact.read", deals: "deal.read" } as const;
export type ViewEntity = keyof typeof VIEW_ENTITIES;

const KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
/** Keys that only mean "which page / which tab", never part of what a view filters by. */
const EPHEMERAL = new Set(["page", "limit", "offset"]);

const mustRead = (ctx: RequestContext, e: ViewEntity) => {
  const p = VIEW_ENTITIES[e];
  if (!p) throw new ConflictError("Unknown list");
  if (!hasPermission(ctx, p)) throw new ForbiddenError(`Missing permission: ${p}`);
};

/** A saved view stores the list page's query-string filters, the chosen columns and the sort. It never stores data, so record scope still applies when it is opened. */
export function cleanFilters(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (EPHEMERAL.has(k)) continue;
    if (!KEY.test(k) || typeof v !== "string") throw new ConflictError(`Invalid filter: ${k.slice(0, 40)}`);
    if (v.length > 200) throw new ConflictError(`Filter value too long: ${k}`);
    out[k] = v;
  }
  if (Object.keys(out).length > 40) throw new ConflictError("Too many filters");
  return out;
}

export interface ViewInput { id?: string; entity: ViewEntity; name: string; filters: Record<string, string>; columns?: string[] | null; shared?: boolean; isDefault?: boolean }

export async function saveView(sq: Sequelize, ctx: RequestContext, i: ViewInput) {
  mustRead(ctx, i.entity);
  const name = i.name.trim();
  if (!name) throw new ConflictError("Give the view a name");
  const filters = cleanFilters(i.filters);
  const columns = i.columns ? [...new Set(i.columns.map((c) => c.trim()).filter(Boolean))].slice(0, 40).map((c) => c.slice(0, 60)) : null;
  const sort = filters.sort ?? null;
  return withUow(sq, ctx, async (u) => {
    let id = i.id;
    if (id) {
      const cur: any = await u.repo("SavedView").findById(id, { transaction: u.tx });
      if (!cur || cur.get("userId") !== ctx.userId) throw new NotFoundError("View"); // only the owner edits; others cannot learn it exists
      if (cur.get("entity") !== i.entity) throw new ConflictError("A view cannot move to another list");
    } else {
      if ((await u.repo("SavedView").count({ where: { userId: ctx.userId, entity: i.entity }, transaction: u.tx })) >= 30) throw new ConflictError("At most 30 saved views per list");
      id = randomUUID();
    }
    const dup: any = await u.repo("SavedView").findOne({ where: { userId: ctx.userId, entity: i.entity, name, id: { [Op.ne]: id } }, transaction: u.tx });
    if (dup) throw new ConflictError("You already have a view with that name");
    if (i.isDefault) await u.repo("SavedView").updateWhere({ userId: ctx.userId, entity: i.entity }, { isDefault: false }, { transaction: u.tx });
    const values = { entity: i.entity, name: name.slice(0, 80), filters, columns, sort: sort?.slice(0, 40) ?? null, shared: !!i.shared, isDefault: !!i.isDefault };
    if (i.id) await u.repo("SavedView").updateById(id, values, { transaction: u.tx });
    else await u.repo("SavedView").create({ id, userId: ctx.userId, ...values }, { transaction: u.tx });
    return plain(await u.repo("SavedView").findById(id, { transaction: u.tx }));
  });
}

export async function deleteView(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const cur: any = await u.repo("SavedView").findById(id, { transaction: u.tx });
    if (!cur || cur.get("userId") !== ctx.userId) throw new NotFoundError("View");
    await u.repo("SavedView").deleteById(id, { transaction: u.tx });
  });
}

/** Your own views plus views colleagues shared. The owner's email is shown on shared ones. */
export async function listViews(sq: Sequelize, ctx: RequestContext, entity: ViewEntity) {
  mustRead(ctx, entity);
  return withUow(sq, ctx, async (u) => {
    const rows = (await u.repo("SavedView").findAll({ where: { entity, [Op.or]: [{ userId: ctx.userId }, { shared: true }] }, order: [["name", "ASC"]], limit: 200, transaction: u.tx })) as any[];
    const owners = (await u.repo("User").findAll({ where: { id: { [Op.in]: [...new Set(rows.map((r) => r.get("userId")))].concat(["-"]) } }, attributes: ["id", "email"], transaction: u.tx })) as any[];
    const email = new Map(owners.map((o) => [o.get("id"), o.get("email") as string]));
    return rows.map((r) => ({ ...plain(r), mine: r.get("userId") === ctx.userId, owner: r.get("userId") === ctx.userId ? undefined : email.get(r.get("userId")) }));
  });
}

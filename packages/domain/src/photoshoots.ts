import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize, WhereOptions } from "sequelize";
import { mysqlDate, type RequestContext } from "@reales/database";
import { ForbiddenError, hasPermission } from "@reales/rbac";
import { LISTING_SCOPE } from "./listings";
import { notifyInUow } from "./notifications";
import { plain, scopeWhere } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

export const SHOOT_TYPES = ["photos", "video", "drone", "floorplan", "virtual_tour"] as const;
export type ShootType = (typeof SHOOT_TYPES)[number];
export type ShootStatus = "requested" | "scheduled" | "in_progress" | "delivered" | "cancelled";

const canManage = (ctx: RequestContext) => hasPermission(ctx, "photoshoot.manage");
const mustManage = (ctx: RequestContext) => { if (!canManage(ctx)) throw new ForbiddenError("Missing permission: photoshoot.manage"); };

/** The listing must be one the caller may read (record scope), otherwise it does not exist for them. */
async function visibleListing(u: Uow, ctx: RequestContext, listingId: string) {
  const scope = await scopeWhere(u, ctx, "listing.read", LISTING_SCOPE);
  const l: any = await u.repo("Listing").findOne({ where: { [Op.and]: [{ id: listingId }, scope] }, transaction: u.tx });
  if (!l) throw new NotFoundError("Listing");
  return l;
}

async function load(u: Uow, ctx: RequestContext, id: string) {
  const r: any = await u.repo("PhotoshootRequest").findById(id, { transaction: u.tx });
  if (!r) throw new NotFoundError("Photoshoot");
  // Same visibility rule as reading it: the requester, or a manager who can see the listing.
  if (r.get("requestedBy") !== ctx.userId && r.get("photographerUserId") !== ctx.userId) {
    if (!canManage(ctx)) throw new NotFoundError("Photoshoot");
    await visibleListing(u, ctx, r.get("listingId"));
  }
  return r;
}

async function managers(u: Uow, tenantId: string): Promise<string[]> {
  const rows = await u.sq.query<{ user_id: string }>(
    "SELECT DISTINCT ur.user_id FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id AND rp.tenant_id=ur.tenant_id JOIN permissions p ON p.id=rp.permission_id JOIN users x ON x.id=ur.user_id AND x.tenant_id=ur.tenant_id WHERE ur.tenant_id=:t AND p.`key`='photoshoot.manage' AND x.status='active'",
    { replacements: { t: tenantId }, transaction: u.tx, type: QueryTypes.SELECT },
  );
  return rows.map((r) => r.user_id);
}

export interface RequestShootInput { listingId: string; shootTypes: ShootType[]; preferredDate?: string | null; accessContactName?: string | null; accessContactPhone?: string | null; accessNotes?: string | null; notes?: string | null }

export async function requestPhotoshoot(sq: Sequelize, ctx: RequestContext, i: RequestShootInput) {
  if (!hasPermission(ctx, "photoshoot.request")) throw new ForbiddenError("Missing permission: photoshoot.request");
  const types = [...new Set(i.shootTypes)].filter((t) => (SHOOT_TYPES as readonly string[]).includes(t));
  if (!types.length) throw new ConflictError("Choose what should be shot");
  if (i.preferredDate && i.preferredDate < new Date().toISOString().slice(0, 10)) throw new ConflictError("The preferred date is in the past");
  return withUow(sq, ctx, async (u) => {
    const listing = await visibleListing(u, ctx, i.listingId);
    const open = await u.repo("PhotoshootRequest").count({ where: { listingId: i.listingId, status: { [Op.in]: ["requested", "scheduled", "in_progress"] } }, transaction: u.tx });
    if (open) throw new ConflictError("This listing already has an open photoshoot request");
    const id = randomUUID();
    await u.repo("PhotoshootRequest").create({
      id, listingId: i.listingId, requestedBy: ctx.userId, status: "requested", shootTypes: types, preferredDate: i.preferredDate ?? null,
      accessContactName: i.accessContactName?.trim() || null, accessContactPhone: i.accessContactPhone?.trim() || null, accessNotes: i.accessNotes?.trim() || null, notes: i.notes?.trim() || null, durationMinutes: 120,
    }, { transaction: u.tx });
    for (const m of await managers(u, ctx.tenantId)) if (m !== ctx.userId) await notifyInUow(u, { userId: m, kind: "photoshoot.requested", title: "Photoshoot requested", body: String(listing.get("title") ?? "A listing"), entityType: "photoshoot", entityId: id, dedupeKey: `shoot-req:${id}:${m}` });
    await u.audit({ action: "photoshoot.requested", entityType: "photoshoot", entityId: id, after: { listingId: i.listingId, types } });
    await u.emit({ type: "photoshoot.requested", aggregateType: "photoshoot", aggregateId: id, payload: { listingId: i.listingId, shootTypes: types } });
    return plain(await u.repo("PhotoshootRequest").findById(id, { transaction: u.tx }));
  });
}

export interface ScheduleInput { scheduledAt: string; durationMinutes?: number; photographerUserId?: string | null; photographerName?: string | null }

/** Assign a time and a photographer. A photographer (a user) cannot be booked for two overlapping shoots. */
export async function schedulePhotoshoot(sq: Sequelize, ctx: RequestContext, id: string, i: ScheduleInput) {
  mustManage(ctx);
  const at = new Date(i.scheduledAt);
  if (Number.isNaN(at.getTime())) throw new ConflictError("Invalid date and time");
  if (at.getTime() < Date.now() - 5 * 60_000) throw new ConflictError("The shoot cannot be scheduled in the past");
  const minutes = Math.min(Math.max(Math.trunc(i.durationMinutes ?? 120), 15), 480);
  if (!i.photographerUserId && !i.photographerName?.trim()) throw new ConflictError("Name the photographer");
  return withUow(sq, ctx, async (u) => {
    // Serialise bookings for one photographer so two coordinators cannot both take the same slot.
    if (i.photographerUserId) {
      const ph: any = await u.repo("User").findById(i.photographerUserId, { transaction: u.tx });
      if (!ph || ph.get("status") !== "active") throw new NotFoundError("Photographer");
      await u.sq.query("SELECT id FROM users WHERE id=:p AND tenant_id=:t FOR UPDATE", { replacements: { p: i.photographerUserId, t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT });
    }
    const r = await load(u, ctx, id);
    if (!["requested", "scheduled"].includes(r.get("status"))) throw new ConflictError(`A ${r.get("status")} photoshoot cannot be scheduled`);
    if (i.photographerUserId) {
      const end = new Date(at.getTime() + minutes * 60_000);
      const clash = await u.sq.query<{ id: string }>(
        "SELECT id FROM photoshoot_requests WHERE tenant_id=:t AND id<>:id AND photographer_user_id=:p AND status IN ('scheduled','in_progress') AND scheduled_at < :end AND DATE_ADD(scheduled_at, INTERVAL duration_minutes MINUTE) > :start LIMIT 1",
        { replacements: { t: ctx.tenantId, id, p: i.photographerUserId, start: mysqlDate(at), end: mysqlDate(end) }, transaction: u.tx, type: QueryTypes.SELECT },
      );
      if (clash.length) throw new ConflictError("That photographer is already booked at that time");
    }
    const was = r.get("status");
    await u.repo("PhotoshootRequest").updateById(id, { status: "scheduled", scheduledAt: mysqlDate(at), durationMinutes: minutes, photographerUserId: i.photographerUserId ?? null, photographerName: i.photographerName?.trim() || null }, { transaction: u.tx });
    const note = { userId: r.get("requestedBy"), kind: "photoshoot.scheduled", title: was === "scheduled" ? "Photoshoot rescheduled" : "Photoshoot scheduled", body: at.toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" }), entityType: "photoshoot", entityId: id, dedupeKey: `shoot-sched:${id}:${at.getTime()}` };
    await notifyInUow(u, note);
    if (i.photographerUserId && i.photographerUserId !== r.get("requestedBy")) await notifyInUow(u, { ...note, userId: i.photographerUserId, title: "You are booked for a photoshoot", dedupeKey: `shoot-sched-ph:${id}:${at.getTime()}` });
    await u.audit({ action: "photoshoot.scheduled", entityType: "photoshoot", entityId: id, after: { at: at.toISOString(), minutes, photographerUserId: i.photographerUserId ?? null } });
    await u.emit({ type: "photoshoot.scheduled", aggregateType: "photoshoot", aggregateId: id, payload: { listingId: r.get("listingId"), scheduledAt: at.toISOString() } });
    return plain(await u.repo("PhotoshootRequest").findById(id, { transaction: u.tx }));
  });
}

/** The assigned photographer or a manager. */
async function actor(u: Uow, ctx: RequestContext, r: any) {
  if (canManage(ctx) || r.get("photographerUserId") === ctx.userId) return;
  throw new ForbiddenError("Only the photographer or a photoshoot manager can do this");
}

export async function startPhotoshoot(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const r = await load(u, ctx, id);
    await actor(u, ctx, r);
    if (r.get("status") !== "scheduled") throw new ConflictError("Only a scheduled photoshoot can be started");
    await u.repo("PhotoshootRequest").updateById(id, { status: "in_progress", startedAt: new Date() }, { transaction: u.tx });
    await u.audit({ action: "photoshoot.started", entityType: "photoshoot", entityId: id });
    return plain(await u.repo("PhotoshootRequest").findById(id, { transaction: u.tx }));
  });
}

/** Deliver: the media itself is added to the listing through the normal media flow; this records how many items arrived and tells the requester. */
export async function deliverPhotoshoot(sq: Sequelize, ctx: RequestContext, id: string, i: { mediaCount: number; note?: string | null }) {
  if (!Number.isInteger(i.mediaCount) || i.mediaCount < 1 || i.mediaCount > 500) throw new ConflictError("Say how many files were delivered (1 to 500)");
  return withUow(sq, ctx, async (u) => {
    const r = await load(u, ctx, id);
    await actor(u, ctx, r);
    if (r.get("status") !== "in_progress") throw new ConflictError("Start the photoshoot before delivering it");
    await u.repo("PhotoshootRequest").updateById(id, { status: "delivered", deliveredAt: new Date(), deliveredBy: ctx.userId, mediaCount: i.mediaCount, deliveredNote: i.note?.trim() || null }, { transaction: u.tx });
    await notifyInUow(u, { userId: r.get("requestedBy"), kind: "photoshoot.delivered", title: "Your photoshoot is ready", body: `${i.mediaCount} file(s) delivered`, entityType: "photoshoot", entityId: id, dedupeKey: `shoot-done:${id}` });
    await u.audit({ action: "photoshoot.delivered", entityType: "photoshoot", entityId: id, after: { mediaCount: i.mediaCount } });
    await u.emit({ type: "photoshoot.delivered", aggregateType: "photoshoot", aggregateId: id, payload: { listingId: r.get("listingId"), mediaCount: i.mediaCount } });
    return plain(await u.repo("PhotoshootRequest").findById(id, { transaction: u.tx }));
  });
}

/** The requester can cancel until the shoot starts; a manager can cancel any time before delivery. A reason is always kept. */
export async function cancelPhotoshoot(sq: Sequelize, ctx: RequestContext, id: string, reason: string) {
  if (!reason.trim()) throw new ConflictError("A reason is required");
  return withUow(sq, ctx, async (u) => {
    const r = await load(u, ctx, id);
    const st = r.get("status");
    if (["delivered", "cancelled"].includes(st)) throw new ConflictError(`A ${st} photoshoot cannot be cancelled`);
    const mine = r.get("requestedBy") === ctx.userId;
    if (!canManage(ctx) && !(mine && ["requested", "scheduled"].includes(st))) throw new ForbiddenError("You cannot cancel this photoshoot");
    await u.repo("PhotoshootRequest").updateById(id, { status: "cancelled", cancelledBy: ctx.userId, cancelReason: reason.trim().slice(0, 255) }, { transaction: u.tx });
    for (const to of new Set([r.get("requestedBy"), r.get("photographerUserId")].filter((x): x is string => !!x && x !== ctx.userId))) await notifyInUow(u, { userId: to, kind: "photoshoot.cancelled", title: "Photoshoot cancelled", body: reason.trim().slice(0, 200), entityType: "photoshoot", entityId: id, dedupeKey: `shoot-cancel:${id}:${to}` });
    await u.audit({ action: "photoshoot.cancelled", entityType: "photoshoot", entityId: id, reason });
    return plain(await u.repo("PhotoshootRequest").findById(id, { transaction: u.tx }));
  });
}

export async function listPhotoshoots(sq: Sequelize, ctx: RequestContext, f: { status?: ShootStatus; listingId?: string; mine?: boolean; limit?: number } = {}) {
  if (!hasPermission(ctx, "photoshoot.request") && !canManage(ctx)) throw new ForbiddenError("Missing permission: photoshoot.request");
  return withUow(sq, ctx, async (u) => {
    const ownOrAssigned: WhereOptions = { [Op.or]: [{ requestedBy: ctx.userId }, { photographerUserId: ctx.userId }] };
    const and: WhereOptions[] = [f.status ? { status: f.status } : {}, f.listingId ? { listingId: f.listingId } : {}];
    if (!canManage(ctx) || f.mine) and.push(ownOrAssigned);
    else {
      const scope = await scopeWhere(u, ctx, "listing.read", LISTING_SCOPE);
      const ids = (await u.repo("Listing").findAll({ where: scope, attributes: ["id"], transaction: u.tx })) as any[];
      and.push({ [Op.or]: [{ requestedBy: ctx.userId }, { photographerUserId: ctx.userId }, { listingId: { [Op.in]: ids.map((x) => x.get("id")).concat(["-"]) } }] });
    }
    const rows = (await u.repo("PhotoshootRequest").findAll({ where: { [Op.and]: and }, order: [["createdAt", "DESC"]], limit: Math.min(f.limit ?? 100, 300), transaction: u.tx })) as any[];
    const [listings, users] = await Promise.all([
      u.repo("Listing").findAll({ where: { id: { [Op.in]: [...new Set(rows.map((r) => r.get("listingId")))].concat(["-"]) } }, attributes: ["id", "title"], transaction: u.tx }),
      u.repo("User").findAll({ where: { id: { [Op.in]: rows.flatMap((r) => [r.get("requestedBy"), r.get("photographerUserId")]).filter(Boolean).concat(["-"]) } }, attributes: ["id", "email"], transaction: u.tx }),
    ]);
    const title = new Map((listings as any[]).map((l) => [l.get("id"), l.get("title") as string]));
    const email = new Map((users as any[]).map((x) => [x.get("id"), x.get("email") as string]));
    return rows.map((r) => ({ ...plain(r), listingTitle: title.get(r.get("listingId")) ?? "Listing", requestedByEmail: email.get(r.get("requestedBy")) ?? null, photographerEmail: r.get("photographerUserId") ? email.get(r.get("photographerUserId")) ?? null : null }));
  });
}

import { randomUUID } from "node:crypto";
import { Op, Sequelize } from "sequelize";
import { mysqlDate, RequestContext } from "@reales/database";
import { plain } from "./scope";
import { NotFoundError, Uow, withUow } from "./uow";

export interface NotificationInput { userId: string; kind: string; title: string; body?: string; entityType?: string; entityId?: string; dedupeKey?: string }

/** Inside a unit of work. A repeated dedupe key for the same user is silently ignored, so sweeps can re-run without spamming. Returns true when created. */
export async function notifyInUow(u: Uow, i: NotificationInput): Promise<boolean> {
  try {
    await u.repo("Notification").create({
      id: randomUUID(), userId: i.userId, kind: i.kind, title: i.title.slice(0, 200), body: i.body?.slice(0, 500) ?? null, entityType: i.entityType ?? null, entityId: i.entityId ?? null,
      dedupeKey: i.dedupeKey ?? null, createdAt: mysqlDate(new Date()),
    }, { transaction: u.tx });
    return true;
  } catch (e: any) {
    if (e?.original?.code === "ER_DUP_ENTRY" || e?.parent?.code === "ER_DUP_ENTRY") return false;
    throw e;
  }
}

/** A user only ever sees their own notifications; no permission is needed beyond being signed in. */
export async function listMyNotifications(sq: Sequelize, ctx: RequestContext, f: { unreadOnly?: boolean; limit?: number } = {}) {
  return withUow(sq, ctx, async (u) => (await u.repo("Notification").findAll({
    where: { userId: ctx.userId, ...(f.unreadOnly ? { readAt: null } : {}) }, order: [["createdAt", "DESC"]], limit: Math.min(f.limit ?? 50, 200), transaction: u.tx,
  })).map(plain));
}

export async function countMyUnread(sq: Sequelize, ctx: RequestContext): Promise<number> {
  return withUow(sq, ctx, async (u) => u.repo("Notification").count({ where: { userId: ctx.userId, readAt: null }, transaction: u.tx }));
}

export async function markNotificationRead(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const n: any = await u.repo("Notification").findOne({ where: { id, userId: ctx.userId }, transaction: u.tx });
    if (!n) throw new NotFoundError("Notification");
    if (!n.get("readAt")) await u.repo("Notification").updateById(id, { readAt: new Date() }, { transaction: u.tx });
    return plain(await u.repo("Notification").findById(id, { transaction: u.tx }));
  });
}

export async function markAllRead(sq: Sequelize, ctx: RequestContext): Promise<number> {
  return withUow(sq, ctx, async (u) => {
    const unread = (await u.repo("Notification").findAll({ where: { userId: ctx.userId, readAt: null, id: { [Op.ne]: "" } }, attributes: ["id"], transaction: u.tx })) as any[];
    for (const n of unread) await u.repo("Notification").updateById(n.get("id"), { readAt: new Date() }, { transaction: u.tx });
    return unread.length;
  });
}

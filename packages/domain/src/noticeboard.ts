import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize, WhereOptions } from "sequelize";
import type { RequestContext } from "@reales/database";
import { ForbiddenError, hasPermission, widestScope } from "@reales/rbac";
import { notifyInUow } from "./notifications";
import { plain } from "./scope";
import { ConflictError, NotFoundError, withUow } from "./uow";

const mustManage = (ctx: RequestContext) => { if (!hasPermission(ctx, "notice.manage")) throw new ForbiddenError("Missing permission: notice.manage"); };
const companyWide = (ctx: RequestContext) => widestScope(ctx, "notice.manage") === "tenant";
/** Managers with a narrower scope may only touch notices they posted themselves. */
const ownOnly = (ctx: RequestContext, post: any) => { if (!companyWide(ctx) && post.get("createdBy") !== ctx.userId) throw new ForbiddenError("You can only manage notices you posted"); };

export interface NoticeInput { id?: string; title: string; body: string; audience?: "all" | "branch"; branchId?: string | null; pinned?: boolean; requiresAck?: boolean; publishAt?: string; expiresAt?: string | null }

/** Publish or edit a notice. Everyone in the audience is notified once when it goes live (editing never re-notifies). */
export async function saveNotice(sq: Sequelize, ctx: RequestContext, i: NoticeInput) {
  mustManage(ctx);
  if (!companyWide(ctx) && ((i.audience ?? "all") !== "branch" || !i.branchId || !ctx.membership.branchIds.includes(i.branchId))) throw new ForbiddenError("You can only post to your own branch");
  if (!i.title.trim() || !i.body.trim()) throw new ConflictError("A notice needs a title and a message");
  if ((i.audience ?? "all") === "branch" && !i.branchId) throw new ConflictError("Choose the branch this notice is for");
  const publishAt = i.publishAt ? new Date(i.publishAt) : new Date();
  const expiresAt = i.expiresAt ? new Date(i.expiresAt) : null;
  if (Number.isNaN(publishAt.getTime()) || (expiresAt && Number.isNaN(expiresAt.getTime()))) throw new ConflictError("Invalid date");
  if (expiresAt && expiresAt <= publishAt) throw new ConflictError("The notice must expire after it is published");
  return withUow(sq, ctx, async (u) => {
    if (i.branchId && !(await u.repo("Branch").findById(i.branchId, { transaction: u.tx }))) throw new NotFoundError("Branch");
    const values = { title: i.title.trim().slice(0, 200), body: i.body.trim().slice(0, 20000), audience: i.audience ?? "all", branchId: (i.audience ?? "all") === "branch" ? i.branchId ?? null : null, pinned: i.pinned ?? false, requiresAck: i.requiresAck ?? false, publishAt, expiresAt };
    let id = i.id;
    if (id) { const cur: any = await u.repo("NoticePost").findById(id, { transaction: u.tx }); if (!cur) throw new NotFoundError("Notice"); ownOnly(ctx, cur); await u.repo("NoticePost").updateById(id, values, { transaction: u.tx }); }
    else { id = randomUUID(); await u.repo("NoticePost").create({ id, ...values, archived: false, createdBy: ctx.userId }, { transaction: u.tx }); }
    if (publishAt.getTime() <= Date.now() + 60_000) {
      const where: WhereOptions = { status: "active", ...(values.audience === "branch" ? { branchId: values.branchId } : {}) };
      for (const x of (await u.repo("User").findAll({ where, transaction: u.tx })) as any[]) if (x.get("id") !== ctx.userId) await notifyInUow(u, { userId: x.get("id"), kind: "notice.posted", title: values.title, body: values.requiresAck ? "Please read and acknowledge." : undefined, entityType: "notice", entityId: id, dedupeKey: `notice:${id}` });
    }
    await u.audit({ action: i.id ? "notice.updated" : "notice.posted", entityType: "notice", entityId: id, after: { title: values.title, audience: values.audience, requiresAck: values.requiresAck } });
    return plain(await u.repo("NoticePost").findById(id, { transaction: u.tx }));
  });
}

export async function archiveNotice(sq: Sequelize, ctx: RequestContext, id: string, archived = true) {
  mustManage(ctx);
  return withUow(sq, ctx, async (u) => {
    const cur: any = await u.repo("NoticePost").findById(id, { transaction: u.tx });
    if (!cur) throw new NotFoundError("Notice");
    ownOnly(ctx, cur);
    await u.repo("NoticePost").updateById(id, { archived }, { transaction: u.tx });
    await u.audit({ action: archived ? "notice.archived" : "notice.restored", entityType: "notice", entityId: id });
  });
}

/** What this person should see now: live (published, not expired, not archived), for everyone or their branch; pinned first; with their read/acknowledged state. */
export async function listNoticesForMe(sq: Sequelize, ctx: RequestContext) {
  return withUow(sq, ctx, async (u) => {
    const now = new Date();
    const me: any = await u.repo("User").findById(ctx.userId, { transaction: u.tx });
    const mine = me?.get("branchId") ?? null;
    const and: WhereOptions[] = [{ archived: false }, { publishAt: { [Op.lte]: now } }, { [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: now } }] }, { [Op.or]: [{ audience: "all" }, ...(mine ? [{ audience: "branch", branchId: mine }] : [])] }];
    const posts = (await u.repo("NoticePost").findAll({ where: { [Op.and]: and }, order: [["pinned", "DESC"], ["publishAt", "DESC"]], limit: 100, transaction: u.tx })) as any[];
    const reads = posts.length ? ((await u.repo("NoticeRead").findAll({ where: { userId: ctx.userId, postId: { [Op.in]: posts.map((p) => p.get("id")) } }, transaction: u.tx })) as any[]) : [];
    const byPost = new Map(reads.map((r) => [r.get("postId"), r]));
    return posts.map((p) => ({ ...plain(p), read: byPost.has(p.get("id")), acked: !!byPost.get(p.get("id"))?.get("ackedAt") }));
  });
}

export async function countUnreadNotices(sq: Sequelize, ctx: RequestContext): Promise<number> {
  return (await listNoticesForMe(sq, ctx)).filter((n: any) => !n.read || (n.requiresAck && !n.acked)).length;
}

export async function markNotice(sq: Sequelize, ctx: RequestContext, id: string, ack = false) {
  return withUow(sq, ctx, async (u) => {
    const visible = (await listNoticesForMe(sq, ctx)).find((n: any) => n.id === id);
    if (!visible) throw new NotFoundError("Notice");
    if (ack && !visible.requiresAck) throw new ConflictError("This notice does not need an acknowledgement");
    const existing: any = await u.repo("NoticeRead").findOne({ where: { postId: id, userId: ctx.userId }, transaction: u.tx });
    const now = new Date();
    if (existing) { if (ack && !existing.get("ackedAt")) await u.repo("NoticeRead").updateById(existing.get("id"), { ackedAt: now }, { transaction: u.tx }); }
    else await u.repo("NoticeRead").create({ id: randomUUID(), postId: id, userId: ctx.userId, readAt: now, ackedAt: ack ? now : null }, { transaction: u.tx });
    if (ack) await u.audit({ action: "notice.acknowledged", entityType: "notice", entityId: id });
  });
}

/** Who has read and acknowledged each notice (managers). */
export async function noticeReceipts(sq: Sequelize, ctx: RequestContext, id: string) {
  mustManage(ctx);
  return withUow(sq, ctx, async (u) => {
    const post: any = await u.repo("NoticePost").findById(id, { transaction: u.tx });
    if (!post) throw new NotFoundError("Notice");
    ownOnly(ctx, post);
    const audience = (await u.repo("User").findAll({ where: { status: "active", ...(post.get("audience") === "branch" ? { branchId: post.get("branchId") } : {}) }, transaction: u.tx })) as any[];
    const reads = (await u.repo("NoticeRead").findAll({ where: { postId: id }, transaction: u.tx })) as any[];
    const by = new Map(reads.map((r) => [r.get("userId"), r]));
    return { total: audience.length, read: audience.filter((x) => by.has(x.get("id"))).length, acked: audience.filter((x) => by.get(x.get("id"))?.get("ackedAt")).length, requiresAck: !!post.get("requiresAck"),
      pending: audience.filter((x) => (post.get("requiresAck") ? !by.get(x.get("id"))?.get("ackedAt") : !by.has(x.get("id")))).map((x) => x.get("email") as string) };
  });
}

/** For managers: every notice including expired and archived ones. */
export async function listAllNotices(sq: Sequelize, ctx: RequestContext) {
  mustManage(ctx);
  return withUow(sq, ctx, async (u) => (await u.repo("NoticePost").findAll({ where: companyWide(ctx) ? {} : { createdBy: ctx.userId }, order: [["publishAt", "DESC"]], limit: 100, transaction: u.tx })).map(plain));
}

void QueryTypes;

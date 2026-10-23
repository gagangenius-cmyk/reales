import { randomUUID } from "node:crypto";
import { Op, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { authorize, hasPermission } from "@reales/rbac";
import { documentAccess } from "./documents";
import { notifyUser } from "./notify";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";
import { usersWith } from "./hr";

/**
 * Document folders with policies. A folder can be restricted (only people with tenant-wide document access open it), give documents a default expiry,
 * keep them for a retention period (no deletion before it ends), accept only some kinds, and insist that every document is attached to a record.
 * Moving a document into a folder applies the policy to it; the policy is checked again at every read, so tightening a folder takes effect at once.
 */
export const DOC_KINDS = ["contract", "id_document", "permit", "invoice", "receipt", "other"] as const;
const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const tenantWide = (ctx: RequestContext, p: string) => ctx.grants.some((g) => g.permission === p && g.scope === "tenant");

export interface FolderInput { id?: string; name: string; description?: string | null; restricted?: boolean; defaultExpiryDays?: number | null; retentionDays?: number | null; allowedKinds?: string[] | null; requiresLink?: boolean }

export async function listFolders(sq: Sequelize, ctx: RequestContext) {
  return withUow(sq, ctx, async (u) => {
    const rows = (await u.repo("DocumentFolder").findAll({ order: [["name", "ASC"]], transaction: u.tx })) as any[];
    const counts = (await u.repo("Document").findAll({ attributes: ["folderId", [u.sq.fn("COUNT", "*"), "n"]], where: { folderId: { [Op.ne]: null } }, group: ["folderId"], raw: true, transaction: u.tx })) as unknown as { folderId: string; n: number | string }[];
    const n = new Map(counts.map((c) => [c.folderId, Number(c.n)]));
    return rows.filter((f) => !f.get("restricted") || tenantWide(ctx, "document.read") || tenantWide(ctx, "document.manage")).map((f) => ({ ...plain(f), documents: n.get(f.get("id")) ?? 0 }));
  });
}

export async function saveFolder(sq: Sequelize, ctx: RequestContext, i: FolderInput) {
  authorize(ctx, "document.manage"); // creating a policy is a tenant-wide act
  if (!i.name.trim()) throw new ConflictError("Name the folder");
  for (const [k, v] of Object.entries({ defaultExpiryDays: i.defaultExpiryDays, retentionDays: i.retentionDays })) if (v != null && (!Number.isInteger(v) || v < 1 || v > 36500)) throw new ConflictError(`${k === "retentionDays" ? "Retention" : "Default expiry"} must be 1 to 36500 days`);
  if (i.allowedKinds && i.allowedKinds.some((k) => !(DOC_KINDS as readonly string[]).includes(k))) throw new ConflictError("Unknown document kind");
  return withUow(sq, ctx, async (u) => {
    const clash: any = await u.repo("DocumentFolder").findOne({ where: { name: i.name.trim(), ...(i.id ? { id: { [Op.ne]: i.id } } : {}) }, transaction: u.tx });
    if (clash) throw new ConflictError("A folder with that name already exists");
    const vals = { name: i.name.trim().slice(0, 120), description: i.description?.trim().slice(0, 300) || null, restricted: !!i.restricted, defaultExpiryDays: i.defaultExpiryDays ?? null, retentionDays: i.retentionDays ?? null, allowedKinds: i.allowedKinds?.length ? i.allowedKinds : null, requiresLink: !!i.requiresLink };
    const id = i.id ?? randomUUID();
    if (i.id) { if (!(await u.repo("DocumentFolder").updateById(id, vals, { transaction: u.tx }))) throw new NotFoundError("Folder"); }
    else await u.repo("DocumentFolder").create({ id, ...vals, createdBy: ctx.userId }, { transaction: u.tx });
    await u.audit({ action: i.id ? "document.folder_updated" : "document.folder_created", entityType: "document_folder", entityId: id, after: vals });
    return plain(await u.repo("DocumentFolder").findById(id, { transaction: u.tx }));
  });
}

/** Applies a folder's rules to a document inside the caller's transaction. Used on upload and on move. */
export async function applyFolderPolicy(u: Uow, folder: any, doc: any, o: { links: number }) {
  const kinds = folder.get("allowedKinds") as string[] | null;
  if (kinds?.length && !kinds.includes(doc.get("kind"))) throw new ConflictError(`${folder.get("name")} only accepts: ${kinds.join(", ").replace(/_/g, " ")}`);
  if (folder.get("requiresLink") && o.links === 0) throw new ConflictError(`${folder.get("name")} only holds documents attached to a lead, contact, listing or deal`);
  const created = new Date(doc.get("createdAt") ?? Date.now());
  const patch: Record<string, unknown> = { folderId: folder.get("id") };
  if (folder.get("defaultExpiryDays") && !doc.get("expiresOn")) patch.expiresOn = isoDay(new Date(Date.now() + Number(folder.get("defaultExpiryDays")) * DAY));
  patch.retainUntil = folder.get("retentionDays") ? isoDay(new Date(created.getTime() + Number(folder.get("retentionDays")) * DAY)) : null;
  await u.repo("Document").updateById(doc.get("id"), patch, { transaction: u.tx });
}

/** Moves a document into a folder (or out of folders with null) and applies the folder's policy to it. */
export async function moveDocument(sq: Sequelize, ctx: RequestContext, documentId: string, folderId: string | null) {
  return withUow(sq, ctx, async (u) => {
    const doc: any = await u.repo("Document").findById(documentId, { transaction: u.tx });
    if (!doc || !(await documentAccess(u, ctx, doc)).manage) throw new NotFoundError("Document");
    if (doc.get("retainUntil") && String(doc.get("retainUntil")).slice(0, 10) > isoDay(new Date()) && folderId !== doc.get("folderId")) throw new ConflictError(`This document is retained until ${String(doc.get("retainUntil")).slice(0, 10)} and cannot be moved out of its folder before then`);
    if (!folderId) { await u.repo("Document").updateById(documentId, { folderId: null, retainUntil: null }, { transaction: u.tx }); return plain(await u.repo("Document").findById(documentId, { transaction: u.tx })); }
    const folder: any = await u.repo("DocumentFolder").findById(folderId, { transaction: u.tx });
    if (!folder) throw new NotFoundError("Folder");
    if (folder.get("restricted") && !tenantWide(ctx, "document.manage")) throw new ConflictError("Only people with tenant-wide document management can use a restricted folder");
    const links = await u.repo("DocumentLink").count({ where: { documentId }, transaction: u.tx });
    await applyFolderPolicy(u, folder, doc, { links });
    await u.audit({ action: "document.moved", entityType: "document", entityId: documentId, after: { folder: folder.get("name") } });
    return plain(await u.repo("Document").findById(documentId, { transaction: u.tx }));
  });
}

/** Documents the caller may open, newest first, filtered by folder, text or expiry. Restricted folders and unreadable documents are left out. */
export async function listAllDocuments(sq: Sequelize, ctx: RequestContext, f: { folderId?: string; q?: string; expiringWithinDays?: number; limit?: number } = {}) {
  if (!hasPermission(ctx, "document.read") && !hasPermission(ctx, "document.manage")) return [];
  return withUow(sq, ctx, async (u) => {
    const where: any[] = [];
    if (f.folderId) where.push({ folderId: f.folderId });
    if (f.q?.trim()) where.push({ title: { [Op.like]: `%${f.q.trim().replace(/[%_\\]/g, "\\$&")}%` } });
    if (f.expiringWithinDays !== undefined) where.push({ expiresOn: { [Op.ne]: null, [Op.lte]: isoDay(new Date(Date.now() + f.expiringWithinDays * DAY)) } });
    const rows = (await u.repo("Document").findAll({ where: where.length ? { [Op.and]: where } : {}, order: [["createdAt", "DESC"]], limit: 300, transaction: u.tx })) as any[];
    const folders = new Map(((await u.repo("DocumentFolder").findAll({ transaction: u.tx })) as any[]).map((x) => [x.get("id"), x.get("name") as string]));
    const out = [];
    for (const d of rows) if ((await documentAccess(u, ctx, d)).read) out.push({ ...plain(d), folderName: d.get("folderId") ? folders.get(d.get("folderId")) ?? null : null });
    return out.slice(0, f.limit ?? 200);
  });
}

/** Warns the owner and document managers a month before a document expires. One alert per document and expiry date. */
export async function documentExpirySweep(sq: Sequelize, ctx: RequestContext, now = new Date()) {
  return withUow(sq, ctx, async (u) => {
    const limit = isoDay(new Date(now.getTime() + 30 * DAY));
    const rows = (await u.repo("Document").findAll({ where: { expiresOn: { [Op.ne]: null, [Op.lte]: limit } }, limit: 500, transaction: u.tx })) as any[];
    const managers = rows.length ? await usersWith(u, "document.manage") : [];
    let n = 0;
    for (const d of rows) {
      const date = String(d.get("expiresOn")).slice(0, 10), expired = date < isoDay(now);
      for (const uid of new Set([...(d.get("createdBy") ? [d.get("createdBy") as string] : []), ...managers])) {
        if (await notifyUser(u, { userId: uid, kind: "document.expiry", title: `Document "${d.get("title")}" ${expired ? "expired" : "expires"} on ${date}`, entityType: "document", entityId: d.get("id"), dedupeKey: `doc.exp:${d.get("id")}:${date}:${uid}`, path: "/documents" })) n++;
      }
    }
    return n;
  });
}

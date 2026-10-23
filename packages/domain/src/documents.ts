import { randomUUID } from "node:crypto";
import { Op, Sequelize } from "sequelize";
import { mysqlDate, RequestContext } from "@reales/database";
import { authorize, can, ForbiddenError, hasPermission } from "@reales/rbac";
import { CONTACT_SCOPE } from "./contacts";
import { DEAL_SCOPE } from "./deals";
import { LEAD_SCOPE } from "./leads";
import { LISTING_SCOPE } from "./listings";
import { plain, scopeWhere } from "./scope";
import { getStorage, scanUpload, sha256Hex, storageKeyFor, validateUpload } from "./storage";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

export const LINKABLE = ["deal", "lead", "listing", "contact"] as const;
export type LinkableType = (typeof LINKABLE)[number];
export interface EntityRef { entityType: LinkableType; entityId: string }

export class DocumentIntegrityError extends Error {
  status = 500;
  constructor() {
    super("Stored document content no longer matches its recorded hash");
    this.name = "DocumentIntegrityError";
  }
}

const SPEC: Record<LinkableType, { model: "Deal" | "Lead" | "Listing" | "Contact"; readPerm: string; scope: any; managePerm: string; ref: (e: any) => any }> = {
  deal: { model: "Deal", readPerm: "deal.read", scope: DEAL_SCOPE, managePerm: "deal.update", ref: (e) => ({ ownerUserId: e.get("agentUserId"), branchId: e.get("branchId"), projectId: e.get("projectId") }) },
  lead: { model: "Lead", readPerm: "lead.read", scope: LEAD_SCOPE, managePerm: "lead.update", ref: (e) => ({ ownerUserId: e.get("assignedUserId"), branchId: e.get("branchId"), projectId: e.get("projectId") }) },
  listing: { model: "Listing", readPerm: "listing.read", scope: LISTING_SCOPE, managePerm: "listing.manage", ref: (e) => ({ ownerUserId: e.get("agentUserId"), branchId: e.get("branchId"), projectId: e.get("projectId") }) },
  contact: { model: "Contact", readPerm: "contact.read", scope: CONTACT_SCOPE, managePerm: "contact.update", ref: (e) => ({ ownerUserId: e.get("ownerUserId"), branchId: e.get("branchId") }) },
};

/** Can the caller read this entity (through their normal scope)? Returns the row or null. */
async function readableEntity(u: Uow, ctx: RequestContext, type: LinkableType, id: string) {
  const spec = SPEC[type];
  if (!hasPermission(ctx, spec.readPerm)) return null;
  const scope = await scopeWhere(u, ctx, spec.readPerm, spec.scope);
  return (await u.repo(spec.model).findOne({ where: { [Op.and]: [{ id }, scope] }, transaction: u.tx })) as any;
}

/** Managing a document attached to an entity requires being able to see AND manage that entity. */
async function assertCanManageVia(u: Uow, ctx: RequestContext, link: EntityRef) {
  const e = await readableEntity(u, ctx, link.entityType, link.entityId);
  if (!e) throw new NotFoundError(link.entityType);
  authorize(ctx, SPEC[link.entityType].managePerm, SPEC[link.entityType].ref(e));
}

/** A document in a restricted folder is only open to people with tenant-wide document access, whatever else would normally let them in. */
async function blockedByFolder(u: Uow, ctx: RequestContext, doc: any, perm: "document.read" | "document.manage"): Promise<boolean> {
  if (!doc.get("folderId")) return false;
  const f: any = await u.repo("DocumentFolder").findById(doc.get("folderId"), { transaction: u.tx });
  if (!f?.get("restricted")) return false;
  return !ctx.grants.some((g) => (g.permission === perm || g.permission === "document.manage") && g.scope === "tenant");
}

async function canRead(u: Uow, ctx: RequestContext, doc: any): Promise<boolean> {
  if (await blockedByFolder(u, ctx, doc, "document.read")) return false;
  if (can(ctx, "document.read") && ctx.grants.some((g) => g.permission === "document.read" && g.scope === "tenant")) return true;
  if (doc.get("createdBy") === ctx.userId && hasPermission(ctx, "document.read")) return true;
  const links = (await u.repo("DocumentLink").findAll({ where: { documentId: doc.get("id") }, transaction: u.tx })) as any[];
  for (const l of links) if (await readableEntity(u, ctx, l.get("entityType"), l.get("entityId"))) return true;
  return false;
}

async function canManage(u: Uow, ctx: RequestContext, doc: any): Promise<boolean> {
  if (await blockedByFolder(u, ctx, doc, "document.manage")) return false;
  if (ctx.grants.some((g) => g.permission === "document.manage" && g.scope === "tenant")) return true;
  if (doc.get("createdBy") === ctx.userId && hasPermission(ctx, "document.manage")) return true;
  const links = (await u.repo("DocumentLink").findAll({ where: { documentId: doc.get("id") }, transaction: u.tx })) as any[];
  for (const l of links) {
    try { await assertCanManageVia(u, ctx, { entityType: l.get("entityType"), entityId: l.get("entityId") }); return true; } catch { /* try the next link */ }
  }
  return false;
}

async function writeVersion(u: Uow, ctx: RequestContext, doc: any, upload: { filename: string; mime?: string; bytes: Buffer }) {
  const v = validateUpload(upload);
  await scanUpload(v);
  const key = storageKeyFor(ctx.tenantId, v.hash);
  const storage = getStorage();
  if (!(await storage.exists(key))) await storage.put(key, v.bytes); // content-addressed: identical bytes are stored once
  const version = Number(doc.get("currentVersion")) + 1;
  await u.repo("DocumentVersion").create({
    id: randomUUID(), documentId: doc.get("id"), version, storageKey: key, filename: v.filename, mime: v.mime, sizeBytes: v.bytes.length, contentHash: v.hash,
    createdBy: ctx.userId, createdAt: mysqlDate(new Date()),
  }, { transaction: u.tx });
  await u.repo("Document").updateById(doc.get("id"), { currentVersion: version }, { transaction: u.tx });
  await u.emit({ type: "document.version_added", aggregateType: "document", aggregateId: doc.get("id"), payload: { version, hash: v.hash } });
  return { version, hash: v.hash };
}

/** What a person may do with one document (folder policy included). */
export async function documentAccess(u: Uow, ctx: RequestContext, doc: any) { return { read: await canRead(u, ctx, doc), manage: await canManage(u, ctx, doc) }; }

export interface CreateDocumentInput {
  folderId?: string | null;
  title: string; kind?: "contract" | "id_document" | "permit" | "invoice" | "receipt" | "other";
  links?: EntityRef[]; file: { filename: string; mime?: string; bytes: Buffer };
}

export async function createDocument(sq: Sequelize, ctx: RequestContext, i: CreateDocumentInput) {
  return withUow(sq, ctx, async (u) => {
    const links = i.links ?? [];
    if (links.length) for (const l of links) await assertCanManageVia(u, ctx, l);
    else authorize(ctx, "document.manage"); // an unattached document needs tenant-wide document management
    const id = randomUUID();
    const doc = await u.repo("Document").create({ id, title: i.title, kind: i.kind ?? "other", currentVersion: 0, createdBy: ctx.userId }, { transaction: u.tx });
    for (const l of links) await u.repo("DocumentLink").create({ id: randomUUID(), documentId: id, entityType: l.entityType, entityId: l.entityId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    const v = await writeVersion(u, ctx, doc, i.file);
    if (i.folderId) {
      const folder: any = await u.repo("DocumentFolder").findById(i.folderId, { transaction: u.tx });
      if (!folder) throw new NotFoundError("Folder");
      if (folder.get("restricted") && !ctx.grants.some((g) => g.permission === "document.manage" && g.scope === "tenant")) throw new ConflictError("Only people with tenant-wide document management can use a restricted folder");
      const { applyFolderPolicy } = await import("./document-folders");
      await applyFolderPolicy(u, folder, doc, { links: links.length });
    }
    await u.emit({ type: "document.created", aggregateType: "document", aggregateId: id, payload: { kind: i.kind ?? "other", links: links.length } });
    return { ...plain(await u.repo("Document").findById(id, { transaction: u.tx })), version: v.version, contentHash: v.hash };
  });
}

/** New version, never an overwrite: earlier versions stay retrievable and signed hashes stay valid. */
export async function addDocumentVersion(sq: Sequelize, ctx: RequestContext, documentId: string, file: { filename: string; mime?: string; bytes: Buffer }) {
  return withUow(sq, ctx, async (u) => {
    const doc: any = await u.repo("Document").findById(documentId, { transaction: u.tx });
    if (!doc || !(await canRead(u, ctx, doc))) throw new NotFoundError("Document");
    if (!(await canManage(u, ctx, doc))) throw new ForbiddenError("Missing permission: document.manage");
    return writeVersion(u, ctx, doc, file);
  });
}

export async function linkDocument(sq: Sequelize, ctx: RequestContext, documentId: string, link: EntityRef) {
  return withUow(sq, ctx, async (u) => {
    const doc: any = await u.repo("Document").findById(documentId, { transaction: u.tx });
    if (!doc || !(await canManage(u, ctx, doc))) throw new NotFoundError("Document");
    await assertCanManageVia(u, ctx, link);
    if (await u.repo("DocumentLink").findOne({ where: { documentId, entityType: link.entityType, entityId: link.entityId }, transaction: u.tx })) throw new ConflictError("Already linked");
    await u.repo("DocumentLink").create({ id: randomUUID(), documentId, entityType: link.entityType, entityId: link.entityId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
  });
}

export async function getDocument(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const doc: any = await u.repo("Document").findById(id, { transaction: u.tx });
    if (!doc || !(await canRead(u, ctx, doc))) throw new NotFoundError("Document");
    const [versions, links] = await Promise.all([
      u.repo("DocumentVersion").findAll({ where: { documentId: id }, order: [["version", "ASC"]], attributes: { exclude: ["storageKey"] }, transaction: u.tx }),
      u.repo("DocumentLink").findAll({ where: { documentId: id }, transaction: u.tx }),
    ]);
    return { ...plain(doc), versions: versions.map(plain), links: links.map(plain) };
  });
}

export async function listDocumentsFor(sq: Sequelize, ctx: RequestContext, link: EntityRef) {
  return withUow(sq, ctx, async (u) => {
    if (!(await readableEntity(u, ctx, link.entityType, link.entityId))) throw new NotFoundError(link.entityType);
    const links = (await u.repo("DocumentLink").findAll({ where: { entityType: link.entityType, entityId: link.entityId }, transaction: u.tx })) as any[];
    if (!links.length) return [];
    const docs = await u.repo("Document").findAll({ where: { id: { [Op.in]: links.map((l) => l.get("documentId")) } }, order: [["createdAt", "DESC"]], transaction: u.tx });
    return docs.map(plain);
  });
}

/** Download bytes for a version, verifying them against the recorded hash before returning (tamper / corruption check). */
export async function downloadDocument(sq: Sequelize, ctx: RequestContext, id: string, version?: number) {
  return withUow(sq, ctx, async (u) => {
    const doc: any = await u.repo("Document").findById(id, { transaction: u.tx });
    if (!doc || !(await canRead(u, ctx, doc))) throw new NotFoundError("Document");
    const v: any = await u.repo("DocumentVersion").findOne({ where: { documentId: id, version: version ?? doc.get("currentVersion") }, transaction: u.tx });
    if (!v) throw new NotFoundError("Document version");
    const bytes = await getStorage().get(v.get("storageKey"));
    if (sha256Hex(bytes) !== v.get("contentHash")) throw new DocumentIntegrityError();
    await u.emit({ type: "document.downloaded", aggregateType: "document", aggregateId: id, payload: { version: v.get("version") } });
    return { filename: v.get("filename") as string, mime: v.get("mime") as string, bytes, version: v.get("version") as number, contentHash: v.get("contentHash") as string };
  });
}

/** Internal: load a specific version's bytes for the signature flow (caller has already authorised). */
export async function loadVersionBytes(u: Uow, documentId: string, version: number) {
  const v: any = await u.repo("DocumentVersion").findOne({ where: { documentId, version }, transaction: u.tx });
  if (!v) throw new NotFoundError("Document version");
  const bytes = await getStorage().get(v.get("storageKey"));
  if (sha256Hex(bytes) !== v.get("contentHash")) throw new DocumentIntegrityError();
  return { bytes, hash: v.get("contentHash") as string, filename: v.get("filename") as string };
}

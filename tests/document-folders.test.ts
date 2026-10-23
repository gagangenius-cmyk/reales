import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import { createContact, createDocument, documentExpirySweep, downloadDocument, getDocument, listAllDocuments, listFolders, moveDocument, saveFolder, softDelete } from "@reales/domain";
import { systemContext } from "@reales/database";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, makeTenant, testDb, uniq } from "./helpers";
import { agentIn, makeOrg } from "./brokerage-helpers";
import { phone } from "./deal-helpers";

const sq = () => testDb();
afterAll(closeTestDb);
const png = (salt: string) => ({ filename: `${salt}.png`, mime: "image/png", bytes: Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64"), Buffer.from(salt)]) });

describe("document folder policies", () => {
  it("restricts a folder to tenant-wide managers, applies default expiry and retention, and blocks deleting retained documents", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const agent = await agentIn(t, org.marina.id, org.bu.id);
    const contact = await createContact(sq(), agent.ctx, { firstName: uniq("C"), phone: phone() });
    await expect(saveFolder(sq(), agent.ctx, { name: "Nope" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveFolder(sq(), t.admin, { name: "Bad", retentionDays: 0 })).rejects.toThrow(/1 to 36500/);
    await expect(saveFolder(sq(), t.admin, { name: "Bad", allowedKinds: ["nonsense"] })).rejects.toThrow(/Unknown document kind/);
    const secret: any = await saveFolder(sq(), t.admin, { name: "Board papers", restricted: true, retentionDays: 365, defaultExpiryDays: 400, allowedKinds: ["contract", "other"] });
    await expect(saveFolder(sq(), t.admin, { name: "Board papers" })).rejects.toThrow(/already exists/);

    const doc: any = await createDocument(sq(), t.admin, { title: "Shareholder agreement", kind: "contract", file: png("a"), folderId: secret.id });
    const after: any = await getDocument(sq(), t.admin, doc.id);
    expect(after.folderId).toBe(secret.id);
    expect(after.retainUntil).toBeTruthy();
    expect(after.expiresOn).toBeTruthy();
    // the agent created a document of their own and cannot read or manage one in a restricted folder, even when linked to a contact they can see
    const own: any = await createDocument(sq(), agent.ctx, { title: "Agent file", file: png("b"), links: [{ entityType: "contact", entityId: contact.id }] });
    await expect(getDocument(sq(), agent.ctx, doc.id)).rejects.toThrow(/not found/i);
    await expect(downloadDocument(sq(), agent.ctx, doc.id)).rejects.toThrow(/not found/i);
    await expect(moveDocument(sq(), agent.ctx, own.id, secret.id)).rejects.toThrow(/restricted folder|not found/i);
    expect((await listFolders(sq(), agent.ctx)).map((f: any) => f.name)).not.toContain("Board papers");
    expect((await listFolders(sq(), t.admin)).map((f: any) => f.name)).toContain("Board papers");
    expect((await listAllDocuments(sq(), agent.ctx)).map((d: any) => d.id)).not.toContain(doc.id);
    expect((await listAllDocuments(sq(), t.admin)).map((d: any) => d.id)).toContain(doc.id);
    // folder rules
    await expect(createDocument(sq(), t.admin, { title: "An invoice", kind: "invoice", file: png("c"), folderId: secret.id })).rejects.toThrow(/only accepts/);
    const needsLink: any = await saveFolder(sq(), t.admin, { name: "Client files", requiresLink: true });
    await expect(createDocument(sq(), t.admin, { title: "Loose", file: png("d"), folderId: needsLink.id })).rejects.toThrow(/attached to a lead/);
    const linked: any = await createDocument(sq(), t.admin, { title: "Passport copy", file: png("e"), links: [{ entityType: "contact", entityId: contact.id }], folderId: needsLink.id });
    expect(linked.id).toBeTruthy();
    // retention: cannot be moved out or deleted before the date
    await expect(moveDocument(sq(), t.admin, doc.id, needsLink.id)).rejects.toThrow(/retained until/);
    await expect(softDelete(sq(), t.admin, "document", doc.id)).rejects.toThrow(/retained until/);
    await sq().query("UPDATE documents SET retain_until='2000-01-01' WHERE id=:id", { replacements: { id: doc.id }, type: QueryTypes.UPDATE });
    expect((await softDelete(sq(), t.admin, "document", doc.id)).id).toBe(doc.id);
  });

  it("warns once about a document nearing its expiry", async () => {
    const t = await makeTenant();
    const f: any = await saveFolder(sq(), t.admin, { name: "Permits", defaultExpiryDays: 10 });
    const d: any = await createDocument(sq(), t.admin, { title: "Trade licence", kind: "permit", file: png("f"), folderId: f.id });
    const sys = () => systemContext(t.tenantId, uniq("c"));
    expect(await documentExpirySweep(sq(), sys())).toBeGreaterThan(0);
    expect(await documentExpirySweep(sq(), sys())).toBe(0);
    expect((await moveDocument(sq(), t.admin, d.id, null) as any).folderId).toBeNull();
  });
});

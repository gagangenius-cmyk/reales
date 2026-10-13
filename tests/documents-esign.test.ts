import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { QueryTypes } from "sequelize";
import {
  addDocumentVersion, advanceDealStage, buildMockSignatureWebhook, cancelEnvelope, completeMilestone, createDocument, createEnvelope, DocumentIntegrityError, downloadDocument,
  getDeal, getDocument, getEnvelope, getStorage, ingestWebhook, linkDocument, listDocumentsFor, LocalObjectStorage, NotFoundError, processWebhookEvent, sendEnvelope,
  setContentScanner, setStorage, UploadRejectedError, validateUpload, WebhookSignatureError, MAX_UPLOAD_BYTES,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, contextFor, makeTenant, testDb, uniq } from "./helpers";
import { openDeal, kit } from "./deal-helpers";

const sq = () => testDb();
let dir: string;
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), "reales-storage-")); setStorage(new LocalObjectStorage(dir)); });
afterAll(async () => { setStorage(null); setContentScanner(null); rmSync(dir, { recursive: true, force: true }); await closeTestDb(); });

const pdf = (text = "contract") => Buffer.from(`%PDF-1.4\n% ${text} ${Math.random()}\n%%EOF\n`);
const file = (name = "spa.pdf", bytes = pdf()) => ({ filename: name, mime: "application/pdf", bytes });

describe("upload validation", () => {
  it("accepts allow-listed types by content and rejects mismatches, active content, empty and oversize files", () => {
    expect(validateUpload(file()).mime).toBe("application/pdf");
    expect(validateUpload({ filename: "photo.JPG", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) }).mime).toBe("image/jpeg");
    expect(() => validateUpload({ filename: "evil.pdf", mime: "application/pdf", bytes: Buffer.from("MZ\x90\x00 this is an executable") })).toThrow(UploadRejectedError);
    expect(() => validateUpload({ filename: "page.html", bytes: Buffer.from("<html><script>alert(1)</script></html>") })).toThrow(/Unsupported/);
    expect(() => validateUpload({ filename: "logo.svg", bytes: Buffer.from("<svg onload=alert(1)/>") })).toThrow(/Unsupported/);
    expect(() => validateUpload({ filename: "a.png", bytes: pdf() })).toThrow(/Unsupported or mismatched/); // PDF bytes with a .png name
    expect(() => validateUpload({ filename: "a.pdf", mime: "image/png", bytes: pdf() })).toThrow(/does not match/);
    expect(() => validateUpload({ filename: "empty.pdf", bytes: Buffer.alloc(0) })).toThrow(/empty/);
    expect(() => validateUpload({ filename: "big.pdf", bytes: Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(MAX_UPLOAD_BYTES)]) })).toThrow(/limit/);
    expect(validateUpload({ filename: "../../etc/passwd.pdf", bytes: pdf() }).filename).toBe("passwd.pdf");
    expect(() => validateUpload({ filename: ".hidden.pdf", bytes: pdf() })).toThrow(/Invalid file name/);
  });

  it("refuses path-traversal storage keys", async () => {
    const s = new LocalObjectStorage(dir);
    await expect(s.get("../../etc/passwd")).rejects.toThrow(/Invalid storage key/);
    await expect(s.put("not/a/valid/key", Buffer.from("x"))).rejects.toThrow(/Invalid storage key/);
  });

  it("lets a configured malware scanner veto uploads", async () => {
    const t = await makeTenant();
    setContentScanner({ scan: async () => ({ clean: false, reason: "EICAR-Test" }) });
    await expect(createDocument(sq(), t.admin, { title: "x", file: file() })).rejects.toThrow(/malware scan: EICAR-Test/);
    setContentScanner(null);
    await expect(createDocument(sq(), t.admin, { title: "x", file: file() })).resolves.toBeTruthy();
  });
});

describe("documents", () => {
  it("keeps immutable versions, stores identical bytes once, and verifies integrity on download", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const { deal } = await openDeal(t, k);
    const bytes = pdf("v1");
    const doc = await createDocument(sq(), k.agent.ctx, { title: "SPA", kind: "contract", links: [{ entityType: "deal", entityId: deal.id }], file: file("spa.pdf", bytes) });
    expect(doc).toMatchObject({ version: 1, kind: "contract" });
    const v2 = await addDocumentVersion(sq(), k.agent.ctx, doc.id, file("spa-v2.pdf", pdf("v2")));
    expect(v2.version).toBe(2);
    const dup = await addDocumentVersion(sq(), k.agent.ctx, doc.id, file("copy.pdf", bytes)); // same bytes as v1
    expect(dup.hash).toBe(doc.contentHash);

    const detail = await getDocument(sq(), k.agent.ctx, doc.id);
    expect(detail.versions.map((v: any) => v.version)).toEqual([1, 2, 3]);
    expect(detail.versions[0].storageKey).toBeUndefined(); // storage keys never leave the server
    const rows = await sq().query<{ storage_key: string }>("SELECT storage_key FROM document_versions WHERE tenant_id=:t AND document_id=:d ORDER BY version", { replacements: { t: t.tenantId, d: doc.id }, type: QueryTypes.SELECT });
    expect(rows[0]!.storage_key).toBe(rows[2]!.storage_key);
    await expect(sq().query("UPDATE document_versions SET content_hash='x' WHERE tenant_id=:t", { replacements: { t: t.tenantId } })).rejects.toThrow(/append-only/);

    const dl = await downloadDocument(sq(), k.agent.ctx, doc.id, 1);
    expect(dl.bytes.equals(bytes)).toBe(true);
    expect((await downloadDocument(sq(), k.agent.ctx, doc.id)).version).toBe(3);
    await getStorage().put(rows[1]!.storage_key, Buffer.from("%PDF-1.4 tampered on disk"));
    await expect(downloadDocument(sq(), k.agent.ctx, doc.id, 2)).rejects.toBeInstanceOf(DocumentIntegrityError);
  });

  it("gates access through the linked entity and never crosses tenants", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const { deal } = await openDeal(t, k);
    const doc = await createDocument(sq(), k.agent.ctx, { title: "Passport", kind: "id_document", links: [{ entityType: "deal", entityId: deal.id }], file: file("id.pdf") });
    await expect(getDocument(sq(), k.other.ctx, doc.id)).rejects.toBeInstanceOf(NotFoundError); // another agent: cannot see the deal
    await expect(downloadDocument(sq(), k.other.ctx, doc.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getDocument(sq(), k.mgr.ctx, doc.id)).resolves.toMatchObject({ id: doc.id }); // branch manager can
    await expect(addDocumentVersion(sq(), k.other.ctx, doc.id, file())).rejects.toBeInstanceOf(NotFoundError);
    const foreign = await makeTenant();
    await expect(getDocument(sq(), foreign.admin, doc.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(listDocumentsFor(sq(), foreign.admin, { entityType: "deal", entityId: deal.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createDocument(sq(), foreign.admin, { title: "x", links: [{ entityType: "deal", entityId: deal.id }], file: file() })).rejects.toBeInstanceOf(NotFoundError);
    expect((await listDocumentsFor(sq(), k.agent.ctx, { entityType: "deal", entityId: deal.id })).map((d: any) => d.id)).toEqual([doc.id]);

    // An unattached document needs tenant-wide document management
    await expect(createDocument(sq(), k.agent.ctx, { title: "loose", file: file() })).rejects.toBeInstanceOf(ForbiddenError);
    const loose = await createDocument(sq(), t.admin, { title: "loose", file: file() });
    await expect(getDocument(sq(), k.agent.ctx, loose.id)).rejects.toBeInstanceOf(NotFoundError);
    await linkDocument(sq(), k.mgr.ctx, loose.id, { entityType: "deal", entityId: deal.id }).catch((e) => expect(e).toBeInstanceOf(NotFoundError)); // manager cannot manage a doc they cannot see
    await linkDocument(sq(), t.admin, loose.id, { entityType: "deal", entityId: deal.id });
    await expect(getDocument(sq(), k.agent.ctx, loose.id)).resolves.toMatchObject({ id: loose.id });
  });
});

/** A deal with a contract attached and an envelope ready to send. */
async function signingKit(signers = 2) {
  const t = await makeTenant();
  const k = await kit(t);
  const { deal } = await openDeal(t, k);
  const doc = await createDocument(sq(), k.agent.ctx, { title: "Sale contract", kind: "contract", links: [{ entityType: "deal", entityId: deal.id }], file: file("contract.pdf", pdf("spa")) });
  const emails = Array.from({ length: signers }, () => `${uniq("signer")}@example.com`);
  const env = await createEnvelope(sq(), k.mgr.ctx, { documentId: doc.id, dealId: deal.id, signers: emails.map((email, i) => ({ name: `Signer ${i + 1}`, email, order: i + 1 })) });
  return { t, k, deal, doc, env, emails };
}

const deliver = async (provider: "esign", ev: { type: any; envelopeId: string; signerEmail?: string; eventId?: string }) => {
  const w = buildMockSignatureWebhook(ev);
  const r = await ingestWebhook(sq(), { kind: provider, provider: "mock", rawBody: w.rawBody, headers: w.headers });
  const processed = r.id && r.status === "queued" ? await processWebhookEvent(sq(), r.id) : null;
  return { ingest: r, processed };
};

describe("e-signature", () => {
  it("runs the full flow: ordered signers, evidence with the pinned hash, deal milestone unlocked", async () => {
    const { t, k, deal, env, emails, doc } = await signingKit();
    expect(env).toMatchObject({ status: "draft", documentVersion: 1 });
    await expect(sendEnvelope(sq(), k.other.ctx, env.id)).rejects.toBeInstanceOf(NotFoundError);
    const sent = await sendEnvelope(sq(), k.mgr.ctx, env.id);
    expect(sent.status).toBe("sent");
    await expect(sendEnvelope(sq(), k.mgr.ctx, env.id)).rejects.toThrow(/cannot be sent/);

    // Signer 2 tries to sign before signer 1
    const early = await deliver("esign", { type: "signer.signed", envelopeId: env.providerEnvelopeId, signerEmail: emails[1] });
    expect(early.ingest.status).toBe("queued");
    expect(early.processed).toMatchObject({ status: "failed", error: expect.stringMatching(/in order/) });

    const first = await deliver("esign", { type: "signer.signed", envelopeId: env.providerEnvelopeId, signerEmail: emails[0], eventId: "evt-1" });
    expect(first.processed).toMatchObject({ status: "processed", outcome: "applied" });
    const replay = await deliver("esign", { type: "signer.signed", envelopeId: env.providerEnvelopeId, signerEmail: emails[0], eventId: "evt-1" });
    expect(replay.ingest).toMatchObject({ duplicate: true, status: "duplicate" });

    const last = await deliver("esign", { type: "signer.signed", envelopeId: env.providerEnvelopeId, signerEmail: emails[1] });
    expect(last.processed).toMatchObject({ status: "processed", outcome: "completed" });

    const done = await getEnvelope(sq(), k.mgr.ctx, env.id);
    expect(done.status).toBe("completed");
    expect(done.evidence.contentHash).toBe(env.contentHash);
    expect(done.evidence.signers.map((s: any) => s.email)).toEqual(emails);
    expect(done.signers.every((s: any) => s.status === "signed")).toBe(true);
    expect(done.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(["envelope.created", "envelope.sent", "signer.signed", "envelope.completed"]));
    await expect(sq().query("DELETE FROM signature_events WHERE tenant_id=:t", { replacements: { t: t.tenantId } })).rejects.toThrow(/append-only/);

    const d = await getDeal(sq(), k.mgr.ctx, deal.id);
    const ms = d.milestones.find((m: any) => m.key === "contract_signed");
    expect(ms.status).toBe("done");
    expect(ms.completedBy).toBe(`signature:${env.id}`);
    // The signed milestone now lets the deal reach "signed" once the deposit is in
    await completeMilestone(sq(), k.mgr.ctx, deal.id, "deposit", { reason: "bank statement" });
    await advanceDealStage(sq(), k.mgr.ctx, deal.id, { to: "contract" });
    expect((await advanceDealStage(sq(), k.mgr.ctx, deal.id, { to: "signed" })).stage).toBe("signed");
    void doc;
  });

  it("rejects unsigned/forged callbacks without persisting anything, and ignores unknown references", async () => {
    const { env, emails } = await signingKit(1);
    const before = await sq().query<{ n: number }>("SELECT COUNT(*) n FROM webhook_events", { type: QueryTypes.SELECT });
    const w = buildMockSignatureWebhook({ type: "signer.signed", envelopeId: env.providerEnvelopeId, signerEmail: emails[0] });
    await expect(ingestWebhook(sq(), { kind: "esign", provider: "mock", rawBody: w.rawBody, headers: {} })).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(ingestWebhook(sq(), { kind: "esign", provider: "mock", rawBody: w.rawBody, headers: { "x-mock-signature": "00".repeat(32) } })).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(ingestWebhook(sq(), { kind: "esign", provider: "mock", rawBody: w.rawBody.replace("signed", "declined"), headers: w.headers })).rejects.toBeInstanceOf(WebhookSignatureError); // body tampered after signing
    const after = await sq().query<{ n: number }>("SELECT COUNT(*) n FROM webhook_events", { type: QueryTypes.SELECT });
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));

    const unknown = await deliver("esign", { type: "signer.signed", envelopeId: "mock_env_nonexistent", signerEmail: "x@example.com" });
    expect(unknown.ingest.status).toBe("ignored");
  });

  it("does not complete an envelope whose stored document was altered after sending", async () => {
    const { k, env, emails, doc } = await signingKit(1);
    await sendEnvelope(sq(), k.mgr.ctx, env.id);
    const [row] = await sq().query<{ storage_key: string }>("SELECT storage_key FROM document_versions WHERE document_id=:d AND version=1", { replacements: { d: doc.id }, type: QueryTypes.SELECT });
    await getStorage().put(row!.storage_key, Buffer.from("%PDF-1.4 swapped after send"));
    const r = await deliver("esign", { type: "signer.signed", envelopeId: env.providerEnvelopeId, signerEmail: emails[0] });
    expect(r.processed).toMatchObject({ status: "processed", outcome: "tamper_detected" });
    const e = await getEnvelope(sq(), k.mgr.ctx, env.id);
    expect(e.status).toBe("sent"); // never marked completed
    expect(e.events.map((x: any) => x.type)).toContain("integrity.failed");
  });

  it("handles declines and cancellations, and blocks cross-tenant and unauthorised use", async () => {
    const { t, k, env, emails, deal, doc } = await signingKit(2);
    await sendEnvelope(sq(), k.mgr.ctx, env.id);
    const dec = await deliver("esign", { type: "signer.declined", envelopeId: env.providerEnvelopeId, signerEmail: emails[0] });
    expect(dec.processed).toMatchObject({ outcome: "declined" });
    expect((await getEnvelope(sq(), k.mgr.ctx, env.id)).status).toBe("declined");
    const late = await deliver("esign", { type: "signer.signed", envelopeId: env.providerEnvelopeId, signerEmail: emails[0] });
    expect(late.processed).toMatchObject({ outcome: "ignored" });

    const foreign = await makeTenant();
    await expect(getEnvelope(sq(), foreign.admin, env.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelEnvelope(sq(), foreign.admin, env.id, "x")).rejects.toBeInstanceOf(NotFoundError);
    // Agents lack signature.manage; documents must be attached to the deal; signers must be distinct
    await expect(createEnvelope(sq(), k.agent.ctx, { documentId: doc.id, dealId: deal.id, signers: [{ name: "A", email: "a@example.com" }] })).rejects.toBeInstanceOf(ForbiddenError);
    const loose = await createDocument(sq(), t.admin, { title: "not attached", file: file("x.pdf", pdf("z")) });
    await expect(createEnvelope(sq(), k.mgr.ctx, { documentId: loose.id, dealId: deal.id, signers: [{ name: "A", email: "a@example.com" }] })).rejects.toThrow(/attached to the deal/);
    await expect(createEnvelope(sq(), k.mgr.ctx, { documentId: doc.id, dealId: deal.id, signers: [{ name: "A", email: "a@example.com" }, { name: "B", email: "A@Example.com" }] })).rejects.toThrow(/distinct/);
    await expect(createEnvelope(sq(), k.mgr.ctx, { documentId: doc.id, dealId: deal.id, signers: [] })).rejects.toThrow(/At least one signer/);
    const env2 = await createEnvelope(sq(), k.mgr.ctx, { documentId: doc.id, dealId: deal.id, signers: [{ name: "A", email: "a@example.com" }] });
    await expect(cancelEnvelope(sq(), k.mgr.ctx, env2.id, " ")).rejects.toThrow(/reason/);
    expect((await cancelEnvelope(sq(), k.mgr.ctx, env2.id, "wrong contract")).status).toBe("cancelled");
  });
});

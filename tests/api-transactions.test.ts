import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalObjectStorage, setStorage, buildMockSignatureWebhook, buildMockPaymentWebhook } from "@reales/domain";
import { closeTestDb, makeTenant, testDb, uniq } from "./helpers";
import { kit, phone } from "./deal-helpers";
import { call, loginAs, mfaSession } from "./api-helpers";
import { GET as viewingsGet, POST as viewingsPost } from "@/app/api/v1/viewings/route";
import { POST as viewingComplete } from "@/app/api/v1/viewings/[id]/complete/route";
import { POST as offersPost } from "@/app/api/v1/offers/route";
import { POST as offerCounter } from "@/app/api/v1/offers/[id]/counter/route";
import { POST as offerAccept } from "@/app/api/v1/offers/[id]/accept/route";
import { POST as reservationsPost } from "@/app/api/v1/reservations/route";
import { POST as dealsPost } from "@/app/api/v1/deals/route";
import { GET as dealGet } from "@/app/api/v1/deals/[id]/route";
import { POST as dealStage } from "@/app/api/v1/deals/[id]/stage/route";
import { POST as milestoneComplete } from "@/app/api/v1/deals/[id]/milestones/[key]/complete/route";
import { POST as documentsPost } from "@/app/api/v1/documents/route";
import { GET as documentGet } from "@/app/api/v1/documents/[id]/route";
import { GET as documentDownload } from "@/app/api/v1/documents/[id]/download/route";
import { POST as envelopesPost } from "@/app/api/v1/signature-envelopes/route";
import { POST as envelopeSend } from "@/app/api/v1/signature-envelopes/[id]/send/route";
import { GET as envelopeGet } from "@/app/api/v1/signature-envelopes/[id]/route";
import { POST as envelopeSimulate } from "@/app/api/v1/signature-envelopes/[id]/simulate/route";
import { POST as esignWebhook } from "@/app/api/webhooks/esign/[provider]/route";
import { POST as paymentWebhook } from "@/app/api/webhooks/payment/[provider]/route";
import { GET as invoicesGet, POST as invoicesPost } from "@/app/api/v1/invoices/route";
import { POST as invoiceIssue } from "@/app/api/v1/invoices/[id]/issue/route";
import { GET as invoiceGet } from "@/app/api/v1/invoices/[id]/route";
import { POST as paymentLinkPost } from "@/app/api/v1/payment-links/route";
import { GET as paymentGet } from "@/app/api/v1/payments/[id]/route";

let dir: string;
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), "reales-api-storage-")); setStorage(new LocalObjectStorage(dir)); });
afterAll(async () => { setStorage(null); rmSync(dir, { recursive: true, force: true }); await closeTestDb(); });
const sq = () => testDb();
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const pdfBytes = (t = "x") => Buffer.from(`%PDF-1.4\n% ${t} ${Math.random()}\n%%EOF`);
const pdfForm = (fields: Record<string, string>, bytes = pdfBytes(), name = "contract.pdf", type = "application/pdf") => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  f.set("file", new File([new Uint8Array(bytes)], name, { type }));
  return f;
};

describe("API: viewings", () => {
  it("books a viewing, rejects clashes with 409, and hides other agents' viewings", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const a = (await loginAs(t.slug, k.agent.email)).token!;
    const o = (await loginAs(t.slug, k.other.email)).token!;
    const at = inHours(26);
    const ok = await call(viewingsPost, "POST", "/api/v1/viewings", { cookie: a, body: { contactId: k.contact.id, unitId: k.inv.unit.id, scheduledAt: at, durationMin: 30 } });
    expect(ok.status).toBe(201);
    expect((await call(viewingsPost, "POST", "/api/v1/viewings", { cookie: a, body: { contactId: k.contact.id, scheduledAt: at } })).status).toBe(409);
    expect((await call(viewingsPost, "POST", "/api/v1/viewings", { cookie: a, body: { unitId: k.inv.unit.id, scheduledAt: at } })).status).toBe(400); // needs lead or contact
    expect((await call(viewingsPost, "POST", "/api/v1/viewings", { cookie: a, body: { contactId: k.contact.id, scheduledAt: "tomorrow" } })).status).toBe(400);
    expect((await call(viewingsGet, "GET", "/api/v1/viewings", { cookie: o })).json.viewings).toEqual([]);
    const id = ok.json.id;
    expect((await call(viewingComplete, "POST", `/api/v1/viewings/${id}/complete`, { cookie: a, params: { id }, body: { rating: 6, interest: "high" } })).status).toBe(400);
    expect((await call(viewingComplete, "POST", `/api/v1/viewings/${id}/complete`, { cookie: o, params: { id }, body: { rating: 5, interest: "high" } })).status).toBe(404);
    expect((await call(viewingComplete, "POST", `/api/v1/viewings/${id}/complete`, { cookie: a, params: { id }, body: { rating: 5, interest: "high" } })).json.status).toBe("completed");
  });
});

describe("API: offer to deal, with gates", () => {
  it("negotiates, reserves, opens a deal and reports blocking reasons with 422", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const agent = (await loginAs(t.slug, k.agent.email)).token!;
    const mgr = (await mfaSession(t.slug, k.mgr.email)).token;
    const offer = await call(offersPost, "POST", "/api/v1/offers", { cookie: agent, body: { unitId: k.inv.unit.id, contactId: k.contact.id, amount: 1_900_000, depositAmount: 90_000 } });
    expect(offer.status).toBe(201);
    const oid = offer.json.id;
    expect((await call(offerCounter, "POST", `/api/v1/offers/${oid}/counter`, { cookie: agent, params: { id: oid }, body: { amount: 2_000_000, by: "seller" } })).json.status).toBe("countered");
    expect((await call(offerAccept, "POST", `/api/v1/offers/${oid}/accept`, { cookie: agent, params: { id: oid } })).status).toBe(403); // approval is a manager action
    expect((await call(offerAccept, "POST", `/api/v1/offers/${oid}/accept`, { cookie: mgr, params: { id: oid } })).json.status).toBe("accepted");

    const res = await call(reservationsPost, "POST", "/api/v1/reservations", { cookie: mgr, body: { unitId: k.inv.unit.id, contactId: k.contact.id, offerId: oid, depositAmount: 90_000 } });
    expect(res.status).toBe(201);
    const dup = await call(reservationsPost, "POST", "/api/v1/reservations", { cookie: mgr, body: { unitId: k.inv.unit.id, contactId: k.contact.id } });
    expect(dup.status).toBe(409);
    const deal = await call(dealsPost, "POST", "/api/v1/deals", { cookie: mgr, body: { reservationId: res.json.id } });
    expect(deal.status).toBe(201);
    expect(Number(deal.json.amount)).toBe(2_000_000);
    const did = deal.json.id;

    const blocked = await call(dealStage, "POST", `/api/v1/deals/${did}/stage`, { cookie: agent, params: { id: did }, body: { to: "contract" } });
    expect(blocked.status).toBe(422);
    expect(blocked.json.error).toMatchObject({ code: "deal_blocked", reasons: ["Deposit has not been received"] });
    expect((await call(milestoneComplete, "POST", `/api/v1/deals/${did}/milestones/deposit/complete`, { cookie: agent, params: { id: did, key: "deposit" }, body: { reason: "cash" } })).status).toBe(403);
    expect((await call(milestoneComplete, "POST", `/api/v1/deals/${did}/milestones/BAD KEY/complete`, { cookie: mgr, params: { id: did, key: "BAD KEY" }, body: {} })).status).toBe(400);
    expect((await call(milestoneComplete, "POST", `/api/v1/deals/${did}/milestones/deposit/complete`, { cookie: mgr, params: { id: did, key: "deposit" }, body: { reason: "bank statement" } })).status).toBe(200);
    expect((await call(dealStage, "POST", `/api/v1/deals/${did}/stage`, { cookie: agent, params: { id: did }, body: { to: "contract" } })).json.stage).toBe("contract");
    const detail = await call(dealGet, "GET", `/api/v1/deals/${did}`, { cookie: agent, params: { id: did } });
    expect(detail.json.stageEvents.map((e: any) => e.toStage)).toEqual(["reserved", "contract"]);
    const otherAgent = (await loginAs(t.slug, k.other.email)).token!;
    expect((await call(dealGet, "GET", `/api/v1/deals/${did}`, { cookie: otherAgent, params: { id: did } })).status).toBe(404);
  });
});

describe("API: documents and e-signature", () => {
  it("uploads with validation, downloads as a hardened attachment, and completes a signature through the real webhook route", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const agent = (await loginAs(t.slug, k.agent.email)).token!;
    const mgr = (await mfaSession(t.slug, k.mgr.email)).token;
    const offer = await call(offersPost, "POST", "/api/v1/offers", { cookie: agent, body: { unitId: k.inv.unit.id, contactId: k.contact.id, amount: 1_500_000 } });
    await call(offerAccept, "POST", `/api/v1/offers/${offer.json.id}/accept`, { cookie: mgr, params: { id: offer.json.id } });
    const res = await call(reservationsPost, "POST", "/api/v1/reservations", { cookie: mgr, body: { unitId: k.inv.unit.id, contactId: k.contact.id, offerId: offer.json.id } });
    const deal = await call(dealsPost, "POST", "/api/v1/deals", { cookie: mgr, body: { reservationId: res.json.id } });
    const did = deal.json.id;

    // upload rules
    const bad = await call(documentsPost, "POST", "/api/v1/documents", { cookie: agent, form: pdfForm({ title: "Malware", entityType: "deal", entityId: did }, Buffer.from("MZ\x90 executable"), "contract.pdf") });
    expect(bad.status).toBe(422);
    expect(bad.json.error.code).toBe("upload_rejected");
    expect((await call(documentsPost, "POST", "/api/v1/documents", { cookie: agent, form: pdfForm({ title: "", entityType: "deal", entityId: did }) })).status).toBe(400);
    expect((await call(documentsPost, "POST", "/api/v1/documents", { cookie: agent, body: { title: "json" } })).status).toBe(422); // not multipart
    const other = (await loginAs(t.slug, k.other.email)).token!;
    expect((await call(documentsPost, "POST", "/api/v1/documents", { cookie: other, form: pdfForm({ title: "sneaky", entityType: "deal", entityId: did }) })).status).toBe(404);

    const bytes = pdfBytes("sale-contract");
    const doc = await call(documentsPost, "POST", "/api/v1/documents", { cookie: agent, form: pdfForm({ title: "Sale contract", kind: "contract", entityType: "deal", entityId: did }, bytes) });
    expect(doc.status).toBe(201);
    const docId = doc.json.id;
    expect((await call(documentGet, "GET", `/api/v1/documents/${docId}`, { cookie: other, params: { id: docId } })).status).toBe(404);

    const dl = await call(documentDownload, "GET", `/api/v1/documents/${docId}/download`, { cookie: agent, params: { id: docId } });
    expect(dl.status).toBe(200);
    expect(dl.res.headers.get("content-disposition")).toMatch(/^attachment; filename\*=UTF-8''contract\.pdf/);
    expect(dl.res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.res.headers.get("content-security-policy")).toContain("sandbox");
    expect(dl.res.headers.get("x-document-hash")).toBe(doc.json.contentHash);
    expect(dl.text.startsWith("%PDF-1.4")).toBe(true);

    // signature: created by the manager, completed via the real (unauthenticated-by-session) webhook route
    const signers = [{ name: "Buyer", email: `${uniq("buyer")}@example.com` }, { name: "Seller", email: `${uniq("seller")}@example.com` }];
    const env = await call(envelopesPost, "POST", "/api/v1/signature-envelopes", { cookie: mgr, body: { documentId: docId, dealId: did, signers } });
    expect(env.status).toBe(201);
    const eid = env.json.id;
    expect((await call(envelopeSend, "POST", `/api/v1/signature-envelopes/${eid}/send`, { cookie: mgr, params: { id: eid } })).json.status).toBe("sent");

    process.env.WEBHOOK_PROCESS_INLINE = "1";
    const deliver = (email: string, eventId?: string) => {
      const w = buildMockSignatureWebhook({ type: "signer.signed", envelopeId: env.json.providerEnvelopeId, signerEmail: email, eventId });
      return call(esignWebhook, "POST", "/api/webhooks/esign/mock", { origin: null, params: { provider: "mock" }, raw: w.rawBody, headers: { ...w.headers, "content-type": "application/json" } });
    };
    const forged = await call(esignWebhook, "POST", "/api/webhooks/esign/mock", { origin: null, params: { provider: "mock" }, raw: JSON.stringify({ eventId: "x", type: "signer.signed", envelopeId: env.json.providerEnvelopeId, signerEmail: signers[0]!.email }), headers: { "x-mock-signature": "ab".repeat(32) } });
    expect(forged.status).toBe(401);
    expect((await deliver(signers[0]!.email, "e1")).json.status).toBe("queued");
    expect((await deliver(signers[0]!.email, "e1")).json.status).toBe("duplicate");
    expect((await deliver(signers[1]!.email)).json.status).toBe("queued");
    const done = await call(envelopeGet, "GET", `/api/v1/signature-envelopes/${eid}`, { cookie: mgr, params: { id: eid } });
    expect(done.json.status).toBe("completed");
    expect(done.json.evidence.contentHash).toBe(doc.json.contentHash);
    const d = await call(dealGet, "GET", `/api/v1/deals/${did}`, { cookie: agent, params: { id: did } });
    expect(d.json.milestones.find((m: any) => m.key === "contract_signed").status).toBe("done");
    expect((await call(envelopeSimulate, "POST", `/api/v1/signature-envelopes/${eid}/simulate`, { cookie: mgr, params: { id: eid }, body: { signerEmail: signers[0]!.email } })).status).toBe(200); // dev helper, allowed outside production
    delete process.env.WEBHOOK_PROCESS_INLINE;
  });
});

describe("API: finance", () => {
  it("issues an invoice and settles it through a provider payment link and a signed callback", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const { makeUser } = await import("./helpers");
    const fin = await makeUser(t, ["finance_officer"]);
    const cookie = (await mfaSession(t.slug, fin.email)).token;

    const inv = await call(invoicesPost, "POST", "/api/v1/invoices", { cookie, body: { contactId: k.contact.id, dueDate: "2030-01-31", lines: [{ description: "Commission", quantity: 1, unitPrice: 20_000 }] } });
    expect(inv.status).toBe(201);
    expect(inv.json.total).toBe("21000.00");
    expect((await call(invoicesPost, "POST", "/api/v1/invoices", { cookie, body: { contactId: k.contact.id, lines: [] } })).status).toBe(400);
    const id = inv.json.id;
    expect((await call(invoiceIssue, "POST", `/api/v1/invoices/${id}/issue`, { cookie, params: { id } })).json.status).toBe("issued");
    const agent = (await loginAs(t.slug, k.agent.email)).token!;
    expect((await call(invoicesGet, "GET", "/api/v1/invoices", { cookie: agent })).status).toBe(403);

    const link = await call(paymentLinkPost, "POST", "/api/v1/payment-links", { cookie, body: { contactId: k.contact.id, amount: 21_000, invoiceId: id } });
    expect(link.status).toBe(201);
    process.env.WEBHOOK_PROCESS_INLINE = "1";
    const w = buildMockPaymentWebhook({ type: "payment.succeeded", providerRef: link.json.providerRef, amount: 21_000, eventId: "api-pay-1" });
    const send = () => call(paymentWebhook, "POST", "/api/webhooks/payment/mock", { origin: null, params: { provider: "mock" }, raw: w.rawBody, headers: w.headers });
    expect((await send()).json.status).toBe("queued");
    expect((await send()).json.status).toBe("duplicate");
    delete process.env.WEBHOOK_PROCESS_INLINE;

    const paid = await call(invoiceGet, "GET", `/api/v1/invoices/${id}`, { cookie, params: { id } });
    expect(paid.json).toMatchObject({ status: "paid", outstanding: "0.00" });
    const pid = link.json.paymentId;
    const p = await call(paymentGet, "GET", `/api/v1/payments/${pid}`, { cookie, params: { id: pid } });
    expect(p.json).toMatchObject({ status: "succeeded" });
    expect(p.json.receipt.number).toMatch(/^RCT-/);
    void phone;
  });
});

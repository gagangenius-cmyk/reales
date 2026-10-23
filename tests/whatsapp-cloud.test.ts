import { createHmac } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { QueryTypes } from "sequelize";
import { encryptField } from "@reales/auth";
import { approveTemplate, createChannelAccount, createContact, createTemplate, ingestWebhook, recordConsent, sendMessage, listChannelAccounts, MessagingError, processWebhookEvent, splitWhatsAppWebhook, verifyMetaSignature, whatsappHandshake, WhatsAppCloudProvider } from "@reales/domain";
import { closeTestDb, makeTenant, makeUser, testDb, uniq } from "./helpers";
import { phone } from "./deal-helpers";

const sq = () => testDb();
afterAll(closeTestDb);
const SECRET = "meta-test-secret";
const sign = (raw: string) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
const meta = (value: Record<string, unknown>) => JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "971501234567", phone_number_id: "PNID" }, ...value } }] }] });

describe("WhatsApp Cloud provider", () => {
  it("checks Meta's signature and answers the subscription handshake only with the right token", () => {
    const raw = "{\"a\":1}";
    expect(verifyMetaSignature(raw, sign(raw), SECRET)).toBe(true);
    expect(verifyMetaSignature(raw, sign(`${raw} `), SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, "sha256=abc", SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature(raw, sign(raw), "")).toBe(false); // no app secret configured: nothing is trusted
    process.env.META_VERIFY_TOKEN = "vt";
    expect(whatsappHandshake(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "vt", "hub.challenge": "42" }))).toBe("42");
    expect(whatsappHandshake(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "no", "hub.challenge": "42" }))).toBeNull();
  });

  it("splits one delivery into an event per message and status, in the CRM's own format", () => {
    const raw = meta({
      messages: [{ from: "971509998888", id: "wamid.A", timestamp: "1700000000", type: "text", text: { body: "Is it available?" } }, { from: "971509998888", id: "wamid.B", timestamp: "1700000010", type: "image", image: { caption: "the flat", id: "m1" } }],
      statuses: [{ id: "wamid.OUT", status: "delivered", timestamp: "1700000020", recipient_id: "971509998888" }, { id: "wamid.OUT", status: "failed", timestamp: "1700000030", errors: [{ code: 131047, title: "Re-engagement message", message: "More than 24 hours have passed" }] }, { id: "wamid.OUT", status: "deleted", timestamp: "1700000040" }],
    });
    const parts = splitWhatsAppWebhook(raw).map((p) => JSON.parse(p));
    expect(parts).toHaveLength(4); // the unknown "deleted" status is ignored
    expect(parts[0]).toMatchObject({ kind: "inbound", eventId: "wamid.A", from: "+971509998888", to: "+971501234567", body: "Is it available?" });
    expect(parts[1]!.body).toBe("[image] the flat");
    expect(parts[3]).toMatchObject({ kind: "status", status: "failed", error: "More than 24 hours have passed", eventId: "wamid.OUT:failed" });
    const p = new WhatsAppCloudProvider();
    expect(p.parseWebhook(raw).kind).toBe("inbound");
    expect(p.parseWebhook(JSON.stringify(parts[2])).kind).toBe("status");
    expect(() => p.parseWebhook("{}")).toThrow(/Malformed/);
  });

  it("sends text through the Graph API with the account's decrypted token, and tells retryable from permanent failures", async () => {
    const seen: { url: string; init: any }[] = [];
    const reply = (status: number, body: unknown) => (async (url: string, init: any) => { seen.push({ url, init }); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
    const account = { identity: "+971501234567", config: { phoneNumberId: "PNID", accessTokenEnc: encryptField("EAAG-secret-token") } };
    const msg = { channel: "whatsapp" as const, to: "+971 50 999 8888", body: "Hello", idempotencyKey: "k1", from: "+971501234567", account };
    const ok = await new WhatsAppCloudProvider(reply(200, { messages: [{ id: "wamid.SENT" }] })).send(msg);
    expect(ok.providerMessageId).toBe("wamid.SENT");
    expect(seen[0]!.url).toMatch(/\/PNID\/messages$/);
    expect(seen[0]!.init.headers.authorization).toBe("Bearer EAAG-secret-token");
    expect(JSON.parse(seen[0]!.init.body)).toMatchObject({ messaging_product: "whatsapp", to: "971509998888", type: "text", text: { body: "Hello" } });
    const closed = await new WhatsAppCloudProvider(reply(400, { error: { code: 131047, message: "Re-engagement message" } })).send(msg).catch((e) => e);
    expect(closed).toBeInstanceOf(MessagingError);
    expect(closed.retryable).toBe(false);
    expect((await new WhatsAppCloudProvider(reply(503, {})).send(msg).catch((e) => e)).retryable).toBe(true);
    expect((await new WhatsAppCloudProvider(reply(429, {})).send(msg).catch((e) => e)).retryable).toBe(true);
    const noCreds = await new WhatsAppCloudProvider(reply(200, {})).send({ ...msg, account: { identity: "x", config: {} } }).catch((e) => e);
    expect(noCreds.retryable).toBe(false);
    const sms = await new WhatsAppCloudProvider(reply(200, {})).send({ ...msg, channel: "sms" as never }).catch((e) => e);
    expect(sms).toBeInstanceOf(MessagingError);
  });

  it("stores the token encrypted, never returns it, and turns a signed inbound delivery into a contact and conversation", async () => {
    process.env.META_APP_SECRET = SECRET;
    const t = await makeTenant();
    await expect(createChannelAccount(sq(), t.admin, { channel: "whatsapp", provider: "whatsapp_cloud", name: "No token", identity: "+971501234567", config: { phoneNumberId: "PNID" } })).rejects.toThrow(/access token/);
    const acct: any = await createChannelAccount(sq(), t.admin, { channel: "whatsapp", provider: "whatsapp_cloud", name: "Sales", identity: "971 50 123 4567", config: { phoneNumberId: "PNID", accessToken: "EAAG-secret-token" } });
    expect(acct.identity).toBe("+971501234567");
    expect(JSON.stringify(acct)).not.toContain("EAAG-secret-token");
    expect(acct.config.accessTokenEnc).toBeUndefined();
    const [raw] = await sq().query<{ config: string }>("SELECT config FROM channel_accounts WHERE id=:id", { replacements: { id: acct.id }, type: QueryTypes.SELECT });
    expect(JSON.stringify(raw!.config)).not.toContain("EAAG-secret-token");
    const listed: any = await listChannelAccounts(sq(), t.admin);
    expect(listed.accounts[0]).toMatchObject({ provider: "whatsapp_cloud", hasToken: true, phoneNumberId: "PNID" });
    expect(JSON.stringify(listed)).not.toContain("accessTokenEnc");

    const body = meta({ messages: [{ from: "971507776666", id: `wamid.IN${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Hi, I saw your listing" } }] });
    const provider = new WhatsAppCloudProvider();
    expect(provider.verifyWebhook(body, { "x-hub-signature-256": sign(body) })).toBe(true);
    expect(provider.verifyWebhook(body, { "x-hub-signature-256": "sha256=00" })).toBe(false);
    const parts = provider.splitWebhook(body);
    expect(parts).toHaveLength(1);
    const r = await ingestWebhook(sq(), { kind: "messaging", provider: "whatsapp_cloud", rawBody: parts[0]!, headers: {}, verified: true });
    expect(r.status).toBe("queued");
    expect(r.tenantId).toBe(t.tenantId);
    await processWebhookEvent(sq(), r.id!);
    const convs = await sq().query<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE tenant_id=:t AND channel='whatsapp'", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    expect(convs[0]!.n).toBe(1);
    const again = await ingestWebhook(sq(), { kind: "messaging", provider: "whatsapp_cloud", rawBody: parts[0]!, headers: {}, verified: true });
    expect(again.status).toBe("duplicate"); // Meta retries are harmless
  });
});

describe("WhatsApp templates outside the 24-hour window", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sends an approved template as a Meta template with its variables in order, and plain text when no Meta name is set", async () => {
    const t = await makeTenant();
    await createChannelAccount(sq(), t.admin, { channel: "whatsapp", provider: "whatsapp_cloud", name: "Sales", identity: "+971500000001", config: { phoneNumberId: "PNID", accessToken: "tok" } });
    const contact = await createContact(sq(), t.admin, { firstName: "Noor", phone: phone() });
    await recordConsent(sq(), t.admin, { contactId: contact.id, purposeCode: "marketing", channel: "whatsapp", granted: true });
    const maker = await makeUser(t, ["branch_manager"]);
    const calls: any[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ messages: [{ id: `wamid.${calls.length}` }] }), { status: 200 }); });
    const withMeta: any = await createTemplate(sq(), maker.ctx, { name: uniq("m"), channel: "whatsapp", components: { body: { text: "Hi {{ contact.first_name }}, {{ listing.title }} is at {{ listing.price }}" }, meta: { name: "new_listing_alert", language: "en" } } });
    await approveTemplate(sq(), t.admin, withMeta.id, "approved");
    const base = { contactId: contact.id, channel: "whatsapp" as const, purposeCode: "marketing", values: { contact: { first_name: "Noor" }, listing: { title: "Marina 2BR", price: 2100000 } } };
    const r = await sendMessage(sq(), t.admin, { ...base, templateVersionId: withMeta.currentVersionId, idempotencyKey: uniq("t") });
    expect(r.status).toBe("sent");
    expect(calls[0]).toMatchObject({ type: "template", template: { name: "new_listing_alert", language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: "Noor" }, { type: "text", text: "Marina 2BR" }, { type: "text", text: "2,100,000" }] }] } });
    const plain: any = await createTemplate(sq(), maker.ctx, { name: uniq("p"), channel: "whatsapp", components: { body: { text: "Hi {{ contact.first_name }}" } } });
    await approveTemplate(sq(), t.admin, plain.id, "approved");
    await sendMessage(sq(), t.admin, { ...base, templateVersionId: plain.currentVersionId, idempotencyKey: uniq("t") });
    expect(calls[1]).toMatchObject({ type: "text", text: { body: "Hi Noor" } });
  });
});

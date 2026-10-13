import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  addTemplateVersion, applyDeliveryStatus, approveTemplate, buildMockMessagingWebhook, createChannelAccount, createContact, createTemplate, extractVariables, getConversation,
  listConversations, mockMessaging, NotFoundError, previewTemplate, receiveInbound, recordConsent, renderTemplate, sendMessage, sendUserMessage, smsStats, TemplateInvalidError,
  validateContent, MissingVariableError, evaluateContactability,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, makeTenant, makeUser, testDb, uniq } from "./helpers";
import { agentIn, makeOrg } from "./brokerage-helpers";
import { phone } from "./deal-helpers";

afterAll(closeTestDb);
beforeEach(() => mockMessaging.reset());
const sq = () => testDb();

describe("template variables and rendering", () => {
  it("only allows catalogue variables and rejects malformed or unknown ones", () => {
    expect(extractVariables("Hi {{ contact.first_name }}, {{unit.price}}").vars).toEqual(["contact.first_name", "unit.price"]);
    const bad = extractVariables("{{ contact.password_hash }} {{ __proto__.x }} {{ nope }} {{contact.first_name.length}}");
    expect(bad.issues.map((i) => i.code)).toEqual(["variable_unknown", "variable_unknown", "variable_malformed", "variable_malformed"]);
  });

  it("renders with money formatting, escapes HTML values and refuses to send blanks", () => {
    expect(renderTemplate("Price {{ listing.price }}", { listing: { price: 2100000 } })).toBe("Price 2,100,000");
    expect(renderTemplate("<p>{{ contact.first_name }}</p>", { contact: { first_name: "<img src=x onerror=1>" } }, { html: true })).toBe("<p>&lt;img src=x onerror=1&gt;</p>");
    expect(() => renderTemplate("Dear {{ contact.first_name }}", { contact: {} })).toThrow(MissingVariableError);
    expect(() => renderTemplate("{{ contact.constructor }}", { contact: {} })).toThrow(/Unknown template variable/);
    expect(renderTemplate("{{ contact.first_name }}", { contact: { ["__proto__" as string]: "x", first_name: "A" } })).toBe("A");
  });

  it("computes SMS encoding and segments, with Arabic forcing UCS-2", () => {
    expect(smsStats("Hello")).toEqual({ encoding: "GSM-7", length: 5, segments: 1 });
    expect(smsStats("a".repeat(161)).segments).toBe(2);
    expect(smsStats("{}").length).toBe(4); // extension characters cost two units
    expect(smsStats("مرحبا بكم").encoding).toBe("UCS-2");
    expect(smsStats("م".repeat(71)).segments).toBe(2);
  });

  it("validates each channel against what it can carry", () => {
    const codes = (c: Parameters<typeof validateContent>[0]) => validateContent(c).issues.map((i) => i.code);
    expect(codes({ channel: "email", subject: "", html: "<p>x</p>" })).toContain("email_subject_missing");
    expect(codes({ channel: "email", subject: "Hi", html: "<script>alert(1)</script>" })).toContain("email_active_content");
    expect(codes({ channel: "email", subject: "Hi\nBcc: x", text: "x" })).toContain("email_subject_newline");
    expect(codes({ channel: "sms", text: "x".repeat(700) })).toContain("sms_too_long");
    expect(codes({ channel: "whatsapp", components: { body: { text: "x".repeat(1100) } } })).toContain("wa_body_too_long");
    expect(codes({ channel: "whatsapp", components: { body: { text: "ok" }, buttons: [{ type: "url", text: "Go", url: "http://insecure" }] } })).toContain("wa_button_url");
    expect(validateContent({ channel: "sms", text: "Hi {{ contact.first_name }}" })).toEqual({ issues: [], variables: ["contact.first_name"] });
  });
});

describe("template lifecycle", () => {
  it("versions immutably, requires a different approver for WhatsApp, and resets approval on edit", async () => {
    const t = await makeTenant();
    const author = await makeUser(t, ["branch_manager"]);
    const wa = await createTemplate(sq(), author.ctx, { name: uniq("welcome"), channel: "whatsapp", purpose: "marketing", components: { body: { text: "Hi {{ contact.first_name }}" } } });
    expect(wa).toMatchObject({ status: "draft" });
    expect(wa.versions[0]).toMatchObject({ version: 1, approvalStatus: "pending", variableSchemaJson: { "contact.first_name": { type: "string", required: true } } });
    await expect(approveTemplate(sq(), author.ctx, wa.id, "approved")).rejects.toThrow(/different person/);
    expect((await approveTemplate(sq(), t.admin, wa.id, "approved")).status).toBe("approved");

    const v2 = await addTemplateVersion(sq(), author.ctx, wa.id, { components: { body: { text: "Hello {{ contact.first_name }}, new offers" } } });
    expect(v2.status).toBe("draft"); // edit withdraws approval
    expect(v2.versions.map((v: any) => v.version)).toEqual([1, 2]);
    await expect(sq().query("DELETE FROM template_versions WHERE tenant_id=:t", { replacements: { t: t.tenantId } })).rejects.toThrow(/append-only/);

    const sms = await createTemplate(sq(), author.ctx, { name: uniq("sms"), channel: "sms", text: "Hi" });
    expect((await approveTemplate(sq(), t.admin, sms.id, "approved")).status).toBe("approved");
    await expect(createTemplate(sq(), author.ctx, { name: sms.name, channel: "sms", text: "dup" })).rejects.toThrow(/already exists/);
    await expect(createTemplate(sq(), author.ctx, { name: uniq("x"), channel: "email", subject: "", html: "" })).rejects.toBeInstanceOf(TemplateInvalidError);
    const agent = await makeUser(t, ["agent"]);
    await expect(createTemplate(sq(), agent.ctx, { name: uniq("y"), channel: "sms", text: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    const prev = await previewTemplate(sq(), agent.ctx, sms.id, {});
    expect(prev.body).toBe("Hi");
    const other = await makeTenant();
    await expect(previewTemplate(sq(), other.admin, sms.id, {})).rejects.toBeInstanceOf(NotFoundError);
  });
});

async function setup() {
  const t = await makeTenant();
  const org = await makeOrg(t);
  const agent = await agentIn(t, org.marina.id, org.bu.id);
  const stranger = await agentIn(t, org.marina.id, org.bu.id);
  for (const ch of ["whatsapp", "sms", "email"] as const) await createChannelAccount(sq(), t.admin, { channel: ch, provider: "mock", name: ch, identity: ch === "email" ? "no-reply@demo.test" : "+971400000000" });
  const contact = await createContact(sq(), agent.ctx, { firstName: "Noor", phone: phone(), email: `${uniq("n")}@x.test` });
  const consent = (channel: any, granted = true) => recordConsent(sq(), t.admin, { contactId: contact.id, purposeCode: "marketing", channel, granted });
  return { t, agent, stranger, contact, consent };
}

describe("outbound sending", () => {
  it("is blocked without consent, sent with it, replayed idempotently, and blocked again after suppression", async () => {
    const { t, agent, contact, consent } = await setup();
    const base = { contactId: contact.id, channel: "sms" as const, purposeCode: "marketing", body: "Hello Noor" };
    const blocked = await sendMessage(sq(), t.admin, { ...base, idempotencyKey: "k1" });
    expect(blocked).toMatchObject({ status: "blocked", blockedReasons: ["no_consent"] });
    expect(mockMessaging.sent).toHaveLength(0);

    await consent("sms");
    const ok = await sendMessage(sq(), t.admin, { ...base, idempotencyKey: "k2" });
    expect(ok.status).toBe("sent");
    expect(mockMessaging.sent).toHaveLength(1);
    expect(mockMessaging.sent[0]).toMatchObject({ to: contact.phoneE164, body: "Hello Noor" });
    const replay = await sendMessage(sq(), t.admin, { ...base, idempotencyKey: "k2" });
    expect(replay).toMatchObject({ status: "sent", replayed: true, messageId: ok.messageId });
    expect(mockMessaging.sent).toHaveLength(1);

    await consent("sms", false);
    expect((await sendMessage(sq(), t.admin, { ...base, idempotencyKey: "k3" })).status).toBe("blocked");
    void agent;
  });

  it("retries a transient provider failure with the same key without duplicating, and records permanent failures", async () => {
    const { t, contact, consent } = await setup();
    await consent("sms");
    const base = { contactId: contact.id, channel: "sms" as const, purposeCode: "marketing", body: "Hi" };
    mockMessaging.failNext(1, true);
    const first = await sendMessage(sq(), t.admin, { ...base, idempotencyKey: "retry" });
    expect(first).toMatchObject({ status: "queued", retryable: true });
    const second = await sendMessage(sq(), t.admin, { ...base, idempotencyKey: "retry" });
    expect(second).toMatchObject({ status: "sent", messageId: first.messageId });
    const rows = await sq().query<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE tenant_id=:t AND idempotency_key='retry'", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    expect(Number(rows[0]!.n)).toBe(1);

    mockMessaging.failNext(1, false, "invalid number");
    const dead = await sendMessage(sq(), t.admin, { ...base, idempotencyKey: "dead" });
    expect(dead).toMatchObject({ status: "failed", retryable: false });
    expect((await sendMessage(sq(), t.admin, { ...base, idempotencyKey: "dead" })).status).toBe("failed"); // terminal: not retried
  });

  it("enforces the WhatsApp 24-hour rule and approved templates", async () => {
    const { t, contact, consent } = await setup();
    await consent("whatsapp");
    const base = { contactId: contact.id, channel: "whatsapp" as const, purposeCode: "marketing" };
    await expect(sendMessage(sq(), t.admin, { ...base, body: "free text", idempotencyKey: "wa1" })).rejects.toThrow(/24 hours/);

    const tpl = await createTemplate(sq(), t.admin, { name: uniq("wa"), channel: "whatsapp", components: { body: { text: "Hi {{ contact.first_name }}, new listings" } } });
    const versionId = tpl.currentVersionId;
    await expect(sendMessage(sq(), t.admin, { ...base, templateVersionId: versionId, values: { contact: { first_name: "Noor" } }, idempotencyKey: "wa2" })).rejects.toThrow(/approved/);
    const maker = await makeUser(t, ["branch_manager"]);
    const tpl2 = await createTemplate(sq(), maker.ctx, { name: uniq("wa2"), channel: "whatsapp", components: { body: { text: "Hi {{ contact.first_name }}" } } });
    await approveTemplate(sq(), t.admin, tpl2.id, "approved");
    const sent = await sendMessage(sq(), t.admin, { ...base, templateVersionId: tpl2.currentVersionId, values: { contact: { first_name: "Noor" } }, idempotencyKey: "wa3" });
    expect(sent.status).toBe("sent");
    expect(mockMessaging.sent[0]!.body).toBe("Hi Noor");
    await expect(sendMessage(sq(), t.admin, { ...base, templateVersionId: tpl2.currentVersionId, values: {}, idempotencyKey: "wa4" })).rejects.toBeInstanceOf(MissingVariableError);

    // After the customer writes, a free-form reply is allowed
    await receiveInbound(sq(), t.tenantId, { eventId: "e1", channel: "whatsapp", from: contact.phoneE164, body: "Interested!", providerMessageId: "in-1", occurredAt: new Date().toISOString() }, "mock");
    expect((await sendMessage(sq(), t.admin, { ...base, body: "Great, a call tomorrow?", idempotencyKey: "wa5" })).status).toBe("sent");
  });

  it("lets only authorised users message a contact they can see", async () => {
    const { t, agent, stranger, contact, consent } = await setup();
    await consent("sms");
    await expect(sendUserMessage(sq(), stranger.ctx, { contactId: contact.id, channel: "sms", purposeCode: "marketing", body: "hi" })).rejects.toBeInstanceOf(NotFoundError);
    const r = await sendUserMessage(sq(), agent.ctx, { contactId: contact.id, channel: "sms", purposeCode: "marketing", body: "hi" });
    expect(r.status).toBe("sent");
    const foreign = await makeTenant();
    await expect(sendUserMessage(sq(), foreign.admin, { contactId: contact.id, channel: "sms", purposeCode: "marketing", body: "hi" })).rejects.toBeInstanceOf(NotFoundError);
    void t;
  });
});

describe("inbound messages, opt-out and delivery status", () => {
  it("creates a contact and conversation for a new number, scopes the inbox and counts unread", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const agent = await agentIn(t, org.marina.id, org.bu.id);
    await createChannelAccount(sq(), t.admin, { channel: "whatsapp", provider: "mock", name: "wa", identity: "+971400000000" });
    const number = `+9715${Math.floor(10000000 + Math.random() * 89999999)}`;
    const ev = (id: string, body: string) => ({ eventId: id, channel: "whatsapp" as const, from: number, body, providerMessageId: id, occurredAt: new Date().toISOString() });
    const a = await receiveInbound(sq(), t.tenantId, ev("m1", "Hello, is the Marina unit available?"), "mock");
    expect(a).toMatchObject({ optedOut: false, duplicate: false });
    expect((await receiveInbound(sq(), t.tenantId, ev("m1", "dup"), "mock")).duplicate).toBe(true);
    await receiveInbound(sq(), t.tenantId, ev("m2", "Anyone there?"), "mock");
    const [conv] = await listConversations(sq(), t.admin, { limit: 10, offset: 0 });
    expect(conv).toMatchObject({ unreadCount: 2, channel: "whatsapp" });
    expect((await listConversations(sq(), agent.ctx, { limit: 10, offset: 0 }))).toEqual([]); // unassigned conversations are not in an agent's inbox
    const detail = await getConversation(sq(), t.admin, conv.id);
    expect(detail.messages.map((m: any) => m.body)).toEqual(["Hello, is the Marina unit available?", "Anyone there?"]);
    expect((await getConversation(sq(), t.admin, conv.id)).unreadCount).toBe(0);
    const foreign = await makeTenant();
    await expect(getConversation(sq(), foreign.admin, conv.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("treats STOP (English or Arabic) as an immediate opt-out: consent revoked and destination suppressed", async () => {
    const { t, contact, consent } = await setup();
    await consent("sms");
    expect((await evaluateContactability(sq(), t.tenantId, { contactId: contact.id, channel: "sms", purposeCode: "marketing" })).allowed).toBe(true);
    const r = await receiveInbound(sq(), t.tenantId, { eventId: "s1", channel: "sms", from: contact.phoneE164, body: "  STOP ", providerMessageId: "stop-1", occurredAt: new Date().toISOString() }, "mock");
    expect(r.optedOut).toBe(true);
    const gate = await evaluateContactability(sq(), t.tenantId, { contactId: contact.id, channel: "sms", purposeCode: "marketing" });
    expect(gate.allowed).toBe(false);
    expect(gate.reasons).toEqual(expect.arrayContaining(["suppressed:unsubscribed", "no_consent"]));
    const other = await createContact(sq(), t.admin, { firstName: "Layla", phone: phone() });
    const ar = await receiveInbound(sq(), t.tenantId, { eventId: "s2", channel: "sms", from: other.phoneE164, body: "الغاء", providerMessageId: "stop-2", occurredAt: new Date().toISOString() }, "mock");
    expect(ar.optedOut).toBe(true);
    const notStop = await receiveInbound(sq(), t.tenantId, { eventId: "s3", channel: "sms", from: other.phoneE164, body: "please don't stop the updates", providerMessageId: "stop-3", occurredAt: new Date().toISOString() }, "mock");
    expect(notStop.optedOut).toBe(false);
  });

  it("only moves delivery status forward and keeps raw events", async () => {
    const { t, contact, consent } = await setup();
    await consent("sms");
    const sent = await sendMessage(sq(), t.admin, { contactId: contact.id, channel: "sms", purposeCode: "marketing", body: "x", idempotencyKey: "d1" });
    const [row] = await sq().query<{ provider_message_id: string }>("SELECT provider_message_id FROM messages WHERE id=:id", { replacements: { id: sent.messageId }, type: QueryTypes.SELECT });
    const pm = row!.provider_message_id;
    const ev = (status: any, id: string) => ({ eventId: id, providerMessageId: pm, status, occurredAt: new Date().toISOString() });
    expect(await applyDeliveryStatus(sq(), t.tenantId, ev("delivered", "a"), "mock")).toBe("applied");
    expect(await applyDeliveryStatus(sq(), t.tenantId, ev("sent", "b"), "mock")).toBe("ignored"); // late "sent" cannot undo "delivered"
    expect(await applyDeliveryStatus(sq(), t.tenantId, ev("read", "c"), "mock")).toBe("applied");
    expect(await applyDeliveryStatus(sq(), t.tenantId, ev("failed", "d"), "mock")).toBe("ignored"); // a read message cannot fail
    const status = (await sq().query<{ status: string }>("SELECT status FROM messages WHERE id=:id", { replacements: { id: sent.messageId }, type: QueryTypes.SELECT }))[0]!.status;
    expect(status).toBe("read");
    const events = await sq().query<{ n: number }>("SELECT COUNT(*) n FROM message_events WHERE tenant_id=:t AND message_id=:m", { replacements: { t: t.tenantId, m: sent.messageId }, type: QueryTypes.SELECT });
    expect(Number(events[0]!.n)).toBe(4);
    void buildMockMessagingWebhook;
  });
});

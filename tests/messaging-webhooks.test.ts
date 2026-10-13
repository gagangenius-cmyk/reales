import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  buildMockMessagingWebhook, createChannelAccount, createContact, ingestWebhook, listConversations, mockMessaging, processWebhookEvent, recordConsent, sendMessage, WebhookSignatureError,
} from "@reales/domain";
import { closeTestDb, makeTenant, testDb } from "./helpers";
import { phone } from "./deal-helpers";

afterAll(closeTestDb);
beforeEach(() => mockMessaging.reset());
const sq = () => testDb();
const deliver = async (w: { rawBody: string; headers: Record<string, string> }) => {
  const r = await ingestWebhook(sq(), { kind: "messaging", provider: "mock", rawBody: w.rawBody, headers: w.headers });
  return { ingest: r, processed: r.id && r.status === "queued" ? await processWebhookEvent(sq(), r.id) : null };
};

describe("messaging webhooks", () => {
  it("routes inbound messages to the tenant that owns the receiving number, and ignores unknown numbers", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const numA = `+9714${Math.floor(1000000 + Math.random() * 8999999)}`;
    const numB = `+9714${Math.floor(1000000 + Math.random() * 8999999)}`;
    await createChannelAccount(sq(), a.admin, { channel: "whatsapp", provider: "mock", name: "A", identity: numA });
    await createChannelAccount(sq(), b.admin, { channel: "whatsapp", provider: "mock", name: "B", identity: numB });
    const from = `+9715${Math.floor(10000000 + Math.random() * 89999999)}`;
    const r = await deliver(buildMockMessagingWebhook({ kind: "inbound", channel: "whatsapp", from, to: numA, body: "Hello", providerMessageId: `in-${Math.random()}` }));
    expect(r.processed).toMatchObject({ status: "processed", outcome: "received" });
    expect((await listConversations(sq(), a.admin, { limit: 10, offset: 0 })).length).toBe(1);
    expect(await listConversations(sq(), b.admin, { limit: 10, offset: 0 })).toEqual([]);
    expect((await deliver(buildMockMessagingWebhook({ kind: "inbound", channel: "whatsapp", from, to: "+97140000000", body: "x", providerMessageId: "in-unknown" }))).ingest.status).toBe("ignored");
  });

  it("applies delivery status callbacks, dedupes them, and rejects forged ones", async () => {
    const t = await makeTenant();
    await createChannelAccount(sq(), t.admin, { channel: "sms", provider: "mock", name: "s", identity: "+971400000001" });
    const c = await createContact(sq(), t.admin, { firstName: "D", phone: phone() });
    await recordConsent(sq(), t.admin, { contactId: c.id, purposeCode: "marketing", channel: "sms", granted: true });
    const sent = await sendMessage(sq(), t.admin, { contactId: c.id, channel: "sms", purposeCode: "marketing", body: "hi", idempotencyKey: "wh1" });
    const [m] = await sq().query<{ provider_message_id: string }>("SELECT provider_message_id FROM messages WHERE id=:id", { replacements: { id: sent.messageId }, type: QueryTypes.SELECT });
    const w = buildMockMessagingWebhook({ kind: "status", providerMessageId: m!.provider_message_id, status: "delivered" });
    expect((await deliver(w)).processed).toMatchObject({ outcome: "applied" });
    expect((await deliver(w)).ingest.status).toBe("duplicate");
    await expect(ingestWebhook(sq(), { kind: "messaging", provider: "mock", rawBody: w.rawBody, headers: { "x-mock-signature": "00".repeat(32) } })).rejects.toBeInstanceOf(WebhookSignatureError);
    const status = (await sq().query<{ status: string }>("SELECT status FROM messages WHERE id=:id", { replacements: { id: sent.messageId }, type: QueryTypes.SELECT }))[0]!.status;
    expect(status).toBe("delivered");
  });
});

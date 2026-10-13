import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  addSuppression, applyDeliveryStatus, approveTemplate, cancelCampaign, campaignFunnel, createCampaign, createChannelAccount, createContact, createLead, createSegment, createTemplate,
  getCampaign, mockMessaging, pauseCampaign, prepareCampaign, previewSegment, receiveInbound, recordConsent, resumeCampaign, runCampaignBatch, scheduleCampaign, tickCampaigns,
  validateSegment, NotFoundError, listCampaigns,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, makeTenant, makeUser, testDb, uniq } from "./helpers";
import { phone } from "./deal-helpers";

afterAll(closeTestDb);
beforeEach(() => mockMessaging.reset());
const sq = () => testDb();

async function kit(opts: { contacts?: number; consentFor?: number; channel?: "sms" | "whatsapp" | "email" } = {}) {
  const t = await makeTenant();
  const channel = opts.channel ?? "sms";
  const acct = await createChannelAccount(sq(), t.admin, { channel, provider: "mock", name: "main", identity: "+971400000000" });
  const manager = await makeUser(t, ["branch_manager"]);
  const tpl = await createTemplate(sq(), manager.ctx, { name: uniq("promo"), channel, purpose: "marketing", ...(channel === "email" ? { subject: "Offers for {{ contact.first_name }}", html: "<p>Hi {{ contact.first_name }}</p>" } : channel === "whatsapp" ? { components: { body: { text: "Hi {{ contact.first_name }}" } } } : { text: "Hi {{ contact.first_name }}, new Marina units" }) });
  await approveTemplate(sq(), t.admin, tpl.id, "approved");
  const seg = await createSegment(sq(), manager.ctx, { name: uniq("all"), definition: { language: ["en"] } });
  const n = opts.contacts ?? 5;
  const contacts: any[] = [];
  for (let i = 0; i < n; i++) {
    const c = await createContact(sq(), t.admin, { firstName: `P${i}`, phone: phone(), email: `${uniq("p")}@x.test`, language: "en" });
    if (i < (opts.consentFor ?? n)) await recordConsent(sq(), t.admin, { contactId: c.id, purposeCode: "marketing", channel, granted: true });
    contacts.push(c);
  }
  const campaign = await createCampaign(sq(), manager.ctx, { name: uniq("camp"), channel, templateVersionId: tpl.currentVersionId, segmentId: seg.id, channelAccountId: acct.id, purposeCode: "marketing", maxPerMinute: 1000 });
  return { t, manager, tpl, seg, contacts, campaign, acct, channel };
}
const start = async (k: Awaited<ReturnType<typeof kit>>) => {
  await scheduleCampaign(sq(), k.manager.ctx, k.campaign.id);
  return prepareCampaign(sq(), k.manager.ctx, k.campaign.id);
};
const counts = async (tenantId: string, id: string) => Object.fromEntries((await sq().query<{ status: string; n: number }>("SELECT status, COUNT(*) n FROM campaign_recipients WHERE tenant_id=:t AND campaign_id=:c GROUP BY status", { replacements: { t: tenantId, c: id }, type: QueryTypes.SELECT })).map((r) => [r.status, Number(r.n)]));

describe("segments", () => {
  it("rejects unknown filters and resolves audiences declaratively", async () => {
    const t = await makeTenant();
    expect(() => validateSegment({ "1=1; DROP TABLE contacts": true })).toThrow(/Unknown segment filter/);
    expect(() => validateSegment([])).toThrow();
    await createContact(sq(), t.admin, { firstName: "A", phone: phone(), language: "ar" });
    await createContact(sq(), t.admin, { firstName: "B", phone: phone(), language: "en" });
    expect((await previewSegment(sq(), t.admin, { language: ["ar"] })).count).toBe(1);
    expect((await previewSegment(sq(), t.admin, {})).count).toBe(2);
    await createLead(sq(), t.admin, { contact: { firstName: "C", phone: phone(), language: "en" }, purpose: "buy", sourceCode: "website", budgetMax: 3_000_000 });
    expect((await previewSegment(sq(), t.admin, { hasOpenLead: true, leadPurpose: ["buy"], budgetMin: 2_000_000 })).count).toBe(1);
    expect((await previewSegment(sq(), t.admin, { hasOpenLead: false })).count).toBe(2);
    const agent = await makeUser(t, ["agent"]);
    await expect(previewSegment(sq(), agent.ctx, {})).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("broadcast engine", () => {
  it("snapshots the audience, skips people without consent with a recorded reason, and sends exactly once to the rest", async () => {
    const k = await kit({ contacts: 6, consentFor: 4 });
    await addSuppression(sq(), k.t.admin, { channel: "sms", destination: k.contacts[0].phoneE164, reason: "complaint" });
    const prepared = await start(k);
    expect(prepared).toMatchObject({ status: "running", totals: { audience: 6, pending: 3, skipped: 3 } });
    let r = await runCampaignBatch(sq(), k.t.tenantId, k.campaign.id, 50);
    expect(r).toMatchObject({ sent: 3, completed: true });
    expect(mockMessaging.sent).toHaveLength(3);
    expect(mockMessaging.sent.every((m) => /^Hi P\d, new Marina units$/.test(m.body))).toBe(true);
    r = await runCampaignBatch(sq(), k.t.tenantId, k.campaign.id, 50); // already completed: no resend
    expect(r.processed).toBe(0);
    expect(mockMessaging.sent).toHaveLength(3);

    const detail = await getCampaign(sq(), k.manager.ctx, k.campaign.id);
    expect(detail.status).toBe("completed");
    expect(detail.skippedByReason).toEqual({ no_consent: 2, "suppressed:complaint": 1 });
    expect(detail.events.map((e: any) => e.type)).toEqual(["created", "scheduled", "started", "completed"]);
    expect((await counts(k.t.tenantId, k.campaign.id)).sent).toBe(3);
  });

  it("re-checks consent at send time: someone who opts out after prepare is not messaged", async () => {
    const k = await kit({ contacts: 3 });
    await start(k);
    await recordConsent(sq(), k.t.admin, { contactId: k.contacts[1].id, purposeCode: "marketing", channel: "sms", granted: false, suppress: true });
    const r = await runCampaignBatch(sq(), k.t.tenantId, k.campaign.id, 50);
    expect(r).toMatchObject({ sent: 2, skipped: 1, completed: true });
    expect(mockMessaging.sent.map((m) => m.to)).not.toContain(k.contacts[1].phoneE164);
  });

  it("is not affected by contacts joining the segment after prepare (immutable audience)", async () => {
    const k = await kit({ contacts: 2 });
    await start(k);
    const late = await createContact(sq(), k.t.admin, { firstName: "Late", phone: phone(), language: "en" });
    await recordConsent(sq(), k.t.admin, { contactId: late.id, purposeCode: "marketing", channel: "sms", granted: true });
    await runCampaignBatch(sq(), k.t.tenantId, k.campaign.id, 50);
    expect(mockMessaging.sent).toHaveLength(2);
    expect(mockMessaging.sent.map((m) => m.to)).not.toContain(late.phoneE164);
  });

  it("throttles to maxPerMinute and resumes on the next tick", async () => {
    const k = await kit({ contacts: 5 });
    await sq().query("UPDATE campaigns SET max_per_minute=2 WHERE id=:id", { replacements: { id: k.campaign.id } });
    await start(k);
    const a = await runCampaignBatch(sq(), k.t.tenantId, k.campaign.id, 50);
    expect(a.sent).toBe(2);
    const b = await runCampaignBatch(sq(), k.t.tenantId, k.campaign.id, 50);
    expect(b).toMatchObject({ sent: 0, throttled: true, completed: false });
    await sq().query("UPDATE campaign_recipients SET sent_at = DATE_SUB(NOW(3), INTERVAL 2 MINUTE) WHERE campaign_id=:id AND status='sent'", { replacements: { id: k.campaign.id } });
    expect((await runCampaignBatch(sq(), k.t.tenantId, k.campaign.id, 50)).sent).toBe(2);
  });

  it("pauses, resumes and cancels, and never sends while paused", async () => {
    const k = await kit({ contacts: 4 });
    await start(k);
    await pauseCampaign(sq(), k.manager.ctx, k.campaign.id);
    expect((await runCampaignBatch(sq(), k.t.tenantId, k.campaign.id, 50)).processed).toBe(0);
    expect(mockMessaging.sent).toHaveLength(0);
    await expect(pauseCampaign(sq(), k.manager.ctx, k.campaign.id)).rejects.toThrow(/cannot be paused/);
    await resumeCampaign(sq(), k.manager.ctx, k.campaign.id);
    await runCampaignBatch(sq(), k.t.tenantId, k.campaign.id, 2);
    expect(mockMessaging.sent).toHaveLength(2);
    await expect(cancelCampaign(sq(), k.manager.ctx, k.campaign.id, " ")).rejects.toThrow(/reason/);
    const c = await cancelCampaign(sq(), k.manager.ctx, k.campaign.id, "wrong audience");
    expect(c.status).toBe("cancelled");
    expect((await runCampaignBatch(sq(), k.t.tenantId, k.campaign.id, 50)).processed).toBe(0);
    expect(mockMessaging.sent).toHaveLength(2);
  });

  it("retries transient provider failures later and gives up on permanent ones", async () => {
    const k = await kit({ contacts: 3 });
    await start(k);
    mockMessaging.failNext(1, true);
    mockMessaging.failNext(1, false, "number not on WhatsApp");
    const a = await runCampaignBatch(sq(), k.t.tenantId, k.campaign.id, 50);
    expect(a).toMatchObject({ sent: 1, deferred: 1, failed: 1, completed: false });
    const b = await runCampaignBatch(sq(), k.t.tenantId, k.campaign.id, 50);
    expect(b).toMatchObject({ sent: 1, completed: true });
    expect(mockMessaging.sent).toHaveLength(2);
    expect(await counts(k.t.tenantId, k.campaign.id)).toMatchObject({ sent: 2, failed: 1 });
  });

  it("never double-sends with concurrent workers, and recovers recipients stuck in `sending` after a crash", async () => {
    const k = await kit({ contacts: 12 });
    await start(k);
    await Promise.all([runCampaignBatch(sq(), k.t.tenantId, k.campaign.id, 6), runCampaignBatch(sq(), k.t.tenantId, k.campaign.id, 6), runCampaignBatch(sq(), k.t.tenantId, k.campaign.id, 6)]);
    for (let i = 0; i < 5; i++) await runCampaignBatch(sq(), k.t.tenantId, k.campaign.id, 6);
    expect(mockMessaging.sent).toHaveLength(12);
    expect(new Set(mockMessaging.sent.map((m) => m.to)).size).toBe(12);

    const k2 = await kit({ contacts: 2 });
    await start(k2);
    await sq().query("UPDATE campaign_recipients SET status='sending', updated_at = DATE_SUB(NOW(3), INTERVAL 10 MINUTE) WHERE campaign_id=:id", { replacements: { id: k2.campaign.id } });
    mockMessaging.reset();
    expect((await runCampaignBatch(sq(), k2.t.tenantId, k2.campaign.id, 50)).sent).toBe(2);
  });

  it("tracks delivery, replies and the downstream funnel without inferring conversion from a reply", async () => {
    const k = await kit({ contacts: 2 });
    await start(k);
    await runCampaignBatch(sq(), k.t.tenantId, k.campaign.id, 50);
    const rows = await sq().query<{ provider_message_id: string }>("SELECT provider_message_id FROM messages WHERE tenant_id=:t AND campaign_id=:c", { replacements: { t: k.t.tenantId, c: k.campaign.id }, type: QueryTypes.SELECT });
    await applyDeliveryStatus(sq(), k.t.tenantId, { eventId: "d1", providerMessageId: rows[0]!.provider_message_id, status: "delivered", occurredAt: new Date().toISOString() }, "mock");
    await applyDeliveryStatus(sq(), k.t.tenantId, { eventId: "d2", providerMessageId: rows[1]!.provider_message_id, status: "read", occurredAt: new Date().toISOString() }, "mock");
    await receiveInbound(sq(), k.t.tenantId, { eventId: "r1", channel: "sms", from: k.contacts[0].phoneE164, body: "Tell me more", providerMessageId: "reply-1", occurredAt: new Date().toISOString() }, "mock");
    await createLead(sq(), k.t.admin, { contactId: k.contacts[0].id, purpose: "buy", sourceCode: "whatsapp" });
    const f = await campaignFunnel(sq(), k.manager.ctx, k.campaign.id);
    expect(f).toMatchObject({ sent: 2, delivered: 2, replied: 1, leads: 1, viewings: 0, deals: 0 });
  });

  it("guards creation and visibility: approved templates only, matching channel, tenant isolation", async () => {
    const k = await kit({ contacts: 1 });
    const draft = await createTemplate(sq(), k.manager.ctx, { name: uniq("wa"), channel: "whatsapp", components: { body: { text: "x" } } });
    await expect(createCampaign(sq(), k.manager.ctx, { name: "x", channel: "whatsapp", templateVersionId: draft.currentVersionId, segmentId: k.seg.id, channelAccountId: k.acct.id, purposeCode: "marketing" })).rejects.toThrow(/approved/);
    await expect(createCampaign(sq(), k.manager.ctx, { name: "x", channel: "email", templateVersionId: k.tpl.currentVersionId, segmentId: k.seg.id, channelAccountId: k.acct.id, purposeCode: "marketing" })).rejects.toThrow(/different channel/);
    await expect(createCampaign(sq(), k.manager.ctx, { name: "x", channel: "sms", templateVersionId: k.tpl.currentVersionId, segmentId: k.seg.id, channelAccountId: k.acct.id, purposeCode: "nope" })).rejects.toThrow(/purpose/);
    const agent = await makeUser(k.t, ["agent"]);
    await expect(listCampaigns(sq(), agent.ctx)).rejects.toBeInstanceOf(ForbiddenError);
    const other = await makeTenant();
    await expect(getCampaign(sq(), other.admin, k.campaign.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(scheduleCampaign(sq(), other.admin, k.campaign.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(prepareCampaign(sq(), k.manager.ctx, k.campaign.id)).rejects.toThrow(/cannot be prepared/); // must be scheduled first
  });

  it("the scheduler tick prepares due campaigns and sends them", async () => {
    const k = await kit({ contacts: 3 });
    await scheduleCampaign(sq(), k.manager.ctx, k.campaign.id, new Date(Date.now() - 1000).toISOString());
    const out = await tickCampaigns(sq(), k.t.tenantId);
    expect(out.find((o) => o.id === k.campaign.id)).toMatchObject({ sent: 3, completed: true });
  });
});

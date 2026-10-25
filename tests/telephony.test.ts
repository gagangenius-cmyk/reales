import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import { createLead, getTelephony, handleTwilioStatus, listCalls, saveTelephony, startCall, twilioConnectXml, twilioSignature, callbackUrl, normalizePhone } from "@reales/domain";
import { closeTestDb, makeTenant, makeUser, testDb, uniq } from "./helpers";
import { phone } from "./deal-helpers";

const sq = () => testDb();
afterAll(closeTestDb);
const SID = `AC${"a".repeat(32)}`, TOKEN = "twilio-secret-token";

async function setup() {
  const t = await makeTenant();
  const agent = await makeUser(t, ["agent"]);
  await saveTelephony(sq(), t.admin, { accountSid: SID, authToken: TOKEN, fromNumber: "+971 4 123 4567" });
  const p = phone();
  const lead = await createLead(sq(), t.admin, { contact: { firstName: uniq("Caller"), phone: p }, purpose: "buy", sourceCode: "walk_in", assignedUserId: agent.id } as any);
  return { t, agent, lead, e164: normalizePhone(p)! };
}
const signed = (tenantId: string, params: Record<string, string>) => twilioSignature(TOKEN, callbackUrl(tenantId), params);

describe("Twilio telephony", () => {
  it("keeps the auth token encrypted and never returns it", async () => {
    const { t } = await setup();
    const shown = await getTelephony(sq(), t.admin);
    expect(shown).toMatchObject({ configured: true, enabled: true, accountSid: SID, fromNumber: "+97141234567" });
    expect(JSON.stringify(shown)).not.toContain(TOKEN);
    const [row] = (await sq().query("SELECT value FROM tenant_settings WHERE tenant_id=:t AND `key`='telephony'", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT })) as any[];
    expect(JSON.stringify(row.value)).not.toContain(TOKEN);
    await expect(saveTelephony(sq(), t.admin, { accountSid: "nope", authToken: "x", fromNumber: "+971501234567" })).rejects.toThrow(/account SID/);
  });

  it("records a finished call once, against the right lead and agent, and ignores bad signatures", async () => {
    const { t, agent, lead, e164 } = await setup();
    const params = { CallSid: `CA${uniq("s")}`, AccountSid: SID, From: e164, To: "+97141234567", Direction: "inbound", CallStatus: "completed", CallDuration: "125" };
    await expect(handleTwilioStatus(sq(), t.tenantId, params, "forged")).rejects.toThrow(/signature/i);
    await expect(handleTwilioStatus(sq(), t.tenantId, { ...params, CallDuration: "999" }, signed(t.tenantId, params))).rejects.toThrow(/signature/i); // body changed after signing
    expect(await handleTwilioStatus(sq(), t.tenantId, params, signed(t.tenantId, params))).toMatchObject({ status: "logged" });
    expect(await handleTwilioStatus(sq(), t.tenantId, params, signed(t.tenantId, params))).toEqual({ status: "duplicate" });
    const calls = (await listCalls(sq(), t.admin, { limit: 100, offset: 0 })) as any[];
    const mine = calls.filter((c) => c.leadId === lead.lead.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ direction: "inbound", outcome: "answered", durationSec: 125, userId: agent.id });
  });

  it("maps unanswered calls, ignores in-progress events and unknown numbers", async () => {
    const { t, lead, e164 } = await setup();
    const miss = { CallSid: `CA${uniq("m")}`, AccountSid: SID, From: "+97141234567", To: e164, Direction: "outbound-api", CallStatus: "no-answer" };
    expect(await handleTwilioStatus(sq(), t.tenantId, miss, signed(t.tenantId, miss))).toMatchObject({ status: "logged" });
    const ringing = { ...miss, CallSid: `CA${uniq("r")}`, CallStatus: "ringing" };
    expect(await handleTwilioStatus(sq(), t.tenantId, ringing, signed(t.tenantId, ringing))).toEqual({ status: "ignored" });
    const stranger = { ...miss, CallSid: `CA${uniq("x")}`, To: "+971559990000" };
    expect(await handleTwilioStatus(sq(), t.tenantId, stranger, signed(t.tenantId, stranger))).toEqual({ status: "unmatched" });
    const calls = ((await listCalls(sq(), t.admin, { limit: 100, offset: 0 })) as any[]).filter((c) => c.leadId === lead.lead.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ direction: "outbound", outcome: "no_answer" });
  });

  it("does not let one company's callback write into another's log", async () => {
    const a = await setup(), b = await setup();
    const params = { CallSid: `CA${uniq("i")}`, AccountSid: SID, From: a.e164, To: "+97141234567", Direction: "inbound", CallStatus: "completed", CallDuration: "30" };
    await expect(handleTwilioStatus(sq(), b.t.tenantId, params, signed(a.t.tenantId, params))).rejects.toThrow(/signature/i);
  });

  it("starts a call from the lead through Twilio, ringing the agent first", async () => {
    const { t, agent, lead } = await setup();
    const seen: { url: string; body: URLSearchParams; auth: string }[] = [];
    const fake = async (url: string, init: any) => { seen.push({ url, body: new URLSearchParams(init.body), auth: init.headers.authorization }); return { ok: true, status: 201, json: async () => ({ sid: "CA123" }) }; };
    await expect(startCall(sq(), agent.ctx, { leadId: lead.lead.id }, fake as never)).rejects.toThrow(/mobile number/); // no profile number yet
    await sq().query("UPDATE user_profiles SET phone_e164='+971501112222' WHERE tenant_id=:t AND user_id=:u", { replacements: { t: t.tenantId, u: agent.id } });
    const r = await startCall(sq(), agent.ctx, { leadId: lead.lead.id }, fake as never);
    expect(r).toMatchObject({ started: true, callSid: "CA123", ringing: "+971501112222" });
    expect(seen[0]!.url).toContain(`/Accounts/${SID}/Calls.json`);
    expect(seen[0]!.body.get("To")).toBe("+971501112222");
    expect(seen[0]!.body.get("From")).toBe("+97141234567");
    expect(seen[0]!.body.get("Url")).toContain(`/${t.tenantId}/connect?to=`);
    expect(seen[0]!.auth).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString("base64")}`);
    const refused = async () => ({ ok: false, status: 400, json: async () => ({ message: "Invalid number" }) });
    await expect(startCall(sq(), agent.ctx, { leadId: lead.lead.id }, refused as never)).rejects.toThrow(/refused/);
  });

  it("connects the lead only when Twilio's signature on the instructions request is right", async () => {
    const { t, e164 } = await setup();
    const q = new URLSearchParams({ to: e164 });
    const url = callbackUrl(t.tenantId, "connect", `?${q}`);
    const params = { CallSid: "CA1", AccountSid: SID };
    const xml = await twilioConnectXml(sq(), t.tenantId, params, q, twilioSignature(TOKEN, url, params), url);
    expect(xml).toContain(`<Number>${e164}</Number>`);
    expect(xml).toContain('callerId="+97141234567"');
    await expect(twilioConnectXml(sq(), t.tenantId, params, q, "bad", url)).rejects.toThrow(/signature/i);
  });
});

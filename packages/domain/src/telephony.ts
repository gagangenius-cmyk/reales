import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, systemContext, type RequestContext } from "@reales/database";
import { decryptField, encryptField } from "@reales/auth";
import { authorize, hasPermission, ForbiddenError } from "@reales/rbac";
import { normalizePhone } from "./normalize";
import { ConflictError, NotFoundError, withUow } from "./uow";

/**
 * Telephony with Twilio: calls made or received on the company number appear in the CRM's call log without anyone typing them in, and an agent can start
 * a call to a lead from the lead page (Twilio rings the agent first, then connects the lead, so the call is made on the company number).
 * The Twilio auth token is stored encrypted and never shown again. Every callback is checked against Twilio's signature before anything is written, and a
 * call id is recorded once even if Twilio delivers the callback twice. Calls from numbers that match no contact are ignored (nothing is invented).
 */
export const TELEPHONY_KEY = "telephony";
export interface TelephonyConfig { provider: "twilio"; accountSid: string; authTokenEnc: string; fromNumber: string; enabled: boolean }
export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

const base = () => (process.env.PUBLIC_BASE_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
export const callbackUrl = (tenantId: string, leg: "status" | "connect" = "status", query = "") => `${base()}/api/webhooks/voice/twilio/${tenantId}/${leg}${query}`;

async function readConfig(sq: Sequelize, tenantId: string): Promise<TelephonyConfig | null> {
  const [row] = (await sq.query("SELECT value FROM tenant_settings WHERE tenant_id=:t AND `key`=:k", { replacements: { t: tenantId, k: TELEPHONY_KEY }, type: QueryTypes.SELECT })) as { value: unknown }[];
  if (!row) return null;
  const v = (typeof row.value === "string" ? JSON.parse(row.value) : row.value) as TelephonyConfig | null;
  return v && v.accountSid && v.authTokenEnc ? v : null;
}

/** What the settings screen may show: never the token. */
export async function getTelephony(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "tenant.manage");
  const c = await readConfig(sq, ctx.tenantId);
  return { configured: !!c, enabled: !!c?.enabled, provider: "twilio" as const, accountSid: c?.accountSid ?? null, fromNumber: c?.fromNumber ?? null, statusUrl: callbackUrl(ctx.tenantId), connectUrl: callbackUrl(ctx.tenantId, "connect") };
}

export async function saveTelephony(sq: Sequelize, ctx: RequestContext, i: { accountSid: string; authToken?: string; fromNumber: string; enabled?: boolean }) {
  authorize(ctx, "tenant.manage");
  const sid = i.accountSid.trim();
  if (!/^AC[0-9a-fA-F]{32}$/.test(sid)) throw new ConflictError("That does not look like a Twilio account SID (it starts with AC)");
  const from = normalizePhone(i.fromNumber);
  if (!from) throw new ConflictError("Enter the Twilio number in international format, for example +971 4 123 4567");
  await withUow(sq, ctx, async (u) => {
    const row = (await u.repo("TenantSetting").findOne({ where: { key: TELEPHONY_KEY }, transaction: u.tx })) as any;
    const cur = row ? ((typeof row.get("value") === "string" ? JSON.parse(row.get("value")) : row.get("value")) as TelephonyConfig) : null;
    const token = i.authToken?.trim();
    if (!token && !cur?.authTokenEnc) throw new ConflictError("Enter the Twilio auth token");
    const next: TelephonyConfig = { provider: "twilio", accountSid: sid, authTokenEnc: token ? encryptField(token) : cur!.authTokenEnc, fromNumber: from, enabled: i.enabled ?? true };
    if (row) await u.repo("TenantSetting").updateById(row.get("id"), { value: next }, { transaction: u.tx });
    else await u.repo("TenantSetting").create({ key: TELEPHONY_KEY, value: next }, { transaction: u.tx });
    await u.audit({ action: "telephony.configured", entityType: "tenant_settings", entityId: ctx.tenantId, before: cur ? { accountSid: cur.accountSid, fromNumber: cur.fromNumber, enabled: cur.enabled } : null, after: { accountSid: sid, fromNumber: from, enabled: next.enabled, tokenChanged: !!token } });
  });
  return getTelephony(sq, ctx);
}

/** Twilio's request signature: base64 HMAC-SHA1 of the full URL followed by each POST field (sorted by name) as name+value. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}
export function twilioSignatureValid(authToken: string, url: string, params: Record<string, string>, header: string | null | undefined) {
  if (!header) return false;
  const a = Buffer.from(twilioSignature(authToken, url, params)), b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

const TERMINAL: Record<string, "answered" | "no_answer" | "busy"> = { completed: "answered", "no-answer": "no_answer", busy: "busy", failed: "no_answer", canceled: "no_answer" };
const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The signed-callback entry point. Returns what to send back to Twilio; throws ForbiddenError for a bad signature. */
export async function handleTwilioStatus(sq: Sequelize, tenantId: string, params: Record<string, string>, signature: string | null, url = callbackUrl(tenantId)) {
  const cfg = await readConfig(sq, tenantId);
  if (!cfg?.enabled) throw new NotFoundError("Telephony");
  if (!twilioSignatureValid(decryptField(cfg.authTokenEnc), url, params, signature)) throw new ForbiddenError("Bad signature");
  if (params.AccountSid && params.AccountSid !== cfg.accountSid) throw new ForbiddenError("Wrong account");
  const sid = params.CallSid, status = (params.CallStatus ?? "").toLowerCase();
  if (!sid || !(status in TERMINAL)) return { status: "ignored" as const };
  const inbound = (params.Direction ?? "").startsWith("inbound");
  const external = normalizePhone(inbound ? params.From : params.To);
  if (!external) return { status: "ignored" as const };
  const duration = Math.max(0, Math.min(6 * 3600, Number(params.CallDuration ?? 0) || 0));
  const outcome = TERMINAL[status] === "answered" && duration === 0 ? "no_answer" : TERMINAL[status]!;
  const ctx = systemContext(tenantId, `corr_${randomUUID()}`);
  return withUow(sq, ctx, async (u) => {
    const q = async (sql: string, r: Record<string, unknown>) => (await u.sq.query(sql, { replacements: { t: tenantId, ...r }, transaction: u.tx, type: QueryTypes.SELECT })) as any[];
    if ((await q("SELECT id FROM call_logs WHERE tenant_id=:t AND provider_sid=:s", { s: sid })).length) return { status: "duplicate" as const };
    const [contact] = await q("SELECT id, owner_user_id FROM contacts WHERE tenant_id=:t AND deleted_at IS NULL AND (phone_e164=:p OR whatsapp_e164=:p OR phone_secondary=:p) ORDER BY created_at LIMIT 1", { p: external });
    if (!contact) return { status: "unmatched" as const };
    const [lead] = await q("SELECT id, assigned_user_id FROM leads WHERE tenant_id=:t AND contact_id=:c AND deleted_at IS NULL AND status='open' ORDER BY created_at DESC LIMIT 1", { c: contact.id });
    // the agent: the lead's owner, else the contact's owner, else whoever the call went to by their profile number, else any user of the tenant
    const own = normalizePhone(inbound ? params.To : params.From);
    const [byPhone] = own ? await q("SELECT user_id FROM user_profiles WHERE tenant_id=:t AND phone_e164=:p LIMIT 1", { p: own }) : [];
    const [any] = await q("SELECT user_id FROM user_roles WHERE tenant_id=:t LIMIT 1", {});
    const userId = lead?.assigned_user_id ?? contact.owner_user_id ?? byPhone?.user_id ?? any?.user_id;
    if (!userId) return { status: "unmatched" as const };
    const id = randomUUID(), at = new Date(Date.now() - duration * 1000);
    await u.repo("CallLog").create({ id, userId, leadId: lead?.id ?? null, contactId: contact.id, direction: inbound ? "inbound" : "outbound", outcome, startedAt: at, durationSec: duration, notes: "Recorded automatically from the phone system", providerSid: sid }, { transaction: u.tx });
    const now = new Date();
    if (lead && outcome === "answered") {
      await u.repo("Lead").updateById(lead.id, { lastContactedAt: now }, { transaction: u.tx });
      await u.repo("Activity").create({ id: randomUUID(), entityType: "lead", entityId: lead.id, kind: "call", summary: `${inbound ? "Inbound" : "Outbound"} call, answered (${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, "0")})`, actorId: userId, occurredAt: mysqlDate(now), createdAt: mysqlDate(now) }, { transaction: u.tx });
    }
    if (outcome === "answered") await u.repo("Contact").updateById(contact.id, { lastContactedAt: now }, { transaction: u.tx });
    await u.emit({ type: "call.logged", aggregateType: lead ? "lead" : "contact", aggregateId: lead?.id ?? contact.id, projectId: null, payload: { callId: id, outcome, durationSec: duration, source: "twilio" } });
    return { status: "logged" as const, id };
  });
}

/** The instructions Twilio fetches once the agent picks up: connect them to the customer. The signature is checked like any other callback. */
export async function twilioConnectXml(sq: Sequelize, tenantId: string, params: Record<string, string>, query: URLSearchParams, signature: string | null, url: string) {
  const cfg = await readConfig(sq, tenantId);
  if (!cfg?.enabled) throw new NotFoundError("Telephony");
  if (!twilioSignatureValid(decryptField(cfg.authTokenEnc), url, params, signature)) throw new ForbiddenError("Bad signature");
  const to = normalizePhone(query.get("to"));
  if (!to) return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, the number could not be dialled.</Say></Response>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${esc(cfg.fromNumber)}" answerOnBridge="true"><Number>${esc(to)}</Number></Dial></Response>`;
}

/** Click to call: Twilio calls the agent's own phone (from their profile), then bridges the lead. The agent must be allowed to log calls and see the lead. */
export async function startCall(sq: Sequelize, ctx: RequestContext, i: { leadId?: string; contactId?: string }, fetcher: Fetcher = fetch as never) {
  if (!hasPermission(ctx, "call.log")) throw new ForbiddenError("Missing permission: call.log");
  const cfg = await readConfig(sq, ctx.tenantId);
  if (!cfg?.enabled) throw new ConflictError("Phone calls are not set up yet. An administrator can connect Twilio on the Calls page.");
  const target = await withUow(sq, ctx, async (u) => {
    let contactId = i.contactId;
    if (i.leadId) {
      const lead: any = await u.repo("Lead").findById(i.leadId, { transaction: u.tx });
      if (!lead) throw new NotFoundError("Lead");
      contactId = lead.get("contactId");
    }
    if (!contactId) throw new ConflictError("Choose a lead or contact to call");
    const contact: any = await u.repo("Contact").findById(contactId, { transaction: u.tx });
    if (!contact) throw new NotFoundError("Contact");
    const [me] = (await u.sq.query("SELECT phone_e164 FROM user_profiles WHERE tenant_id=:t AND user_id=:u", { replacements: { t: ctx.tenantId, u: ctx.userId }, transaction: u.tx, type: QueryTypes.SELECT })) as { phone_e164: string | null }[];
    return { customer: normalizePhone(contact.get("phoneE164") ?? contact.get("whatsappE164")), agent: normalizePhone(me?.phone_e164) };
  });
  if (!target.customer) throw new ConflictError("This contact has no phone number");
  if (!target.agent) throw new ConflictError("Add your own mobile number to your profile first, so the phone system can ring you");
  const token = decryptField(cfg.authTokenEnc);
  const body = new URLSearchParams({ To: target.agent, From: cfg.fromNumber, Url: callbackUrl(ctx.tenantId, "connect", `?to=${encodeURIComponent(target.customer)}`), StatusCallback: callbackUrl(ctx.tenantId), StatusCallbackEvent: "completed" }).toString();
  const res = await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls.json`, { method: "POST", headers: { authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${token}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" }, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ConflictError(`The phone provider refused the call${json?.message ? `: ${String(json.message).slice(0, 160)}` : ""}`);
  return { started: true, callSid: String(json.sid ?? ""), ringing: target.agent };
}

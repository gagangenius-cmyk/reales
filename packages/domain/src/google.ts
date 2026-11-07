import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { initModels, mysqlDate, type RequestContext } from "@reales/database";
import { decryptField, encryptField, safeEqualHex, sha256 } from "@reales/auth";
import { logger } from "@reales/observability";
import { ForbiddenError, hasPermission, loadAccess } from "@reales/rbac";
import { CONTACT_SCOPE } from "./contacts";
import { normalizeEmail } from "./normalize";
import { plain, scopeWhere } from "./scope";
import { ConflictError, NotFoundError, withUow } from "./uow";

/**
 * Google Workspace connection (Calendar and Gmail), one OAuth account per user.
 *
 * - Tokens: the access and refresh tokens are encrypted at rest and only ever read by server code in this file. No API response, page or log contains them.
 * - Calendar: the user's open tasks and scheduled viewings are pushed to their primary Google calendar (and kept in step, including deletes);
 *   their other Google events are read back as anonymous busy blocks (no titles stored) so double-booking can be avoided.
 * - Gmail: header metadata only (sender, recipients, subject, date) through the gmail.metadata scope; message bodies are never requested.
 *   Messages are linked to contacts the mailbox owner may see, and are shown only to the mailbox owner. Off until the user switches it on.
 */

export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/gmail.metadata"];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GoogleHttpInit { method?: string; headers?: Record<string, string>; body?: string }
export type GoogleHttp = (url: string, init?: GoogleHttpInit) => Promise<{ status: number; json: any }>;
export const fetchHttp: GoogleHttp = async (url, init) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  let json: any = null;
  try { json = await r.json(); } catch { /* empty body (204) */ }
  return { status: r.status, json };
};

export function googleConfig(): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const base = process.env.PUBLIC_BASE_URL ?? process.env.APP_URL;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? (base ? `${base.replace(/\/$/, "")}/api/v1/google/callback` : "");
  return clientId && clientSecret && redirectUri ? { clientId, clientSecret, redirectUri } : null;
}
const mustConfig = () => { const c = googleConfig(); if (!c) throw new ConflictError("Google is not configured for this installation (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and a redirect address are needed)"); return c; };
const mustConnect = (ctx: RequestContext) => { if (!hasPermission(ctx, "google.connect")) throw new ForbiddenError("Missing permission: google.connect"); };
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** What the person may see about their connection. Never includes tokens. */
const publicAccount = (a: any) => a && {
  id: a.get("id"), email: a.get("externalEmail"), status: a.get("status"), syncCalendar: !!a.get("syncCalendar"), syncGmail: !!a.get("syncGmail"),
  lastCalendarSyncAt: a.get("lastCalendarSyncAt"), lastGmailSyncAt: a.get("lastGmailSyncAt"), lastError: a.get("lastError"), scopes: a.get("scopes"),
};

async function ownAccount(sq: Sequelize, ctx: RequestContext) {
  return withUow(sq, ctx, (u) => u.repo("ConnectedAccount").findOne({ where: { userId: ctx.userId, provider: "google" }, transaction: u.tx }) as Promise<any>);
}

export async function getGoogleStatus(sq: Sequelize, ctx: RequestContext) {
  mustConnect(ctx);
  return { configured: !!googleConfig(), account: publicAccount(await ownAccount(sq, ctx)) ?? null };
}

// ---------------------------------------------------------------- connect

/** The state is an authenticated, encrypted blob (user, tenant, expiry, nonce): it cannot be forged or replayed for another person. */
export async function startGoogleConnect(sq: Sequelize, ctx: RequestContext) {
  mustConnect(ctx);
  const cfg = mustConfig();
  const state = encryptField(JSON.stringify({ u: ctx.userId, t: ctx.tenantId, exp: Date.now() + 10 * 60_000, n: randomBytes(8).toString("hex") }));
  const url = `${AUTH_URL}?${form({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: "code", scope: GOOGLE_SCOPES.join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "false", state })}`;
  return { url };
}

function decodeIdTokenEmail(idToken: string): string | null {
  try {
    // Received straight from Google's token endpoint over TLS, so its signature need not be re-verified (OIDC Core 3.1.3.7).
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1]!, "base64url").toString("utf8"));
    return payload.email_verified === false ? null : typeof payload.email === "string" ? payload.email : null;
  } catch { return null; }
}

export async function completeGoogleConnect(sq: Sequelize, ctx: RequestContext, i: { code: string; state: string }, http: GoogleHttp = fetchHttp) {
  mustConnect(ctx);
  const cfg = mustConfig();
  let st: { u: string; t: string; exp: number };
  try { st = JSON.parse(decryptField(i.state)); } catch { throw new ConflictError("This Google sign-in link is not valid; start again"); }
  if (st.u !== ctx.userId || st.t !== ctx.tenantId || st.exp < Date.now()) throw new ConflictError("This Google sign-in link expired or belongs to someone else; start again");
  const r = await http(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ code: i.code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: "authorization_code" }) });
  if (r.status !== 200 || !r.json?.access_token) throw new ConflictError("Google did not accept the sign-in; start again");
  const email = decodeIdTokenEmail(r.json.id_token ?? "");
  if (!email) throw new ConflictError("Google did not return a verified e-mail address");
  const granted: string[] = String(r.json.scope ?? "").split(" ").filter(Boolean);
  if (!granted.some((s) => s.endsWith("/calendar.events"))) throw new ConflictError("Calendar access was not granted; tick the Calendar permission when Google asks");
  return withUow(sq, ctx, async (u) => {
    const cur: any = await u.repo("ConnectedAccount").findOne({ where: { userId: ctx.userId, provider: "google" }, transaction: u.tx });
    const refresh = r.json.refresh_token as string | undefined;
    if (!refresh && !(cur?.get("refreshTokenEnc"))) throw new ConflictError("Google did not return an offline token; remove the app at myaccount.google.com/permissions and connect again");
    const values = {
      externalEmail: email.slice(0, 254), scopes: granted, status: "active", accessTokenEnc: encryptField(r.json.access_token), accessExpiresAt: mysqlDate(new Date(Date.now() + Number(r.json.expires_in ?? 3600) * 1000)),
      ...(refresh ? { refreshTokenEnc: encryptField(refresh) } : {}), lastError: null, calendarSyncToken: null,
    };
    let id: string;
    if (cur) { id = cur.get("id"); await u.repo("ConnectedAccount").updateById(id, values, { transaction: u.tx }); }
    else { id = randomUUID(); await u.repo("ConnectedAccount").create({ id, userId: ctx.userId, provider: "google", syncCalendar: true, syncGmail: false, calendarDirty: true, ...values }, { transaction: u.tx }); }
    await u.audit({ action: "google.connected", entityType: "connected_account", entityId: id, after: { email, scopes: granted } });
    return publicAccount(await u.repo("ConnectedAccount").findById(id, { transaction: u.tx }));
  });
}

export async function updateGoogleSettings(sq: Sequelize, ctx: RequestContext, i: { syncCalendar?: boolean; syncGmail?: boolean }) {
  mustConnect(ctx);
  return withUow(sq, ctx, async (u) => {
    const a: any = await u.repo("ConnectedAccount").findOne({ where: { userId: ctx.userId, provider: "google" }, transaction: u.tx });
    if (!a || a.get("status") === "revoked") throw new NotFoundError("Google connection");
    const patch: Record<string, unknown> = {};
    if (i.syncCalendar !== undefined) patch.syncCalendar = i.syncCalendar;
    if (i.syncGmail !== undefined) {
      if (i.syncGmail && !(a.get("scopes") as string[]).some((s) => s.endsWith("/gmail.metadata"))) throw new ConflictError("Gmail access was not granted; disconnect and connect again, ticking the Gmail permission");
      patch.syncGmail = i.syncGmail;
    }
    await u.repo("ConnectedAccount").updateById(a.get("id"), patch, { transaction: u.tx });
    await u.audit({ action: "google.settings_changed", entityType: "connected_account", entityId: a.get("id"), after: patch });
    return publicAccount(await u.repo("ConnectedAccount").findById(a.get("id"), { transaction: u.tx }));
  });
}

/** Revoke at Google (best effort), forget the tokens and the synced data. Events already created in Google are left in the person's calendar. */
export async function disconnectGoogle(sq: Sequelize, ctx: RequestContext, http: GoogleHttp = fetchHttp) {
  mustConnect(ctx);
  const a: any = await ownAccount(sq, ctx);
  if (!a) return;
  try {
    const token = a.get("refreshTokenEnc") ? decryptField(a.get("refreshTokenEnc")) : a.get("accessTokenEnc") ? decryptField(a.get("accessTokenEnc")) : null;
    if (a.get("channelId")) { const t = await accessToken(sq, a, http).catch(() => null); if (t) await http("https://www.googleapis.com/calendar/v3/channels/stop", { method: "POST", headers: bearer(t), body: JSON.stringify({ id: a.get("channelId"), resourceId: "unknown" }) }).catch(() => null); }
    if (token) await http(REVOKE_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ token }) });
  } catch (e) { logger.warn({ err: e }, "google revoke failed"); }
  await withUow(sq, ctx, async (u) => {
    await u.repo("ConnectedAccount").updateById(a.get("id"), { status: "revoked", accessTokenEnc: null, refreshTokenEnc: null, accessExpiresAt: null, calendarSyncToken: null, channelId: null, channelTokenHash: null, channelExpiresAt: null, syncGmail: false }, { transaction: u.tx });
    await u.sq.query("DELETE FROM calendar_external_events WHERE tenant_id=:t AND account_id=:a", { replacements: { t: ctx.tenantId, a: a.get("id") }, transaction: u.tx });
    await u.sq.query("DELETE FROM email_external_messages WHERE tenant_id=:t AND account_id=:a", { replacements: { t: ctx.tenantId, a: a.get("id") }, transaction: u.tx });
    await u.audit({ action: "google.disconnected", entityType: "connected_account", entityId: a.get("id") });
  });
}

// ---------------------------------------------------------------- tokens

const bearer = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

/** A valid access token for the account, refreshed when it is about to expire. An invalid_grant (the user revoked access) switches the account off. */
async function accessToken(sq: Sequelize, a: any, http: GoogleHttp): Promise<string> {
  const exp = a.get("accessExpiresAt") ? new Date(a.get("accessExpiresAt")).getTime() : 0;
  if (a.get("accessTokenEnc") && exp - Date.now() > 60_000) return decryptField(a.get("accessTokenEnc"));
  if (!a.get("refreshTokenEnc")) throw new ConflictError("Google access was removed; connect again");
  const cfg = mustConfig();
  const r = await http(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: decryptField(a.get("refreshTokenEnc")), grant_type: "refresh_token" }) });
  if (r.status === 400 && r.json?.error === "invalid_grant") {
    await sq.query("UPDATE connected_accounts SET status='revoked', access_token_enc=NULL, refresh_token_enc=NULL, last_error=:e WHERE id=:id AND tenant_id=:t", { replacements: { id: a.get("id"), t: a.get("tenantId"), e: "Google access was revoked; connect again" } });
    throw new ConflictError("Google access was revoked; connect again");
  }
  if (r.status !== 200 || !r.json?.access_token) throw new ConflictError(`Google token refresh failed (HTTP ${r.status})`);
  const expiresAt = new Date(Date.now() + Number(r.json.expires_in ?? 3600) * 1000);
  await sq.query("UPDATE connected_accounts SET access_token_enc=:tok, access_expires_at=:exp WHERE id=:id AND tenant_id=:t", { replacements: { tok: encryptField(r.json.access_token), exp: mysqlDate(expiresAt), id: a.get("id"), t: a.get("tenantId") } });
  return r.json.access_token as string;
}

/** Call a Google API with the account token; one retry with a fresh token when Google answers 401. */
async function gcall(sq: Sequelize, a: any, http: GoogleHttp, url: string, init: GoogleHttpInit = {}) {
  let t = await accessToken(sq, a, http);
  let r = await http(url, { ...init, headers: { ...bearer(t), ...(init.headers ?? {}) } });
  if (r.status === 401) { a.set("accessExpiresAt", null); t = await accessToken(sq, a, http); r = await http(url, { ...init, headers: { ...bearer(t), ...(init.headers ?? {}) } }); }
  return r;
}

// ---------------------------------------------------------------- calendar push

interface Desired { type: "task" | "viewing"; id: string; summary: string; description: string; start: Date; end: Date; location?: string }

async function desiredEvents(sq: Sequelize, a: any, now: Date): Promise<Desired[]> {
  const tenantId = a.get("tenantId"), userId = a.get("userId");
  const from = new Date(now.getTime() - 86_400_000), to = new Date(now.getTime() + 90 * 86_400_000);
  const base = process.env.PUBLIC_BASE_URL ?? process.env.APP_URL ?? "";
  const tasks = await sq.query<any>("SELECT id, title, due_at FROM tasks WHERE tenant_id=:t AND assignee_id=:u AND status='open' AND deleted_at IS NULL AND due_at BETWEEN :f AND :to", { replacements: { t: tenantId, u: userId, f: mysqlDate(from), to: mysqlDate(to) }, type: QueryTypes.SELECT });
  const viewings = await sq.query<any>(
    `SELECT v.id, v.scheduled_at, v.duration_min, v.location_note, c.first_name, c.last_name, c.company_name FROM viewings v LEFT JOIN contacts c ON c.id = v.contact_id AND c.tenant_id = v.tenant_id
      WHERE v.tenant_id=:t AND v.agent_user_id=:u AND v.status IN ('scheduled','checked_in') AND v.deleted_at IS NULL AND v.scheduled_at BETWEEN :f AND :to`,
    { replacements: { t: tenantId, u: userId, f: mysqlDate(from), to: mysqlDate(to) }, type: QueryTypes.SELECT });
  const out: Desired[] = [];
  for (const t of tasks) { const s = new Date(t.due_at); out.push({ type: "task", id: t.id, summary: `Task: ${t.title}`.slice(0, 200), description: base ? `${base}/tasks` : "Reales CRM task", start: s, end: new Date(s.getTime() + 30 * 60_000) }); }
  for (const v of viewings) {
    const s = new Date(v.scheduled_at), who = [v.first_name, v.last_name].filter(Boolean).join(" ") || v.company_name || "client";
    out.push({ type: "viewing", id: v.id, summary: `Viewing: ${who}`.slice(0, 200), description: base ? `${base}/viewings` : "Reales CRM viewing", start: s, end: new Date(s.getTime() + Number(v.duration_min ?? 45) * 60_000), location: v.location_note ?? undefined });
  }
  return out;
}

const toGoogle = (d: Desired) => ({
  summary: d.summary, description: d.description, location: d.location, start: { dateTime: d.start.toISOString(), timeZone: "Asia/Dubai" }, end: { dateTime: d.end.toISOString(), timeZone: "Asia/Dubai" },
  extendedProperties: { private: { reales: "1", localType: d.type, localId: d.id } }, reminders: { useDefault: true },
});
const hashOf = (d: Desired) => createHash("sha256").update(JSON.stringify([d.summary, d.description, d.location ?? "", d.start.toISOString(), d.end.toISOString()])).digest("hex");

export async function pushCalendar(sq: Sequelize, a: any, http: GoogleHttp, now = new Date()): Promise<{ created: number; updated: number; deleted: number }> {
  const res = { created: 0, updated: 0, deleted: 0 };
  const want = await desiredEvents(sq, a, now);
  const mapped = await sq.query<any>("SELECT id, local_type, local_id, google_event_id, content_hash FROM calendar_external_events WHERE tenant_id=:t AND account_id=:a AND local_type IS NOT NULL", { replacements: { t: a.get("tenantId"), a: a.get("id") }, type: QueryTypes.SELECT });
  const byKey = new Map(mapped.map((m) => [`${m.local_type}:${m.local_id}`, m]));
  let budget = 200;
  for (const d of want) {
    const key = `${d.type}:${d.id}`, m = byKey.get(key), h = hashOf(d);
    byKey.delete(key);
    if (m?.content_hash === h) continue;
    if (budget-- <= 0) break;
    if (m) {
      const r = await gcall(sq, a, http, `${CAL}/events/${encodeURIComponent(m.google_event_id)}`, { method: "PATCH", body: JSON.stringify(toGoogle(d)) });
      if (r.status === 404 || r.status === 410) { await sq.query("DELETE FROM calendar_external_events WHERE id=:id", { replacements: { id: m.id } }); continue; }
      if (r.status !== 200) throw new ConflictError(`Google Calendar update failed (HTTP ${r.status})`);
      await sq.query("UPDATE calendar_external_events SET content_hash=:h, starts_at=:s, ends_at=:e WHERE id=:id", { replacements: { h, s: mysqlDate(d.start), e: mysqlDate(d.end), id: m.id } });
      res.updated++;
    } else {
      const r = await gcall(sq, a, http, `${CAL}/events`, { method: "POST", body: JSON.stringify(toGoogle(d)) });
      if (r.status !== 200 || !r.json?.id) throw new ConflictError(`Google Calendar create failed (HTTP ${r.status})`);
      await sq.query("INSERT INTO calendar_external_events (id, tenant_id, account_id, local_type, local_id, google_event_id, content_hash, busy_only, starts_at, ends_at, created_at, updated_at) VALUES (:id,:t,:a,:lt,:li,:g,:h,0,:s,:e,NOW(3),NOW(3))",
        { replacements: { id: randomUUID(), t: a.get("tenantId"), a: a.get("id"), lt: d.type, li: d.id, g: r.json.id, h, s: mysqlDate(d.start), e: mysqlDate(d.end) } });
      res.created++;
    }
  }
  // Whatever is still mapped but no longer wanted (done, cancelled, moved out of the window): remove it from Google.
  for (const m of byKey.values()) {
    if (!m) continue;
    if (budget-- <= 0) break;
    const r = await gcall(sq, a, http, `${CAL}/events/${encodeURIComponent(m.google_event_id)}`, { method: "DELETE" });
    if (![200, 204, 404, 410].includes(r.status)) throw new ConflictError(`Google Calendar delete failed (HTTP ${r.status})`);
    await sq.query("DELETE FROM calendar_external_events WHERE id=:id", { replacements: { id: m.id } });
    res.deleted++;
  }
  return res;
}

// ---------------------------------------------------------------- calendar pull (busy blocks)

const eventTime = (x: any): Date | null => x?.dateTime ? new Date(x.dateTime) : x?.date ? new Date(`${x.date}T00:00:00+04:00`) : null;

export async function pullBusy(sq: Sequelize, a: any, http: GoogleHttp, now = new Date()): Promise<{ changed: number }> {
  let token: string | null = a.get("calendarSyncToken") ?? null;
  let changed = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    let page: string | undefined, next: string | undefined, gone = false;
    do {
      const q = new URLSearchParams({ singleEvents: "true", maxResults: "250", showDeleted: "true" });
      if (token) q.set("syncToken", token); else q.set("timeMin", new Date(now.getTime() - 86_400_000).toISOString());
      if (page) q.set("pageToken", page);
      const r = await gcall(sq, a, http, `${CAL}/events?${q}`);
      if (r.status === 410) { gone = true; break; }
      if (r.status !== 200) throw new ConflictError(`Google Calendar read failed (HTTP ${r.status})`);
      for (const ev of r.json.items ?? []) {
        if (ev.extendedProperties?.private?.reales === "1") continue; // our own push
        const mapped = await sq.query<any>("SELECT id FROM calendar_external_events WHERE account_id=:a AND google_event_id=:g", { replacements: { a: a.get("id"), g: ev.id }, type: QueryTypes.SELECT });
        const start = eventTime(ev.start), end = eventTime(ev.end);
        const busy = ev.status !== "cancelled" && ev.transparency !== "transparent" && start && end;
        if (!busy) { if (mapped.length) { await sq.query("DELETE FROM calendar_external_events WHERE id=:id", { replacements: { id: mapped[0].id } }); changed++; } continue; }
        if (mapped.length) await sq.query("UPDATE calendar_external_events SET starts_at=:s, ends_at=:e WHERE id=:id", { replacements: { s: mysqlDate(start), e: mysqlDate(end), id: mapped[0].id } });
        else await sq.query("INSERT INTO calendar_external_events (id, tenant_id, account_id, local_type, local_id, google_event_id, content_hash, busy_only, starts_at, ends_at, created_at, updated_at) VALUES (:id,:t,:a,NULL,NULL,:g,NULL,1,:s,:e,NOW(3),NOW(3))",
          { replacements: { id: randomUUID(), t: a.get("tenantId"), a: a.get("id"), g: ev.id, s: mysqlDate(start), e: mysqlDate(end) } });
        changed++;
      }
      page = r.json.nextPageToken; next = r.json.nextSyncToken;
    } while (page);
    if (gone) { token = null; await sq.query("DELETE FROM calendar_external_events WHERE account_id=:a AND busy_only=1", { replacements: { a: a.get("id") } }); continue; }
    if (next) await sq.query("UPDATE connected_accounts SET calendar_sync_token=:s WHERE id=:id AND tenant_id=:t", { replacements: { s: next, id: a.get("id"), t: a.get("tenantId") } });
    break;
  }
  return { changed };
}

// ---------------------------------------------------------------- push notifications from Google

/** Register a Calendar watch channel so Google tells us when the calendar changes. Only possible on a public https address. */
export async function ensureCalendarChannel(sq: Sequelize, a: any, http: GoogleHttp, now = new Date()): Promise<boolean> {
  const base = process.env.PUBLIC_BASE_URL ?? "";
  if (!base.startsWith("https://")) return false;
  const exp = a.get("channelExpiresAt") ? new Date(a.get("channelExpiresAt")).getTime() : 0;
  if (a.get("channelId") && exp - now.getTime() > 86_400_000) return false;
  const channelId = randomUUID(), secret = randomBytes(24).toString("base64url");
  const r = await gcall(sq, a, http, `${CAL}/events/watch`, { method: "POST", body: JSON.stringify({ id: channelId, type: "web_hook", address: `${base.replace(/\/$/, "")}/api/webhooks/google/calendar`, token: secret }) });
  if (r.status !== 200) return false; // push is an optimisation; polling still works
  await sq.query("UPDATE connected_accounts SET channel_id=:c, channel_token_hash=:h, channel_expires_at=:e WHERE id=:id AND tenant_id=:t", { replacements: { c: channelId, h: sha256(secret), e: mysqlDate(new Date(Number(r.json.expiration ?? now.getTime() + 6 * 86_400_000))), id: a.get("id"), t: a.get("tenantId") } });
  return true;
}

/** Called by the public webhook: authenticate the channel, then mark the account so the next sweep pulls at once. Reveals nothing to the caller. */
export async function handleCalendarPush(sq: Sequelize, channelId: string | null, token: string | null): Promise<boolean> {
  if (!channelId || !token) return false;
  const [row] = await sq.query<{ id: string; channel_token_hash: string }>("SELECT id, channel_token_hash FROM connected_accounts WHERE channel_id=:c AND status='active'", { replacements: { c: channelId }, type: QueryTypes.SELECT });
  if (!row?.channel_token_hash || !safeEqualHex(row.channel_token_hash, sha256(token))) return false;
  await sq.query("UPDATE connected_accounts SET calendar_dirty=1 WHERE id=:id", { replacements: { id: row.id } });
  return true;
}

// ---------------------------------------------------------------- Gmail metadata

const ADDR = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const header = (msg: any, name: string): string => (msg.payload?.headers ?? []).find((h: any) => String(h.name).toLowerCase() === name.toLowerCase())?.value ?? "";
const addresses = (s: string) => [...new Set((s.match(ADDR) ?? []).map((x) => x.toLowerCase()))];

export async function pullGmail(sq: Sequelize, a: any, http: GoogleHttp, now = new Date()): Promise<{ linked: number; seen: number }> {
  if (!(a.get("scopes") as string[]).some((s) => s.endsWith("/gmail.metadata"))) return { linked: 0, seen: 0 };
  const since = a.get("lastGmailSyncAt") ? new Date(a.get("lastGmailSyncAt")).getTime() - 3_600_000 : now.getTime() - 7 * 86_400_000;
  const me = String(a.get("externalEmail")).toLowerCase();
  const tenantId = a.get("tenantId"), userId = a.get("userId");
  const access = await loadAccess(sq, tenantId, userId);
  const ctx: RequestContext = { tenantId, userId, sessionId: "google-sync", correlationId: `corr_gmail_${randomUUID()}`, grants: access.grants, membership: access.membership, stepUpValid: false };
  let seen = 0, linked = 0, capped = false;
  for (const label of ["INBOX", "SENT"] as const) {
    let page: string | undefined, done = false;
    do {
      const q = new URLSearchParams({ labelIds: label, maxResults: "50" });
      if (page) q.set("pageToken", page);
      const list = await gcall(sq, a, http, `${GMAIL}/messages?${q}`);
      if (list.status !== 200) throw new ConflictError(`Gmail read failed (HTTP ${list.status})`);
      for (const m of list.json.messages ?? []) {
        if (seen >= 100) { capped = true; done = true; break; }
        const known = await sq.query("SELECT 1 FROM email_external_messages WHERE account_id=:a AND gmail_message_id=:g LIMIT 1", { replacements: { a: a.get("id"), g: m.id }, type: QueryTypes.SELECT });
        if (known.length) { done = true; break; } // newest first: everything older was handled before
        const g = await gcall(sq, a, http, `${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`);
        if (g.status !== 200) continue;
        seen++;
        const at = new Date(Number(g.json.internalDate ?? Date.now()));
        if (at.getTime() < since) { done = true; break; }
        const from = addresses(header(g.json, "From")), others = [...addresses(header(g.json, "To")), ...addresses(header(g.json, "Cc"))];
        const counterpart = (label === "INBOX" ? from : others).filter((x) => x !== me);
        const emails = counterpart.map((x) => normalizeEmail(x)).filter((x): x is string => !!x);
        let contactId: string | null = null;
        if (emails.length) {
          contactId = await withUow(sq, ctx, async (u) => {
            const scope = await scopeWhere(u, ctx, "contact.read", CONTACT_SCOPE).catch(() => null);
            if (!scope) return null;
            const c: any = await u.repo("Contact").findOne({ where: { [Op.and]: [{ normalizedEmail: { [Op.in]: emails } }, scope] }, attributes: ["id"], transaction: u.tx });
            return c ? (c.get("id") as string) : null;
          });
        }
        if (!contactId) continue; // only mail about people in the CRM is kept
        await sq.query("INSERT IGNORE INTO email_external_messages (id, tenant_id, account_id, gmail_message_id, thread_id, direction, contact_id, subject, from_address, to_addresses, message_at, created_at, updated_at) VALUES (:id,:t,:a,:g,:th,:d,:c,:s,:f,:to,:at,NOW(3),NOW(3))",
          { replacements: { id: randomUUID(), t: tenantId, a: a.get("id"), g: m.id, th: g.json.threadId ?? null, d: label === "INBOX" ? "in" : "out", c: contactId, s: header(g.json, "Subject").slice(0, 300) || null, f: from[0] ?? null, to: JSON.stringify(others.slice(0, 20)), at: mysqlDate(at) } });
        linked++;
      }
      page = done ? undefined : list.json.nextPageToken;
    } while (page);
  }
  if (!capped) await sq.query("UPDATE connected_accounts SET last_gmail_sync_at=:n WHERE id=:id AND tenant_id=:t", { replacements: { n: mysqlDate(now), id: a.get("id"), t: tenantId } });
  return { linked, seen };
}

/** Mail linked to a contact, for the mailbox owner only (a colleague's inbox is not shared through the CRM). */
export async function listContactEmails(sq: Sequelize, ctx: RequestContext, contactId: string) {
  mustConnect(ctx);
  return withUow(sq, ctx, async (u) => {
    const scope = await scopeWhere(u, ctx, "contact.read", CONTACT_SCOPE);
    if (!(await u.repo("Contact").findOne({ where: { [Op.and]: [{ id: contactId }, scope] }, attributes: ["id"], transaction: u.tx }))) throw new NotFoundError("Contact");
    const acct: any = await u.repo("ConnectedAccount").findOne({ where: { userId: ctx.userId, provider: "google" }, attributes: ["id"], transaction: u.tx });
    if (!acct) return [];
    return (await u.repo("EmailExternalMessage").findAll({ where: { accountId: acct.get("id"), contactId }, order: [["messageAt", "DESC"]], limit: 50, transaction: u.tx })).map(plain);
  });
}

// ---------------------------------------------------------------- orchestration

const CAL_EVERY_MS = 5 * 60_000, MAIL_EVERY_MS = 10 * 60_000;

/** Sync one account now. Errors are recorded on the account (never thrown into a sweep) so one broken connection does not stop the others. */
export async function syncGoogleAccount(sq: Sequelize, accountId: string, o: { http?: GoogleHttp; now?: Date; force?: boolean } = {}) {
  const http = o.http ?? fetchHttp, now = o.now ?? new Date();
  const [row] = await sq.query<{ id: string }>("SELECT id FROM connected_accounts WHERE id=:id", { replacements: { id: accountId }, type: QueryTypes.SELECT });
  if (!row) throw new NotFoundError("Google connection");
  const a: any = await initModels(sq).ConnectedAccount.findByPk(accountId);
  if (!a || a.get("status") === "revoked") return null;
  const out: { calendar?: unknown; busy?: unknown; gmail?: unknown; error?: string } = {};
  try {
    const last = a.get("lastCalendarSyncAt") ? new Date(a.get("lastCalendarSyncAt")).getTime() : 0;
    if (a.get("syncCalendar") && (o.force || a.get("calendarDirty") || now.getTime() - last >= CAL_EVERY_MS)) {
      await sq.query("UPDATE connected_accounts SET calendar_dirty=0 WHERE id=:id", { replacements: { id: accountId } });
      out.calendar = await pushCalendar(sq, a, http, now);
      out.busy = await pullBusy(sq, a, http, now);
      await ensureCalendarChannel(sq, a, http, now);
      await sq.query("UPDATE connected_accounts SET last_calendar_sync_at=:n WHERE id=:id", { replacements: { n: mysqlDate(now), id: accountId } });
    }
    const lastMail = a.get("lastGmailSyncAt") ? new Date(a.get("lastGmailSyncAt")).getTime() : 0;
    if (a.get("syncGmail") && (o.force || now.getTime() - lastMail >= MAIL_EVERY_MS)) out.gmail = await pullGmail(sq, a, http, now);
    await sq.query("UPDATE connected_accounts SET last_error=NULL, status='active' WHERE id=:id AND status<>'revoked'", { replacements: { id: accountId } });
  } catch (e) {
    out.error = String((e as Error).message ?? e).slice(0, 280);
    await sq.query("UPDATE connected_accounts SET last_error=:e, status=IF(status='revoked','revoked','error') WHERE id=:id", { replacements: { e: out.error, id: accountId } });
    logger.warn({ accountId, err: out.error }, "google sync failed");
  }
  return out;
}

/** The user's own "Sync now" button. */
export async function syncMyGoogle(sq: Sequelize, ctx: RequestContext, http: GoogleHttp = fetchHttp) {
  mustConnect(ctx);
  const a: any = await ownAccount(sq, ctx);
  if (!a || a.get("status") === "revoked") throw new NotFoundError("Google connection");
  return syncGoogleAccount(sq, a.get("id"), { http, force: true });
}

/** Scheduler pass for one tenant: every connected account that is due. A failing account (status error) is retried on later passes. */
export async function googleSyncSweep(sq: Sequelize, ctx: RequestContext, http: GoogleHttp = fetchHttp): Promise<number> {
  if (!googleConfig()) return 0;
  const rows = await sq.query<{ id: string }>("SELECT id FROM connected_accounts WHERE tenant_id=:t AND status IN ('active','error') AND (sync_calendar=1 OR sync_gmail=1)", { replacements: { t: ctx.tenantId }, type: QueryTypes.SELECT });
  let n = 0;
  for (const r of rows) { const out = await syncGoogleAccount(sq, r.id, { http }); if (out && !out.error) n++; }
  return n;
}

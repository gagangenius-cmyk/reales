import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import { createContact, completeGoogleConnect, completeTask, createTask, disconnectGoogle, getGoogleStatus, handleCalendarPush, listContactEmails, startGoogleConnect, syncGoogleAccount, syncMyGoogle, updateGoogleSettings, freeSlots, type GoogleHttp } from "@reales/domain";
import { encryptField } from "@reales/auth";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, makeTenant, makeUser, testDb, uniq } from "./helpers";

const sq = () => testDb();
afterAll(closeTestDb);

const env = { ...process.env };
beforeAll(() => {
  process.env.GOOGLE_CLIENT_ID = "client-id.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret-value";
  process.env.PUBLIC_BASE_URL = "https://crm.example.test";
});
afterAll(() => { for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "PUBLIC_BASE_URL"]) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } });

const idToken = (email: string) => `h.${Buffer.from(JSON.stringify({ email, email_verified: true })).toString("base64url")}.s`;
const ALL = "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.metadata";

/** A scripted Google: records every call and answers the endpoints the sync uses. */
function fakeGoogle(o: { email?: string; scope?: string; refresh?: boolean; busy?: any[]; messages?: any[]; tokenError?: string } = {}) {
  const calls: { url: string; method: string; body: any }[] = [];
  const events = new Map<string, any>();
  let n = 0;
  const http: GoogleHttp = async (url, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body && init.headers?.["content-type"]?.includes("json") ? JSON.parse(init.body) : init?.body;
    calls.push({ url, method, body });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      if (o.tokenError) return { status: 400, json: { error: o.tokenError } };
      const refresh = String(init?.body).includes("grant_type=refresh_token");
      return { status: 200, json: { access_token: `at-${++n}`, expires_in: 3600, ...(refresh || o.refresh === false ? {} : { refresh_token: "rt-secret-1" }), scope: o.scope ?? ALL, id_token: idToken(o.email ?? "agent@gmail.test") } };
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return { status: 200, json: {} };
    if (url.includes("/calendar/v3/calendars/primary/events/watch")) return { status: 200, json: { expiration: String(Date.now() + 7 * 86_400_000) } };
    if (url.includes("/calendars/primary/events") && method === "POST") { const id = `g${++n}`; events.set(id, body); return { status: 200, json: { id } }; }
    if (url.includes("/calendars/primary/events/") && method === "PATCH") { const id = decodeURIComponent(url.split("/events/")[1]!.split("?")[0]!); events.set(id, body); return { status: 200, json: { id } }; }
    if (url.includes("/calendars/primary/events/") && method === "DELETE") { events.delete(decodeURIComponent(url.split("/events/")[1]!)); return { status: 204, json: null }; }
    if (url.includes("/calendars/primary/events")) return { status: 200, json: { items: o.busy ?? [], nextSyncToken: "sync-1" } };
    if (url.includes("/gmail/v1/users/me/messages?")) return { status: 200, json: { messages: (o.messages ?? []).filter((m) => url.includes(`labelIds=${m.label}`)).map((m) => ({ id: m.id })) } };
    const g = url.match(/messages\/([^?]+)\?format=metadata/);
    if (g) { const m = (o.messages ?? []).find((x) => x.id === g[1]); return m ? { status: 200, json: { id: m.id, threadId: `th-${m.id}`, internalDate: String(Date.now() - 60_000), payload: { headers: [{ name: "From", value: m.from }, { name: "To", value: m.to }, { name: "Subject", value: m.subject }] } } } : { status: 404, json: null }; }
    return { status: 404, json: null };
  };
  return { http, calls, events };
}

async function connected(opts: Parameters<typeof fakeGoogle>[0] = {}) {
  const t = await makeTenant();
  const user = await makeUser(t, ["agent"]);
  const g = fakeGoogle(opts);
  const { url } = await startGoogleConnect(sq(), user.ctx);
  const state = new URL(url).searchParams.get("state")!;
  const account: any = await completeGoogleConnect(sq(), user.ctx, { code: "auth-code-123456", state }, g.http);
  return { t, user, g, account, url, state };
}

describe("Google connection", () => {
  it("builds the consent address, binds the state to the person, and stores tokens encrypted and out of every response", async () => {
    const { user, g, account, url, state, t } = await connected();
    const q = new URL(url).searchParams;
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("scope")).toContain("gmail.metadata");
    expect(q.get("client_id")).toBe(process.env.GOOGLE_CLIENT_ID);
    expect(account).toMatchObject({ email: "agent@gmail.test", status: "active", syncCalendar: true, syncGmail: false });
    expect(JSON.stringify(account)).not.toMatch(/rt-secret|at-1|Token|token/);
    const status: any = await getGoogleStatus(sq(), user.ctx);
    expect(status.configured).toBe(true);
    expect(JSON.stringify(status)).not.toMatch(/rt-secret|at-1/);
    const [row] = await sq().query<any>("SELECT access_token_enc, refresh_token_enc FROM connected_accounts WHERE user_id=:u", { replacements: { u: user.id }, type: QueryTypes.SELECT });
    expect(row.refresh_token_enc).toMatch(/^v1\./);
    expect(row.refresh_token_enc).not.toContain("rt-secret-1");
    expect(row.access_token_enc).not.toContain("at-1");
    // the state belongs to this person only, and is rejected when forged or reused by someone else
    const other = await makeUser(t, ["agent"]);
    await expect(completeGoogleConnect(sq(), other.ctx, { code: "auth-code-123456", state }, g.http)).rejects.toThrow(/belongs to someone else/);
    await expect(completeGoogleConnect(sq(), user.ctx, { code: "auth-code-123456", state: "garbage" }, g.http)).rejects.toThrow(/not valid/);
    const expired = encryptField(JSON.stringify({ u: user.id, t: t.tenantId, exp: Date.now() - 1000, n: "x" }));
    await expect(completeGoogleConnect(sq(), user.ctx, { code: "auth-code-123456", state: expired }, g.http)).rejects.toThrow(/expired/);
  });

  it("refuses without permission or configuration, and when Calendar access or an offline token is missing", async () => {
    const t = await makeTenant();
    const viewer = await makeUser(t, ["viewer"]);
    await expect(startGoogleConnect(sq(), viewer.ctx)).rejects.toBeInstanceOf(ForbiddenError);
    const user = await makeUser(t, ["agent"]);
    const { url } = await startGoogleConnect(sq(), user.ctx);
    const state = new URL(url).searchParams.get("state")!;
    await expect(completeGoogleConnect(sq(), user.ctx, { code: "auth-code-123456", state }, fakeGoogle({ scope: "openid email" }).http)).rejects.toThrow(/Calendar access was not granted/);
    await expect(completeGoogleConnect(sq(), user.ctx, { code: "auth-code-123456", state }, fakeGoogle({ refresh: false }).http)).rejects.toThrow(/offline token/);
    const saved = { ...process.env };
    delete process.env.GOOGLE_CLIENT_ID;
    await expect(startGoogleConnect(sq(), user.ctx)).rejects.toThrow(/not configured/);
    Object.assign(process.env, saved);
  });
});

describe("Calendar sync", () => {
  it("pushes open tasks, updates and removes them, reads busy blocks without titles, and blocks double-booking", async () => {
    const { t, user, g } = await connected({ busy: [{ id: "ext1", status: "confirmed", summary: "Dentist (private)", start: { dateTime: new Date(Date.now() + 3 * 86_400_000).toISOString() }, end: { dateTime: new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString() } }] });
    const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const task: any = await createTask(sq(), user.ctx, { title: "Call the buyer", dueAt: due });
    const [{ id: accountId }] = await sq().query<any>("SELECT id FROM connected_accounts WHERE user_id=:u", { replacements: { u: user.id }, type: QueryTypes.SELECT });

    const first: any = await syncGoogleAccount(sq(), accountId, { http: g.http, force: true });
    expect(first.error).toBeUndefined();
    expect(first.calendar).toMatchObject({ created: 1, updated: 0, deleted: 0 });
    const pushed = [...g.events.values()][0];
    expect(pushed.summary).toBe("Task: Call the buyer");
    expect(pushed.extendedProperties.private).toMatchObject({ reales: "1", localType: "task", localId: task.id });
    // unchanged -> nothing re-sent
    const again: any = await syncGoogleAccount(sq(), accountId, { http: g.http, force: true });
    expect(again.calendar).toMatchObject({ created: 0, updated: 0, deleted: 0 });
    // completed -> removed from Google
    await completeTask(sq(), user.ctx, task.id);
    const done: any = await syncGoogleAccount(sq(), accountId, { http: g.http, force: true });
    expect(done.calendar).toMatchObject({ deleted: 1 });
    expect(g.events.size).toBe(0);

    // Google events come back only as busy times: no title stored anywhere
    const blocks = await sq().query<any>("SELECT * FROM calendar_external_events WHERE account_id=:a AND busy_only=1", { replacements: { a: accountId }, type: QueryTypes.SELECT });
    expect(blocks).toHaveLength(1);
    expect(JSON.stringify(blocks)).not.toContain("Dentist");
    const day = new Date(Date.now() + 3 * 86_400_000 + 4 * 3_600_000).toISOString().slice(0, 10); // Dubai calendar day of the busy block
    const slots: any = await freeSlots(sq(), t.admin, user.id, day, 30, 30);
    const blockStart = new Date(blocks[0].starts_at).getTime(), blockEnd = new Date(blocks[0].ends_at).getTime();
    expect(slots.slots.every((s: string) => { const x = new Date(s).getTime(); return !(x < blockEnd && blockStart < x + 30 * 60_000); })).toBe(true);
    // a stored sync token means the next read is incremental
    const [acct] = await sq().query<any>("SELECT calendar_sync_token, channel_id, channel_token_hash FROM connected_accounts WHERE id=:a", { replacements: { a: accountId }, type: QueryTypes.SELECT });
    expect(acct.calendar_sync_token).toBe("sync-1");
    expect(g.calls.some((c) => c.url.includes("syncToken=sync-1"))).toBe(true);
    expect(g.calls.some((c) => c.url.includes("/events/watch"))).toBe(true);
    expect(acct.channel_id).toBeTruthy();
  });

  it("accepts push notifications only with the secret channel token", async () => {
    const { user, g } = await connected();
    const [{ id: accountId }] = await sq().query<any>("SELECT id FROM connected_accounts WHERE user_id=:u", { replacements: { u: user.id }, type: QueryTypes.SELECT });
    await syncGoogleAccount(sq(), accountId, { http: g.http, force: true });
    const watch = g.calls.find((c) => c.url.includes("/events/watch"))!;
    expect(await handleCalendarPush(sq(), watch.body.id, "wrong-token")).toBe(false);
    expect(await handleCalendarPush(sq(), "unknown-channel", watch.body.token)).toBe(false);
    expect(await handleCalendarPush(sq(), null, null)).toBe(false);
    await sq().query("UPDATE connected_accounts SET calendar_dirty=0 WHERE id=:a", { replacements: { a: accountId } });
    expect(await handleCalendarPush(sq(), watch.body.id, watch.body.token)).toBe(true);
    const [row] = await sq().query<any>("SELECT calendar_dirty FROM connected_accounts WHERE id=:a", { replacements: { a: accountId }, type: QueryTypes.SELECT });
    expect(Number(row.calendar_dirty)).toBe(1);
  });

  it("marks the connection revoked when Google says the grant is gone, and records errors without throwing", async () => {
    const { user, g } = await connected();
    const [{ id: accountId }] = await sq().query<any>("SELECT id FROM connected_accounts WHERE user_id=:u", { replacements: { u: user.id }, type: QueryTypes.SELECT });
    await sq().query("UPDATE connected_accounts SET access_expires_at = '2000-01-01 00:00:00' WHERE id=:a", { replacements: { a: accountId } });
    const out: any = await syncGoogleAccount(sq(), accountId, { http: fakeGoogle({ tokenError: "invalid_grant" }).http, force: true });
    expect(out.error).toMatch(/revoked/);
    const status: any = await getGoogleStatus(sq(), user.ctx);
    expect(status.account).toMatchObject({ status: "revoked" });
    expect(await syncGoogleAccount(sq(), accountId, { http: g.http, force: true })).toBeNull(); // revoked accounts are skipped
    await expect(syncMyGoogle(sq(), user.ctx, g.http)).rejects.toThrow(/not found/i);
  });
});

describe("Gmail metadata", () => {
  it("links mail to contacts the owner can see, keeps no body, and shows it only to the mailbox owner", async () => {
    const t = await makeTenant();
    const user = await makeUser(t, ["agent"]);
    const colleague = await makeUser(t, ["agent"]);
    const email = `${uniq("buyer")}@client.test`;
    const contact: any = await createContact(sq(), user.ctx, { firstName: "Aisha", email, phone: `05${String(50000000 + Math.floor(Math.random() * 9999999))}` });
    const stranger = `${uniq("nobody")}@elsewhere.test`;
    const g = fakeGoogle({ messages: [
      { id: "m1", label: "INBOX", from: `Aisha <${email}>`, to: "agent@gmail.test", subject: "Viewing on Saturday?" },
      { id: "m2", label: "SENT", from: "agent@gmail.test", to: email, subject: "Re: Viewing on Saturday?" },
      { id: "m3", label: "INBOX", from: stranger, to: "agent@gmail.test", subject: "Newsletter" },
    ] });
    const { url } = await startGoogleConnect(sq(), user.ctx);
    await completeGoogleConnect(sq(), user.ctx, { code: "auth-code-123456", state: new URL(url).searchParams.get("state")! }, g.http);
    await updateGoogleSettings(sq(), user.ctx, { syncGmail: true });
    const [{ id: accountId }] = await sq().query<any>("SELECT id FROM connected_accounts WHERE user_id=:u", { replacements: { u: user.id }, type: QueryTypes.SELECT });
    const out: any = await syncGoogleAccount(sq(), accountId, { http: g.http, force: true });
    expect(out.error).toBeUndefined();
    expect(out.gmail).toMatchObject({ linked: 2 });

    const mine: any[] = await listContactEmails(sq(), user.ctx, contact.id);
    expect(mine.map((m) => [m.direction, m.subject]).sort()).toEqual([["in", "Viewing on Saturday?"], ["out", "Re: Viewing on Saturday?"]]);
    expect(Object.keys(mine[0]).join(",")).not.toMatch(/body|snippet/i);
    expect(g.calls.every((c) => !/format=full|format=raw/.test(c.url))).toBe(true); // bodies are never requested
    expect(await sq().query("SELECT 1 FROM email_external_messages WHERE gmail_message_id='m3'", { type: QueryTypes.SELECT })).toHaveLength(0); // not about a contact
    // a second run finds nothing new and stores no duplicates
    await syncGoogleAccount(sq(), accountId, { http: g.http, force: true });
    expect(await sq().query("SELECT 1 FROM email_external_messages WHERE account_id=:a", { replacements: { a: accountId }, type: QueryTypes.SELECT })).toHaveLength(2);
    // a colleague, even one who can see the contact, never sees this mailbox
    expect(await listContactEmails(sq(), colleague.ctx, contact.id).catch(() => [])).toEqual([]);
    // gmail needs the permission the person granted
    const noGmail = fakeGoogle({ scope: "openid email https://www.googleapis.com/auth/calendar.events" });
    const u2 = await makeUser(t, ["agent"]);
    const s2 = new URL((await startGoogleConnect(sq(), u2.ctx)).url).searchParams.get("state")!;
    await completeGoogleConnect(sq(), u2.ctx, { code: "auth-code-123456", state: s2 }, noGmail.http);
    await expect(updateGoogleSettings(sq(), u2.ctx, { syncGmail: true })).rejects.toThrow(/Gmail access was not granted/);
  });

  it("forgets tokens and synced data on disconnect and revokes at Google", async () => {
    const { user, g } = await connected();
    await disconnectGoogle(sq(), user.ctx, g.http);
    const [row] = await sq().query<any>("SELECT status, access_token_enc, refresh_token_enc, sync_gmail FROM connected_accounts WHERE user_id=:u", { replacements: { u: user.id }, type: QueryTypes.SELECT });
    expect(row).toMatchObject({ status: "revoked", access_token_enc: null, refresh_token_enc: null });
    expect(g.calls.some((c) => c.url.includes("/revoke"))).toBe(true);
  });
});

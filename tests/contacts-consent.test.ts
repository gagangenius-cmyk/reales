import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  addSuppression, createContact, createLead, DuplicateContactError, evaluateContactability, getContact, liftSuppression, listContacts,
  normalizeEmail, normalizePhone, NotFoundError, recordConsent, createRoutingRule, updateContact, listConsent,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, contextFor, makeTenant, testDb, uniq } from "./helpers";
import { agentIn, makeOrg } from "./brokerage-helpers";

afterAll(closeTestDb);
const sq = () => testDb();

describe("normalisation", () => {
  it("normalises UAE phone formats to E.164 and rejects garbage", () => {
    for (const raw of ["0501234567", "+971 50 123 4567", "00971501234567", "971501234567", "050-123-4567"]) expect(normalizePhone(raw)).toBe("+971501234567");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    for (const bad of ["", "abc", "12", "0000", null, undefined]) expect(normalizePhone(bad as any)).toBeNull();
    expect(normalizeEmail("  Ahmed@Example.COM ")).toBe("ahmed@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
  });
});

describe("contacts", () => {
  it("detects duplicates across phone formats and email case, unless explicitly allowed", async () => {
    const t = await makeTenant();
    const a = await createContact(sq(), t.admin, { firstName: "Ahmed", phone: "0501234567", email: "Ahmed@X.com" });
    expect(a.phoneE164).toBe("+971501234567");
    await expect(createContact(sq(), t.admin, { firstName: "Ahmed 2", phone: "+971 50 123 4567" })).rejects.toBeInstanceOf(DuplicateContactError);
    await expect(createContact(sq(), t.admin, { firstName: "Other", email: "ahmed@x.COM" })).rejects.toMatchObject({ matchCount: 1 });
    const forced = await createContact(sq(), t.admin, { firstName: "Ahmed 3", phone: "0501234567", allowDuplicate: true });
    expect(forced.id).not.toBe(a.id);
  });

  it("does not leak contacts the caller cannot see through the duplicate check", async () => {
    const t = await makeTenant();
    const { bu, marina } = await makeOrg(t);
    const agentA = await agentIn(t, marina.id, bu.id);
    const agentB = await agentIn(t, marina.id, bu.id);
    await createContact(sq(), agentA.ctx, { firstName: "Private", phone: "0509998888" });
    const err: any = await createContact(sq(), agentB.ctx, { firstName: "Probe", phone: "0509998888" }).catch((e) => e);
    expect(err).toBeInstanceOf(DuplicateContactError);
    expect(err.matchCount).toBe(1);
    expect(err.visibleMatches).toEqual([]); // agent B may know a duplicate exists, but not who or what it is
  });

  it("scopes reads: own records for agents, branch for managers, everything for admins", async () => {
    const t = await makeTenant();
    const { bu, marina, bay } = await makeOrg(t);
    const agentA = await agentIn(t, marina.id, bu.id);
    const agentB = await agentIn(t, marina.id, bu.id);
    const mgrMarina = await agentIn(t, marina.id, bu.id, "branch_manager");
    const mgrBay = await agentIn(t, bay.id, bu.id, "branch_manager");
    const c = await createContact(sq(), agentA.ctx, { firstName: "Scoped", phone: "0507771111" });

    await expect(getContact(sq(), agentA.ctx, c.id)).resolves.toMatchObject({ id: c.id });
    await expect(getContact(sq(), agentB.ctx, c.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getContact(sq(), mgrMarina.ctx, c.id)).resolves.toMatchObject({ id: c.id });
    await expect(getContact(sq(), mgrBay.ctx, c.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getContact(sq(), t.admin, c.id)).resolves.toMatchObject({ id: c.id });

    expect((await listContacts(sq(), agentB.ctx, { limit: 50, offset: 0 })).map((x: any) => x.id)).not.toContain(c.id);
    expect((await listContacts(sq(), agentA.ctx, { limit: 50, offset: 0, q: "Scoped" })).map((x: any) => x.id)).toEqual([c.id]);
    await expect(updateContact(sq(), agentB.ctx, c.id, { firstName: "Hijack" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateContact(sq(), mgrMarina.ctx, c.id, { firstName: "Renamed" })).resolves.toMatchObject({ firstName: "Renamed" });
  });

  it("lets an agent read the contact of a lead that was routed to them", async () => {
    const t = await makeTenant();
    const { bu, marina } = await makeOrg(t);
    const creator = await agentIn(t, marina.id, bu.id);
    const worker = await agentIn(t, marina.id, bu.id);
    await createRoutingRule(sq(), t.admin, { name: "all", conditions: {}, target: { userIds: [worker.id] } });
    const r = await createLead(sq(), creator.ctx, { contact: { firstName: "Routed", phone: "0506660000" }, purpose: "buy", sourceCode: "website" });
    expect(r.assignedUserId).toBe(worker.id);
    const workerCtx = await contextFor(t.tenantId, worker.id); // refresh grants/membership
    await expect(getContact(sq(), workerCtx, r.lead.contactId)).resolves.toMatchObject({ id: r.lead.contactId });
  });

  it("refuses invalid phone/email and cross-tenant reads", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    await expect(createContact(sq(), a.admin, { firstName: "Bad", phone: "12" })).rejects.toThrow(/Invalid phone/);
    await expect(createContact(sq(), a.admin, { firstName: "Bad", email: "nope" })).rejects.toThrow(/Invalid email/);
    const c = await createContact(sq(), a.admin, { firstName: "A-only", phone: "0501110000" });
    await expect(getContact(sq(), b.admin, c.id)).rejects.toBeInstanceOf(NotFoundError);
    // the same phone number is a fine, separate contact in another tenant
    await expect(createContact(sq(), b.admin, { firstName: "B copy", phone: "0501110000" })).resolves.toBeTruthy();
  });
});

describe("consent and suppression", () => {
  it("gates marketing on granted, channel-specific consent and honours revocation + suppression", async () => {
    const t = await makeTenant();
    const c = await createContact(sq(), t.admin, { firstName: "Consenting", phone: "0503334444", email: "c@x.com" });
    const check = (channel: any, purposeCode = "marketing") => evaluateContactability(sq(), t.tenantId, { contactId: c.id, channel, purposeCode });

    expect((await check("whatsapp")).reasons).toContain("no_consent");
    await recordConsent(sq(), t.admin, { contactId: c.id, purposeCode: "marketing", channel: "whatsapp", granted: true, textVersion: "v3", text: "I agree to receive offers", source: "web_form" });
    expect(await check("whatsapp")).toMatchObject({ allowed: true, destination: "+971503334444" });
    expect((await check("email")).reasons).toContain("no_consent"); // consent is per channel
    expect((await check("sms")).allowed).toBe(false);

    await recordConsent(sq(), t.admin, { contactId: c.id, purposeCode: "marketing", channel: "whatsapp", granted: false, source: "reply_stop", suppress: true });
    const after = await check("whatsapp");
    expect(after.allowed).toBe(false);
    expect(after.reasons).toEqual(expect.arrayContaining(["no_consent", "suppressed:unsubscribed"]));

    // A service message relies on contract, not consent - but suppression still blocks it.
    expect((await check("email", "service")).allowed).toBe(true);
    expect((await check("whatsapp", "service")).reasons).toEqual(["suppressed:unsubscribed"]);
    expect((await check("call", "unknown")).reasons).toContain("unknown_purpose");
  });

  it("keeps an immutable, evidence-bearing event history", async () => {
    const t = await makeTenant();
    const c = await createContact(sq(), t.admin, { firstName: "Evidence", email: "e@x.com" });
    await recordConsent(sq(), t.admin, { contactId: c.id, purposeCode: "marketing", channel: "email", granted: true, textVersion: "2026-09", text: "Yes please", source: "landing_page", ip: "203.0.113.9" });
    await recordConsent(sq(), t.admin, { contactId: c.id, purposeCode: "marketing", channel: "email", granted: false, source: "unsubscribe_link" });
    const { records, events } = await listConsent(sq(), t.admin, c.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "revoked" });
    expect(events.map((e: any) => e.event).sort()).toEqual(["granted", "revoked"]);
    const granted: any = events.find((e: any) => e.event === "granted");
    expect(granted).toMatchObject({ textVersion: "2026-09", source: "landing_page", ip: "203.0.113.9" });
    expect(granted.textHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(sq().query("UPDATE consent_events SET event='granted' WHERE tenant_id=:t", { replacements: { t: t.tenantId } })).rejects.toThrow(/append-only/);
    await expect(sq().query("DELETE FROM consent_events WHERE tenant_id=:t", { replacements: { t: t.tenantId } })).rejects.toThrow(/append-only/);
  });

  it("requires step-up, a reason and an audit entry to lift a suppression", async () => {
    const t = await makeTenant();
    const s = await addSuppression(sq(), t.admin, { channel: "sms", destination: "0501212121", reason: "complaint" });
    expect(s.destination).toBe("+971501212121");
    expect((await addSuppression(sq(), t.admin, { channel: "sms", destination: "+971 50 121 2121", reason: "manual" })).id).toBe(s.id); // idempotent
    const noStepUp = await contextFor(t.tenantId, t.adminId, { stepUp: false });
    await expect(liftSuppression(sq(), noStepUp, s.id, "customer asked to resume messages")).rejects.toMatchObject({ code: "step_up_required" });
    await expect(liftSuppression(sq(), t.admin, s.id, "short")).rejects.toThrow(/reason/);
    await liftSuppression(sq(), t.admin, s.id, "customer asked to resume messages");
    const rows = await sq().query<{ action: string; reason: string }>("SELECT action, reason FROM audit_events WHERE tenant_id=:t AND action='suppression.lifted'", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe("customer asked to resume messages");
  });

  it("restricts who may record consent and never crosses tenants", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const { bu, marina } = await makeOrg(a);
    const owner = await agentIn(a, marina.id, bu.id);
    const other = await agentIn(a, marina.id, bu.id);
    const c = await createContact(sq(), owner.ctx, { firstName: "Mine", phone: "0508887777" });
    await expect(recordConsent(sq(), other.ctx, { contactId: c.id, purposeCode: "marketing", channel: "sms", granted: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordConsent(sq(), owner.ctx, { contactId: c.id, purposeCode: "marketing", channel: "sms", granted: true })).resolves.toBeTruthy();
    await expect(recordConsent(sq(), b.admin, { contactId: c.id, purposeCode: "marketing", channel: "sms", granted: true })).rejects.toBeInstanceOf(NotFoundError);
    expect(await evaluateContactability(sq(), b.tenantId, { contactId: c.id, channel: "sms", purposeCode: "marketing" })).toMatchObject({ allowed: false, reasons: ["contact_not_found"] });
    void uniq;
  });
});

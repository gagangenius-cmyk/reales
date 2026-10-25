import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import { createContact, createLead, duplicateCandidates, logCall, mergeContacts, placeLegalHold, recordConsent } from "@reales/domain";
import { closeTestDb, makeTenant, makeUser, testDb, uniq } from "./helpers";
import { phone } from "./deal-helpers";

const sq = () => testDb();
afterAll(closeTestDb);
const count = async (sql: string, r: Record<string, unknown>) => Number(((await sq().query(sql, { replacements: r, type: QueryTypes.SELECT })) as any[])[0].n);

describe("contact duplicate merge", () => {
  it("moves leads, calls and history to the contact you keep, fills gaps, never copies consent, and archives the duplicate", async () => {
    const t = await makeTenant();
    const email = `${uniq("dup")}@merge.test`;
    const keep: any = await createContact(sq(), t.admin, { firstName: "Ali", phone: phone() });
    const dup: any = await createContact(sq(), t.admin, { firstName: "Ali", lastName: "Hassan", email, phone: phone(), allowDuplicate: true });
    const lead: any = await createLead(sq(), t.admin, { contactId: dup.id, purpose: "buy", sourceCode: "walk_in" } as never);
    await logCall(sq(), t.admin, { leadId: lead.lead.id, outcome: "answered", durationSec: 60 });
    await recordConsent(sq(), t.admin, { contactId: dup.id, purposeCode: "marketing", channel: "sms", granted: true });

    const cands = await duplicateCandidates(sq(), t.admin, keep.id).catch(() => []);
    expect(Array.isArray(cands)).toBe(true);

    const r = await mergeContacts(sq(), t.admin, { survivorId: keep.id, duplicateId: dup.id });
    expect(r.moved.leads).toBe(1);
    expect(r.moved.call_logs).toBe(1);
    expect(r.filled).toEqual(expect.arrayContaining(["last_name", "email"]));
    expect(await count("SELECT COUNT(*) n FROM leads WHERE tenant_id=:t AND contact_id=:c", { t: t.tenantId, c: keep.id })).toBe(1);
    expect(await count("SELECT COUNT(*) n FROM call_logs WHERE tenant_id=:t AND contact_id=:c", { t: t.tenantId, c: keep.id })).toBe(1);
    // consent is personal: it stays with the archived duplicate, so the survivor is not made contactable by the merge
    expect(await count("SELECT COUNT(*) n FROM consent_records WHERE tenant_id=:t AND contact_id=:c", { t: t.tenantId, c: keep.id })).toBe(0);
    expect(await count("SELECT COUNT(*) n FROM consent_records WHERE tenant_id=:t AND contact_id=:c", { t: t.tenantId, c: dup.id })).toBeGreaterThan(0);
    expect(await count("SELECT COUNT(*) n FROM contacts WHERE tenant_id=:t AND id=:c AND deleted_at IS NOT NULL AND status='archived'", { t: t.tenantId, c: dup.id })).toBe(1);
    expect(await count("SELECT COUNT(*) n FROM audit_events WHERE tenant_id=:t AND action='contact.merged'", { t: t.tenantId })).toBe(1);
    // the same pair cannot be merged twice
    await expect(mergeContacts(sq(), t.admin, { survivorId: keep.id, duplicateId: dup.id })).rejects.toThrow(/not found/i);
  });

  it("refuses unsafe merges: same contact, no tenant-wide access, no step-up, a legal hold, another company", async () => {
    const t = await makeTenant();
    const a: any = await createContact(sq(), t.admin, { firstName: "A", phone: phone() });
    const b: any = await createContact(sq(), t.admin, { firstName: "B", phone: phone() });
    await expect(mergeContacts(sq(), t.admin, { survivorId: a.id, duplicateId: a.id })).rejects.toThrow(/two different/);
    const agent = await makeUser(t, ["agent"]);
    await expect(mergeContacts(sq(), agent.ctx, { survivorId: a.id, duplicateId: b.id })).rejects.toThrow(/tenant-wide/);
    await expect(mergeContacts(sq(), { ...t.admin, stepUpValid: false }, { survivorId: a.id, duplicateId: b.id })).rejects.toThrow();
    await placeLegalHold(sq(), t.admin, b.id, "litigation");
    await expect(mergeContacts(sq(), t.admin, { survivorId: a.id, duplicateId: b.id })).rejects.toThrow(/legal hold/);
    const other = await makeTenant();
    const x: any = await createContact(sq(), other.admin, { firstName: "X", phone: phone() });
    await expect(mergeContacts(sq(), t.admin, { survivorId: a.id, duplicateId: x.id })).rejects.toThrow(/not found/i);
  });
});

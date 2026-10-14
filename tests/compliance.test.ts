import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  addCaseNote, addKycDocument, advanceDealStage, closeCase, closeDsr, completeMilestone, computeRisk, createContact, createDocument, createDsr, DealBlockedError, disposeHit,
  dsrSweep, exportReportedCases, fulfilAccessRequest, fulfilErasureRequest, getKycProfileByContact, getUboGraph, kycExpirySweep, linkUbo, listCases, placeLegalHold,
  releaseLegalHold, revealIdentity, reviewKyc, runRetention, runScreening, setRetentionPolicy, setStorage, LocalObjectStorage, submitKyc, upsertKycProfile,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeTestDb, contextFor, makeTenant, makeUser, testDb } from "./helpers";
import { kit, openDeal, phone } from "./deal-helpers";

const sq = () => testDb();
const dir = mkdtempSync(path.join(tmpdir(), "reales-kyc-"));
setStorage(new LocalObjectStorage(dir));
afterAll(async () => { setStorage(null); rmSync(dir, { recursive: true, force: true }); await closeTestDb(); });

const pdf = () => Buffer.from(`%PDF-1.4\n% id ${Math.random()}\n%%EOF\n`);
const setting = (tenantId: string, key: string, json: string) =>
  sq().query("INSERT INTO tenant_settings (id, tenant_id, `key`, value, created_at, updated_at) VALUES (UUID(), :t, :k, CAST(:v AS JSON), NOW(3), NOW(3))", { replacements: { t: tenantId, k: key, v: json } });

async function ckit() {
  const t = await makeTenant();
  const maker = await makeUser(t, ["compliance_officer"]);
  const checker = await makeUser(t, ["compliance_officer"]);
  const makerCtx = await contextFor(t.tenantId, maker.id, { stepUp: true });
  const checkerCtx = await contextFor(t.tenantId, checker.id, { stepUp: true });
  return { t, maker, checker, makerCtx, checkerCtx };
}
type C = Awaited<ReturnType<typeof ckit>>;

async function readyProfile(c: C, name = "Amira Haddad", extra: Record<string, unknown> = {}) {
  const contact = await createContact(sq(), c.t.admin, { firstName: name.split(" ")[0]!, lastName: name.split(" ")[1], phone: phone() });
  await upsertKycProfile(sq(), c.makerCtx, contact.id, { idType: "passport", idNumber: "P1234567890", dateOfBirth: "1985-04-02", nationality: "Jordan", sourceOfFunds: "Salary", ...extra });
  const profile = (await getKycProfileByContact(sq(), c.makerCtx, contact.id))!;
  const doc = await createDocument(sq(), c.t.admin, { title: "Passport", kind: "id_document", file: { filename: "p.pdf", mime: "application/pdf", bytes: pdf() } });
  await addKycDocument(sq(), c.makerCtx, profile.id, { documentId: doc.id, docType: "passport", expiresOn: "2040-01-01" });
  return { contact, profile };
}

describe("risk scoring", () => {
  it("is deterministic and every point has a named factor", () => {
    const a = computeRisk({ isPep: true, countries: ["Iran"], highRiskCountries: ["iran"], hasSourceOfFunds: false, isEntity: false, uboIdentified: true, openHits: 0, trueMatches: 0 });
    expect(a.score).toBe(80);
    expect(a.level).toBe("high");
    expect(a.factors.map((f) => f.code)).toEqual(["pep", "high_risk_country", "no_source_of_funds"]);
    expect(computeRisk({ isPep: false, countries: [], highRiskCountries: [], hasSourceOfFunds: true, isEntity: false, uboIdentified: true, openHits: 0, trueMatches: 0 })).toMatchObject({ score: 0, level: "low" });
    expect(computeRisk({ isPep: false, countries: [], highRiskCountries: [], hasSourceOfFunds: false, isEntity: true, uboIdentified: false, openHits: 0, trueMatches: 0 }).level).toBe("medium");
  });
});

describe("KYC profiles", () => {
  it("encrypts identity data at rest, masks it in views, and reveals it only with step-up and an audit entry", async () => {
    const c = await ckit();
    const { profile } = await readyProfile(c);
    expect(profile).not.toHaveProperty("idNumberEnc");
    expect(profile).toMatchObject({ idNumberLast4: "7890", hasIdNumber: true, hasDateOfBirth: true });
    const raw = await sq().query<any>("SELECT id_number_enc, date_of_birth_enc FROM kyc_profiles WHERE id=:id", { replacements: { id: profile.id }, type: QueryTypes.SELECT });
    expect(raw[0].id_number_enc).not.toContain("P1234567890");
    expect(raw[0].id_number_enc.startsWith("v1.")).toBe(true);
    const plainCtx = await contextFor(c.t.tenantId, c.maker.id);
    await expect(revealIdentity(sq(), plainCtx, profile.id, "filing")).rejects.toThrow();
    expect(await revealIdentity(sq(), c.makerCtx, profile.id, "STR filing")).toMatchObject({ idNumber: "P1234567890", dateOfBirth: "1985-04-02" });
    const audit = await sq().query<any>("SELECT action FROM audit_events WHERE tenant_id=:t AND action='kyc.identity_revealed'", { replacements: { t: c.t.tenantId }, type: QueryTypes.SELECT });
    expect(audit).toHaveLength(1);
  });

  it("enforces maker-checker, completeness, and re-review after a material change", async () => {
    const c = await ckit();
    const empty = await createContact(sq(), c.t.admin, { firstName: "Empty", phone: phone() });
    await upsertKycProfile(sq(), c.makerCtx, empty.id, { nationality: "India" });
    const ep = (await getKycProfileByContact(sq(), c.makerCtx, empty.id))!;
    await expect(submitKyc(sq(), c.makerCtx, ep.id)).rejects.toThrow(/identity number is required.*identity document/);

    const { profile } = await readyProfile(c);
    await submitKyc(sq(), c.makerCtx, profile.id);
    await expect(reviewKyc(sq(), c.makerCtx, profile.id, { outcome: "approved", reason: "ok" })).rejects.toThrow(/cannot also approve/);
    const sales = await makeUser(c.t, ["agent"]);
    await expect(reviewKyc(sq(), sales.ctx, profile.id, { outcome: "approved", reason: "ok" })).rejects.toBeInstanceOf(ForbiddenError);
    const ok = await reviewKyc(sq(), c.checkerCtx, profile.id, { outcome: "approved", reason: "Documents verified" });
    expect(ok.status).toBe("approved");
    expect(ok.expiresAt).toBeTruthy();
    expect(ok.riskLevel).toBe("low");

    await upsertKycProfile(sq(), c.makerCtx, ok.contactId, { occupation: "Engineer" });
    expect((await getKycProfileByContact(sq(), c.makerCtx, ok.contactId))!.status).toBe("draft");
  });

  it("expires approved profiles through the sweep", async () => {
    const c = await ckit();
    const { profile } = await readyProfile(c);
    await submitKyc(sq(), c.makerCtx, profile.id);
    await reviewKyc(sq(), c.checkerCtx, profile.id, { outcome: "approved", reason: "ok ok ok" });
    await sq().query("UPDATE kyc_profiles SET expires_at='2020-01-01' WHERE id=:id", { replacements: { id: profile.id } });
    expect(await kycExpirySweep(sq(), c.checkerCtx)).toBe(1);
    expect(await kycExpirySweep(sq(), c.checkerCtx)).toBe(0);
    expect((await getKycProfileByContact(sq(), c.makerCtx, profile.contactId))!.status).toBe("expired");
  });

  it("is invisible to other tenants and to users without kyc.read", async () => {
    const c = await ckit();
    const { profile } = await readyProfile(c);
    const other = await ckit();
    await expect(getKycProfileByContact(sq(), other.makerCtx, profile.contactId)).rejects.toThrow(/not found/i);
    const agent = await makeUser(c.t, ["agent"]);
    await expect(getKycProfileByContact(sq(), agent.ctx, profile.contactId)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("beneficial ownership", () => {
  it("resolves effective ownership through chains and refuses cycles and over-100% shareholdings", async () => {
    const c = await ckit();
    const mk = (n: string, type: "person" | "company" = "person") => createContact(sq(), c.t.admin, type === "company" ? { type, companyName: n, phone: phone() } as any : { firstName: n, phone: phone() });
    const target = await mk("Target LLC", "company");
    const holdco = await mk("Holdco Ltd", "company");
    const alice = await mk("Alice");
    const bob = await mk("Bob");
    await linkUbo(sq(), c.makerCtx, { parentContactId: target.id, ownerContactId: holdco.id, ownershipPct: 60 });
    await linkUbo(sq(), c.makerCtx, { parentContactId: target.id, ownerContactId: bob.id, ownershipPct: 10 });
    await linkUbo(sq(), c.makerCtx, { parentContactId: holdco.id, ownerContactId: alice.id, ownershipPct: 50 });
    const g = await getUboGraph(sq(), c.makerCtx, target.id);
    const byName = Object.fromEntries(g.nodes.map((n) => [n.name, n]));
    expect(byName["Alice"]!.effectivePct).toBe(30);
    expect(byName["Alice"]!.isBeneficialOwner).toBe(true); // 30% >= 25%
    expect(byName["Bob"]!.isBeneficialOwner).toBe(false); // 10% < 25%
    expect(g.beneficialOwners.map((n) => n.name)).toEqual(["Alice"]);

    await expect(linkUbo(sq(), c.makerCtx, { parentContactId: holdco.id, ownerContactId: target.id, ownershipPct: 5 })).rejects.toThrow(/circular/);
    await expect(linkUbo(sq(), c.makerCtx, { parentContactId: target.id, ownerContactId: alice.id, ownershipPct: 31 })).rejects.toThrow(/maximum 100%/);
    await expect(linkUbo(sq(), c.makerCtx, { parentContactId: alice.id, ownerContactId: bob.id, ownershipPct: 5 })).rejects.toThrow(/company/);
  });
});

describe("screening, cases and approval", () => {
  it("opens a case for hits, needs a human disposition (step-up + reason), and blocks approval until then", async () => {
    const c = await ckit();
    const { profile } = await readyProfile(c, "Testcase Sanctioned");
    const run = await runScreening(sq(), c.makerCtx, profile.id);
    expect(run.newHits).toBe(1);
    const cases = await listCases(sq(), c.makerCtx, { status: "open", limit: 10, offset: 0 });
    expect(cases.filter((x: any) => x.profileId === profile.id)).toHaveLength(1);

    await submitKyc(sq(), c.makerCtx, profile.id);
    await expect(reviewKyc(sq(), c.checkerCtx, profile.id, { outcome: "approved", reason: "looks fine" })).rejects.toThrow(/awaiting disposition/);

    const full = (await getKycProfileByContact(sq(), c.makerCtx, profile.contactId))!;
    const hit = full.hits[0];
    const noStep = await contextFor(c.t.tenantId, c.checker.id);
    await expect(disposeHit(sq(), noStep, hit.id, { outcome: "false_positive", reason: "different person entirely" })).rejects.toThrow();
    await expect(disposeHit(sq(), c.checkerCtx, hit.id, { outcome: "false_positive", reason: "short" })).rejects.toThrow(/at least 10/);
    await disposeHit(sq(), c.checkerCtx, hit.id, { outcome: "false_positive", reason: "Different date of birth and nationality" });
    await expect(disposeHit(sq(), c.checkerCtx, hit.id, { outcome: "true_match", reason: "changed my mind later" })).rejects.toThrow(/already been disposed/);

    // the open case still blocks approval; closing it needs a written resolution
    await expect(reviewKyc(sq(), c.checkerCtx, profile.id, { outcome: "approved", reason: "all clear" })).rejects.toThrow(/open compliance case/);
    const openCaseId = (await listCases(sq(), c.makerCtx, { status: "open", limit: 10, offset: 0 })).find((x: any) => x.profileId === profile.id).id;
    await addCaseNote(sq(), c.makerCtx, openCaseId, "Reviewed passport details");
    await expect(closeCase(sq(), c.makerCtx, openCaseId, { outcome: "cleared", resolution: "ok" })).rejects.toThrow(/at least 10/);
    await closeCase(sq(), c.makerCtx, openCaseId, { outcome: "cleared", resolution: "Hit was a false positive" });
    expect((await reviewKyc(sq(), c.checkerCtx, profile.id, { outcome: "approved", reason: "all clear" })).status).toBe("approved");

    // a re-run does not make a human re-decide a known false positive
    const again = await runScreening(sq(), c.makerCtx, profile.id);
    expect(again).toMatchObject({ newHits: 0, suppressedKnownHits: 1 });
  });

  it("raises risk and flags PEP on a confirmed match, and the AI/automation role cannot dispose hits", async () => {
    const c = await ckit();
    const { profile } = await readyProfile(c, "Testcase Pep");
    await runScreening(sq(), c.makerCtx, profile.id);
    const hit = (await getKycProfileByContact(sq(), c.makerCtx, profile.contactId))!.hits[0];
    const agent = await makeUser(c.t, ["agent"]);
    await expect(disposeHit(sq(), agent.ctx, hit.id, { outcome: "true_match", reason: "I think it is them" })).rejects.toBeInstanceOf(ForbiddenError);
    await disposeHit(sq(), c.checkerCtx, hit.id, { outcome: "true_match", reason: "Confirmed against the official register" });
    const p = (await getKycProfileByContact(sq(), c.makerCtx, profile.contactId))!;
    expect(p.isPep).toBe(true);
    expect(p.riskLevel).toBe("high");
    expect(p.cases.some((x: any) => x.status === "escalated")).toBe(true);
  });

  it("exports reported cases as masked goAML-style XML and requires step-up", async () => {
    const c = await ckit();
    const { profile } = await readyProfile(c, "Testcase Sanctioned");
    await runScreening(sq(), c.makerCtx, profile.id);
    const hit = (await getKycProfileByContact(sq(), c.makerCtx, profile.contactId))!.hits[0];
    await disposeHit(sq(), c.checkerCtx, hit.id, { outcome: "true_match", reason: "Confirmed sanctions match on the list" });
    const caseId = (await listCases(sq(), c.makerCtx, { limit: 10, offset: 0 })).find((x: any) => x.profileId === profile.id).id;
    await closeCase(sq(), c.checkerCtx, caseId, { outcome: "reported", resolution: "Escalated to the MLRO for filing" });
    const win = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() };
    const noStep = await contextFor(c.t.tenantId, c.maker.id);
    await expect(exportReportedCases(sq(), noStep, win)).rejects.toThrow();
    const out = await exportReportedCases(sq(), c.makerCtx, win);
    expect(out.count).toBe(1);
    expect(out.xml).toContain("<idNumberLast4>7890</idNumberLast4>");
    expect(out.xml).not.toContain("P1234567890");
    expect(out.xml).toContain("NOT validated");
  });
});

describe("KYC deal gate", () => {
  it("is off by default, and when enabled blocks the deal until the buyer is approved", async () => {
    const t = await makeTenant();
    const k = await kit(t);
    const { deal } = await openDeal(t, k);
    const mgr = await contextFor(t.tenantId, k.mgr.id);
    await completeMilestone(sq(), mgr, deal.id, "deposit", { reason: "deposit confirmed by bank statement" });

    await setting(t.tenantId, "compliance.kyc_required_for_deals", "true");
    await expect(advanceDealStage(sq(), mgr, deal.id, { to: "contract" })).rejects.toThrow(DealBlockedError);
    await expect(advanceDealStage(sq(), mgr, deal.id, { to: "contract" })).rejects.toMatchObject({ reasons: ["The buyer has no KYC profile"] });

    const maker = await makeUser(t, ["compliance_officer"]);
    const checker = await makeUser(t, ["compliance_officer"]);
    const mc = await contextFor(t.tenantId, maker.id, { stepUp: true });
    const cc = await contextFor(t.tenantId, checker.id, { stepUp: true });
    await upsertKycProfile(sq(), mc, k.contact.id, { idType: "passport", idNumber: "X99887766", nationality: "UK", sourceOfFunds: "Savings" });
    const prof = (await getKycProfileByContact(sq(), mc, k.contact.id))!;
    const doc = await createDocument(sq(), t.admin, { title: "Passport", kind: "id_document", file: { filename: "p.pdf", mime: "application/pdf", bytes: pdf() } });
    await addKycDocument(sq(), mc, prof.id, { documentId: doc.id, docType: "passport" });
    await submitKyc(sq(), mc, prof.id);
    await expect(advanceDealStage(sq(), mgr, deal.id, { to: "contract" })).rejects.toMatchObject({ reasons: ["The buyer's KYC is in_review"] });
    await reviewKyc(sq(), cc, prof.id, { outcome: "approved", reason: "Verified" });
    const moved: any = await advanceDealStage(sq(), mgr, deal.id, { to: "contract" });
    expect(moved.stage).toBe("contract");
  });
});

describe("privacy: DSR, legal holds and retention", () => {
  async function person(t: Awaited<ReturnType<typeof makeTenant>>, first = "Layla") {
    return createContact(sq(), t.admin, { firstName: first, lastName: "Nasser", email: `${first.toLowerCase()}${Math.random().toString(16).slice(2, 8)}@example.test`, phone: phone() });
  }

  it("builds a subject-access package and keeps the statutory clock in the database", async () => {
    const c = await ckit();
    const p = await person(c.t);
    const r = await createDsr(sq(), c.makerCtx, { contactId: p.id, kind: "access" });
    const due = new Date(r.dueAt).getTime() - Date.now();
    expect(due).toBeGreaterThan(29 * 86_400_000);
    expect(due).toBeLessThan(31 * 86_400_000);
    const done: any = await fulfilAccessRequest(sq(), c.makerCtx, r.id);
    expect(done.status).toBe("completed");
    expect(done.result.contact.firstName).toBe("Layla");
    await expect(fulfilAccessRequest(sq(), c.makerCtx, r.id)).rejects.toThrow(/already completed/);
  });

  it("anonymises on erasure, retains financial records, and is blocked by a legal hold", async () => {
    const c = await ckit();
    const p = await person(c.t, "Omar");
    const held = await placeLegalHold(sq(), c.makerCtx, p.id, "Litigation pending");
    const r = await createDsr(sq(), c.makerCtx, { contactId: p.id, kind: "erasure" });
    await expect(fulfilErasureRequest(sq(), c.makerCtx, r.id)).rejects.toThrow(/legal hold/);
    await releaseLegalHold(sq(), c.makerCtx, held.id);
    await upsertKycProfile(sq(), c.makerCtx, p.id, { idType: "passport", idNumber: "ZZ1122334", nationality: "Egypt" });
    const done: any = await fulfilErasureRequest(sq(), c.makerCtx, r.id);
    expect(done.status).toBe("completed");
    expect(done.result.retained.map((x: any) => x.what)).toContain("KYC/AML records");
    const row = await sq().query<any>("SELECT first_name, email, phone_e164, status FROM contacts WHERE id=:id", { replacements: { id: p.id }, type: QueryTypes.SELECT });
    expect(row[0]).toMatchObject({ first_name: "Erased", email: null, phone_e164: null, status: "archived" });
    const kyc = await sq().query<any>("SELECT id_number_enc FROM kyc_profiles WHERE contact_id=:id", { replacements: { id: p.id }, type: QueryTypes.SELECT });
    expect(kyc[0].id_number_enc).not.toBeNull(); // inside the AML retention window: kept
  });

  it("notifies about overdue requests exactly once and rejects with a note", async () => {
    const c = await ckit();
    const p = await person(c.t);
    const r = await createDsr(sq(), c.makerCtx, { contactId: p.id, kind: "rectification" });
    await sq().query("UPDATE dsr_requests SET due_at = DATE_SUB(NOW(3), INTERVAL 1 DAY) WHERE id=:id", { replacements: { id: r.id } });
    expect(await dsrSweep(sq(), c.makerCtx)).toBe(1);
    expect(await dsrSweep(sq(), c.makerCtx)).toBe(0);
    await expect(closeDsr(sq(), c.makerCtx, r.id, { outcome: "completed", note: " " })).rejects.toThrow(/note/);
    expect((await closeDsr(sq(), c.makerCtx, r.id, { outcome: "completed", note: "Name corrected" })).status).toBe("completed");
  });

  it("runs retention as a dry run first, skips held contacts, and only anonymises when asked with step-up", async () => {
    const c = await ckit();
    await setRetentionPolicy(sq(), c.makerCtx, { entityType: "contact_archived", retainDays: 30 });
    const a = await person(c.t, "Old");
    const b = await person(c.t, "Held");
    await sq().query("UPDATE contacts SET status='archived', updated_at = DATE_SUB(NOW(3), INTERVAL 90 DAY) WHERE id IN (:ids)", { replacements: { ids: [a.id, b.id] } });
    await placeLegalHold(sq(), c.makerCtx, b.id, "Regulatory inquiry");
    const dry = await runRetention(sq(), c.makerCtx);
    expect(dry).toMatchObject({ dryRun: true, contactsAnonymised: 1, skippedLegalHold: 1 });
    expect((await sq().query<any>("SELECT first_name FROM contacts WHERE id=:id", { replacements: { id: a.id }, type: QueryTypes.SELECT }))[0].first_name).toBe("Old");
    const noStep = await contextFor(c.t.tenantId, c.maker.id);
    await expect(runRetention(sq(), noStep, { dryRun: false })).rejects.toThrow();
    await runRetention(sq(), c.makerCtx, { dryRun: false });
    expect((await sq().query<any>("SELECT first_name FROM contacts WHERE id=:id", { replacements: { id: a.id }, type: QueryTypes.SELECT }))[0].first_name).toBe("Erased");
    expect((await sq().query<any>("SELECT first_name FROM contacts WHERE id=:id", { replacements: { id: b.id }, type: QueryTypes.SELECT }))[0].first_name).toBe("Held");
  });
});

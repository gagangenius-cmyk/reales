import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  acceptInvite, cancelImport, commitImport, createBuilding, createContact, createLead, createRoutingRule, createSsoConnection, csvCell, exportCsv, getImport, inviteUser, listImports, listContacts,
  mockMailer, parseCsv, requestPasswordReset, resendInvite, resetPassword, templateCsv, toCsv, TokenError, validateImport,
} from "@reales/domain";
import { login } from "@reales/auth";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, makeTenant, makeUser, PASSWORD, testDb, uniq } from "./helpers";
import { makeInventory, makeOrg, agentIn } from "./brokerage-helpers";
import { phone } from "./deal-helpers";

afterAll(closeTestDb);
beforeEach(() => mockMailer.reset());
const sq = () => testDb();
const BASE = "https://crm.example.test";
const tokenFrom = (m: { text: string } | undefined) => decodeURIComponent(/token=([^\s&]+)/.exec(m!.text)![1]!);
const NEW_PW = "N3w-Passw0rd!zz";

describe("invitations", () => {
  it("emails a single-use link, activates the account on acceptance, and rejects weak passwords and reuse", async () => {
    const t = await makeTenant();
    const email = `new.hire@${t.slug}.test`;
    const r = await inviteUser(sq(), t.admin, { email, roleKeys: ["agent"], baseUrl: BASE });
    expect(r.user).toMatchObject({ email, status: "invited" });
    expect(r.delivered).toBe(true);
    const mail = mockMailer.last(email)!;
    expect(mail.subject).toMatch(/invited/);
    expect(mail.text).toContain(`${BASE}/accept-invite?token=`);
    const token = tokenFrom(mail);
    const stored = await sq().query<any>("SELECT token_hash FROM auth_tokens WHERE user_id=:u", { replacements: { u: r.user.id }, type: QueryTypes.SELECT });
    expect(stored[0].token_hash).not.toContain(token); // only the hash is stored

    await expect(login(sq(), { tenantSlug: t.slug, email, password: NEW_PW })).rejects.toMatchObject({ code: "invalid_credentials" }); // not usable until accepted
    await expect(acceptInvite(sq(), { token, password: "short" })).rejects.toThrow(/at least/);
    await expect(acceptInvite(sq(), { token: "nope", password: NEW_PW })).rejects.toBeInstanceOf(TokenError);
    expect(await acceptInvite(sq(), { token, password: NEW_PW })).toEqual({ email });
    await expect(login(sq(), { tenantSlug: t.slug, email, password: NEW_PW })).resolves.toMatchObject({ status: "ok" });
    await expect(acceptInvite(sq(), { token, password: NEW_PW })).rejects.toBeInstanceOf(TokenError);
  });

  it("a resent invitation voids the earlier link, expired links fail, and only user admins can invite", async () => {
    const t = await makeTenant();
    const email = `late@${t.slug}.test`;
    const { user } = await inviteUser(sq(), t.admin, { email, roleKeys: ["agent"], baseUrl: BASE });
    const first = tokenFrom(mockMailer.last(email));
    await resendInvite(sq(), t.admin, user.id as string, BASE);
    const second = tokenFrom(mockMailer.last(email));
    expect(second).not.toBe(first);
    await expect(acceptInvite(sq(), { token: first, password: NEW_PW })).rejects.toBeInstanceOf(TokenError);
    await sq().query("UPDATE auth_tokens SET expires_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE user_id=:u AND used_at IS NULL", { replacements: { u: user.id } });
    await expect(acceptInvite(sq(), { token: second, password: NEW_PW })).rejects.toBeInstanceOf(TokenError);
    const agent = await makeUser(t, ["agent"]);
    await expect(inviteUser(sq(), agent.ctx, { email: `x@${t.slug}.test`, roleKeys: ["agent"], baseUrl: BASE })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(resendInvite(sq(), t.admin, t.adminId, BASE)).rejects.toThrow(/Only an invited user/);
  });
});

describe("password reset", () => {
  it("reveals nothing about which addresses exist, throttles, and sends nothing for unknown, disabled or SSO-enforced accounts", async () => {
    const t = await makeTenant();
    await requestPasswordReset(sq(), { tenantSlug: t.slug, email: "nobody@example.test", baseUrl: BASE });
    await requestPasswordReset(sq(), { tenantSlug: "no-such-tenant", email: t.adminEmail, baseUrl: BASE });
    expect(mockMailer.sent).toHaveLength(0);

    await requestPasswordReset(sq(), { tenantSlug: t.slug, email: t.adminEmail.toUpperCase(), baseUrl: BASE });
    expect(mockMailer.sent).toHaveLength(1);
    await requestPasswordReset(sq(), { tenantSlug: t.slug, email: t.adminEmail, baseUrl: BASE }); // within a minute
    expect(mockMailer.sent).toHaveLength(1);

    const u = await makeUser(t, ["agent"]);
    await sq().query("UPDATE users SET status='disabled' WHERE id=:id", { replacements: { id: u.id } });
    await requestPasswordReset(sq(), { tenantSlug: t.slug, email: u.email, baseUrl: BASE });
    expect(mockMailer.sent).toHaveLength(1);

    await createSsoConnection(sq(), t.admin, { name: "Okta", issuer: "https://idp.example.test", clientId: "c", authorizationEndpoint: "https://idp.example.test/a", tokenEndpoint: "https://idp.example.test/t", jwksUri: "https://idp.example.test/j", emailDomains: [`${t.slug}.test`], enforce: true });
    await sq().query("UPDATE auth_tokens SET created_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR)");
    await requestPasswordReset(sq(), { tenantSlug: t.slug, email: t.adminEmail, baseUrl: BASE });
    expect(mockMailer.sent).toHaveLength(1);
  });

  it("changes the password with a single-use link, revokes sessions, and the newest link wins", async () => {
    const t = await makeTenant();
    const agent = await makeUser(t, ["agent"]);
    const before = await login(sq(), { tenantSlug: t.slug, email: agent.email, password: PASSWORD });
    await requestPasswordReset(sq(), { tenantSlug: t.slug, email: agent.email, baseUrl: BASE });
    const old = tokenFrom(mockMailer.last(agent.email));
    await sq().query("UPDATE auth_tokens SET created_at = DATE_SUB(NOW(3), INTERVAL 5 MINUTE) WHERE user_id=:u", { replacements: { u: agent.id } });
    await requestPasswordReset(sq(), { tenantSlug: t.slug, email: agent.email, baseUrl: BASE });
    const latest = tokenFrom(mockMailer.last(agent.email));
    await expect(resetPassword(sq(), { token: old, password: NEW_PW })).rejects.toBeInstanceOf(TokenError);
    await expect(resetPassword(sq(), { token: latest, password: "weak" })).rejects.toThrow(/at least/);
    await resetPassword(sq(), { token: latest, password: NEW_PW });
    await expect(resetPassword(sq(), { token: latest, password: NEW_PW })).rejects.toBeInstanceOf(TokenError);
    await expect(login(sq(), { tenantSlug: t.slug, email: agent.email, password: PASSWORD })).rejects.toMatchObject({ code: "invalid_credentials" });
    await expect(login(sq(), { tenantSlug: t.slug, email: agent.email, password: NEW_PW })).resolves.toMatchObject({ status: "ok" });
    const revoked = await sq().query<any>("SELECT revoked_at FROM sessions WHERE id=:id", { replacements: { id: before.sessionId }, type: QueryTypes.SELECT });
    expect(revoked[0].revoked_at).not.toBeNull();
    const audit = await sq().query<any>("SELECT action FROM audit_events WHERE tenant_id=:t AND action IN ('user.password_reset','user.password_reset_requested')", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["user.password_reset", "user.password_reset_requested"]));
  });
});

describe("CSV", () => {
  it("parses quotes, embedded newlines, doubled quotes, CRLF and a BOM; rejects unterminated quotes", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n"line1\nline2",z\r\n\r\n')).toEqual([["a", "b"], ["x, y", 'he said "hi"'], ["line1\nline2", "z"]]);
    expect(() => parseCsv('a\n"oops')).toThrow(/unterminated/);
  });
  it("neutralises spreadsheet formulas on export but keeps real negative numbers", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell("+971501234567")).toBe("'+971501234567");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-5")).toBe("-5");
    expect(toCsv(["a", "b"], [{ a: "x,y", b: null }])).toBe("﻿a,b\r\n\"x,y\",\r\n");
    expect(templateCsv("leads")).toBe("purpose,first_name,last_name,email,phone,budget_min,budget_max,bedrooms,source_code,preferred_areas,language\r\n");
  });
});

describe("import and export", () => {
  it("validates first (writing nothing), reports row errors, then commits once; duplicates are skipped", async () => {
    const t = await makeTenant();
    await createContact(sq(), t.admin, { firstName: "Existing", email: "existing@example.test" });
    const csv = [
      "first_name,last_name,email,phone",
      "Aisha,Khan,aisha@example.test,0501111111",
      "Bilal,Ahmed,not-an-email,",
      "Carla,Diaz,,",
      "Existing,Person,existing@example.test,",
      "Aisha,Again,aisha@example.test,",
      '"Dev, Jr",Patel,dev@example.test,0502222222',
    ].join("\r\n");
    const v = await validateImport(sq(), t.admin, { kind: "contacts", filename: "contacts.csv", csv });
    expect(v).toMatchObject({ status: "validated", totalRows: 6, validRows: 3, errorRows: 3 });
    expect(v.errors).toEqual([{ row: 3, message: "Invalid email address" }, { row: 4, message: "An email or a phone number is required" }, { row: 6, message: "Duplicate of an earlier row in the file" }]);
    expect((await listContacts(sq(), t.admin, { limit: 50, offset: 0 })).length).toBe(1); // nothing written yet

    const done = await commitImport(sq(), t.admin, v.id);
    expect(done).toMatchObject({ status: "committed", committedRows: 2, skippedRows: 1 }); // the existing contact is skipped, Aisha and Dev are created
    expect((await listContacts(sq(), t.admin, { limit: 50, offset: 0 })).length).toBe(3);
    await expect(commitImport(sq(), t.admin, v.id)).rejects.toThrow(/already committed/);
    expect((await listImports(sq(), t.admin))[0]).toMatchObject({ id: v.id, status: "committed" });
  });

  it("can reject duplicates of existing records at validation, and can be cancelled", async () => {
    const t = await makeTenant();
    await createContact(sq(), t.admin, { firstName: "Existing", email: "existing@example.test" });
    const v = await validateImport(sq(), t.admin, { kind: "contacts", filename: "c.csv", csv: "first_name,email\nExisting,existing@example.test\nNew,new@example.test", onDuplicate: "error" });
    expect(v.errors).toEqual([{ row: 2, message: "A contact with this email or phone already exists" }]);
    expect((await cancelImport(sq(), t.admin, v.id)).status).toBe("cancelled");
    await expect(commitImport(sq(), t.admin, v.id)).rejects.toThrow(/already cancelled/);
  });

  it("rejects bad files and enforces permission and tenant boundaries", async () => {
    const t = await makeTenant();
    await expect(validateImport(sq(), t.admin, { kind: "contacts", filename: "x.csv", csv: "first_name\n" })).rejects.toThrow(/at least one data row/);
    await expect(validateImport(sq(), t.admin, { kind: "contacts", filename: "x.csv", csv: "first_name,password\nA,b" })).rejects.toThrow(/Unknown column/);
    await expect(validateImport(sq(), t.admin, { kind: "leads", filename: "x.csv", csv: "email\na@b.test" })).rejects.toThrow(/Missing required column/);
    const agent = await makeUser(t, ["agent"]);
    await expect(validateImport(sq(), agent.ctx, { kind: "contacts", filename: "x.csv", csv: "first_name,email\nA,a@b.test" })).rejects.toBeInstanceOf(ForbiddenError);
    const v = await validateImport(sq(), t.admin, { kind: "contacts", filename: "x.csv", csv: "first_name,email\nA,a@b.test" });
    const other = await makeTenant();
    await expect(getImport(sq(), other.admin, v.id)).rejects.toThrow(/not found/i);
    await expect(commitImport(sq(), other.admin, v.id)).rejects.toThrow(/not found/i);
  });

  it("imports leads (routed, with a contact each) and units (resolved by building name)", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const agent = await agentIn(t, org.marina.id, org.bu.id);
    await createRoutingRule(sq(), t.admin, { name: "all", conditions: {}, target: { userIds: [agent.id] } });
    const leads = await validateImport(sq(), t.admin, { kind: "leads", filename: "leads.csv", csv: "purpose,first_name,phone,budget_max,bedrooms,preferred_areas\nbuy,Zed,0503333333,2500000,2,Marina;Downtown\nswap,Bad,0504444444,,,\nrent,Yara,0505555555,90000,1," });
    expect(leads).toMatchObject({ validRows: 2, errorRows: 1 });
    expect(leads.errors[0]).toEqual({ row: 3, message: "purpose must be buy, rent, invest or off_plan" });
    expect((await commitImport(sq(), t.admin, leads.id)).committedRows).toBe(2);
    const rows = await sq().query<any>("SELECT assigned_user_id, bedrooms FROM leads WHERE tenant_id=:t", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.assigned_user_id === agent.id)).toBe(true);

    const inv = await makeInventory(t);
    const building = (await sq().query<any>("SELECT name FROM buildings WHERE id=:id", { replacements: { id: inv.building.id }, type: QueryTypes.SELECT }))[0].name;
    const units = await validateImport(sq(), t.admin, { kind: "units", filename: "units.csv", csv: `building,unit_number,type,bedrooms,area_sqft,list_price\n${building},901,apartment,2,1100,1500000\nNo Such Tower,1,apartment,1,500,1\n${building},902,castle,1,1,1\n${building},901,apartment,2,1100,1500000` });
    expect(units).toMatchObject({ validRows: 1, errorRows: 3 });
    expect((await commitImport(sq(), t.admin, units.id)).committedRows).toBe(1);
  });

  it("exports only what the caller can already see, needs export permission, and guards against formulas", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const a = await agentIn(t, org.marina.id, org.bu.id);
    const b = await agentIn(t, org.marina.id, org.bu.id);
    await createContact(sq(), a.ctx, { firstName: "=cmd|calc", lastName: "Mine", phone: phone() });
    await createContact(sq(), b.ctx, { firstName: "Theirs", phone: phone() });
    const mine = await exportCsv(sq(), a.ctx, "contacts");
    expect(mine.rows).toBe(1);
    expect(mine.csv).toContain("'=cmd|calc");
    expect(mine.csv).not.toContain("Theirs");
    expect((await exportCsv(sq(), t.admin, "contacts")).rows).toBe(2);
    const viewer = await makeUser(t, ["viewer"]);
    await expect(exportCsv(sq(), viewer.ctx, "contacts")).rejects.toBeInstanceOf(ForbiddenError);
    const audit = await sq().query<any>("SELECT COUNT(*) n FROM audit_events WHERE tenant_id=:t AND action='export.csv'", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    expect(Number(audit[0].n)).toBe(2);
    void uniq; void createLead; void createBuilding;
  });
});

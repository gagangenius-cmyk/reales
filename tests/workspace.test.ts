import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { QueryTypes } from "sequelize";
import {
  acceptInvite, assignOwnership, createContact, createLease, createManagementAgreement, createPortfolio, createTask, generateOwnerStatement, getCalendar, invitePortalUser, issueOwnerStatement,
  leaseContractDraftPdf, listContacts, listTasks, LocalObjectStorage, mockMailer, ownerPortal, ownerStatementPdf, ownerStatementPdfForPortal, portalMe, receiptPdf, renderPdf, rescheduleTask,
  revokePortalAccess, savePdfAsDocument, setStorage, taskReminderSweep, tenantPortal, tenantRequestMaintenance, toIcs, type CalendarEvent, listPortalUsers, completeTask,
} from "@reales/domain";
import { login, resolveRequestContext } from "@reales/auth";
import { hasPermission, ForbiddenError } from "@reales/rbac";
import { systemContext } from "@reales/database";
import { closeTestDb, contextFor, makeTenant, makeUser, PASSWORD, testDb } from "./helpers";
import { agentIn, makeInventory, makeOrg } from "./brokerage-helpers";
import { phone } from "./deal-helpers";

const sq = () => testDb();
let dir: string;
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), "reales-pdf-")); setStorage(new LocalObjectStorage(dir)); });
afterAll(async () => { setStorage(null); rmSync(dir, { recursive: true, force: true }); await closeTestDb(); });
beforeEach(() => mockMailer.reset());

const BASE = "https://crm.example.test";
const tokenFrom = (m: { text: string } | undefined) => decodeURIComponent(/token=([^\s&]+)/.exec(m!.text)![1]!);
const iso = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const ym = (d = new Date()) => d.toISOString().slice(0, 7);

describe("iCalendar export", () => {
  it("produces a valid, escaped, folded calendar", () => {
    const ev: CalendarEvent[] = [
      { id: "task:1", kind: "task", title: "Call; the, buyer\nabout flat " + "x".repeat(120), start: "2027-03-04T09:30:00.000Z", allDay: false, link: null },
      { id: "rent:2", kind: "rent_due", title: "Rent due", start: "2027-03-10", allDay: true, link: null, detail: "AED 5,000" },
    ];
    const ics = toIcs(ev, new Date("2027-01-01T00:00:00Z"));
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("DTSTART:20270304T093000Z");
    expect(ics).toContain("DTEND:20270304T100000Z");
    expect(ics).toContain("DTSTART;VALUE=DATE:20270310");
    expect(ics).toContain("SUMMARY:Call\\; the\\, buyer\\nabout flat");
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });
});

async function pmKit() {
  const t = await makeTenant();
  const org = await makeOrg(t);
  const pm = await makeUser(t, ["property_manager"], { branchId: org.marina.id, businessUnitId: org.bu.id });
  const inv = await makeInventory(t);
  const owner = await createContact(sq(), t.admin, { firstName: "Hassan", lastName: "Mansoori", email: `owner@${t.slug}.test`, phone: phone() });
  const tenant = await createContact(sq(), t.admin, { firstName: "Priya", lastName: "Nair", email: `tenant@${t.slug}.test`, phone: phone() });
  const portfolio = await createPortfolio(sq(), pm.ctx, { name: "Mansoori Holdings", ownerContactId: owner.id, branchId: org.marina.id });
  await assignOwnership(sq(), pm.ctx, { unitId: inv.unit.id, portfolioId: portfolio.id, fromDate: "2026-01-01" });
  await createManagementAgreement(sq(), pm.ctx, { portfolioId: portfolio.id, feePct: 5, startsOn: "2026-01-01" });
  const start = new Date(); const startsOn = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), 0)).toISOString().slice(0, 10);
  const lease: any = await createLease(sq(), pm.ctx, { unitId: inv.unit.id, startsOn, endsOn: end, annualRent: 60_000, installments: 12, tenantContactIds: [tenant.id] });
  await sq().query("UPDATE leases SET status='active' WHERE id=:id", { replacements: { id: lease.id } });
  return { t, org, pm, inv, owner, tenant, portfolio, lease };
}

describe("calendar and tasks", () => {
  it("merges only what the caller can see, and refuses huge ranges", async () => {
    const k = await pmKit();
    const agent = await agentIn(k.t, k.org.marina.id, k.org.bu.id);
    const other = await agentIn(k.t, k.org.marina.id, k.org.bu.id);
    await createTask(sq(), agent.ctx, { title: "Call buyer", dueAt: iso(2) });
    await createTask(sq(), k.pm.ctx, { title: "Check keys", dueAt: iso(3) });
    const range = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 40 * 86_400_000).toISOString() };
    const pmEvents = await getCalendar(sq(), k.pm.ctx, range);
    expect(pmEvents.map((e) => e.kind)).toEqual(expect.arrayContaining(["task", "rent_due"]));
    expect(pmEvents.filter((e) => e.kind === "task").map((e) => e.title)).toEqual(["Check keys"]);
    const agentEvents = await getCalendar(sq(), agent.ctx, range);
    expect(agentEvents.map((e) => e.title)).toEqual(["Call buyer"]); // no lease.read: no rent events
    expect(await getCalendar(sq(), other.ctx, range)).toEqual([]);
    await expect(getCalendar(sq(), k.pm.ctx, { from: "2027-01-01", to: "2027-12-31" })).rejects.toThrow(/limited to/);
    await expect(getCalendar(sq(), k.pm.ctx, { from: "nonsense", to: "2027-01-01" })).rejects.toThrow(/Invalid date range/);
  });

  it("lists, reschedules and completes tasks; reminders fire once per state", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const a = await agentIn(t, org.marina.id, org.bu.id);
    const b = await agentIn(t, org.marina.id, org.bu.id);
    const soon: any = await createTask(sq(), a.ctx, { title: "Soon", dueAt: iso(0.5) });
    const late: any = await createTask(sq(), a.ctx, { title: "Late", dueAt: iso(-3) });
    await createTask(sq(), a.ctx, { title: "Later", dueAt: iso(48) });
    expect((await listTasks(sq(), a.ctx)).map((x: any) => x.title)).toEqual(["Late", "Soon", "Later"]);
    expect((await listTasks(sq(), a.ctx, { overdueOnly: true })).map((x: any) => x.title)).toEqual(["Late"]);
    await expect(listTasks(sq(), a.ctx, { scope: "all" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await listTasks(sq(), b.ctx)).toEqual([]);
    await expect(rescheduleTask(sq(), b.ctx, soon.id, iso(5))).rejects.toThrow(/not found/i);

    const sys = systemContext(t.tenantId, "corr_task_reminders");
    expect(await taskReminderSweep(sq(), sys)).toBe(2); // Soon + Late
    expect(await taskReminderSweep(sq(), sys)).toBe(0);
    await sq().query("UPDATE tasks SET due_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR) WHERE id=:id", { replacements: { id: soon.id } });
    expect(await taskReminderSweep(sq(), sys)).toBe(1); // the soon task became overdue: one more notice
    await rescheduleTask(sq(), a.ctx, late.id, iso(72));
    await completeTask(sq(), a.ctx, soon.id);
    expect((await listTasks(sq(), a.ctx)).map((x: any) => x.title)).toEqual(["Later", "Late"]);
  });
});

describe("PDF documents", () => {
  it("renders valid PDFs, tolerates non-Latin text, and honours the caller's access", async () => {
    const pdf = await renderPdf({ title: "Test مرحبا", sections: [{ heading: "A", paragraphs: ["x".repeat(3000)] }, { heading: "T", table: { columns: ["a", "b"], rows: Array.from({ length: 80 }, (_, i) => [String(i), "v"]) } }] });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.subarray(-8).toString()).toContain("%%EOF");
    expect(pdf.length).toBeGreaterThan(1500);

    const k = await pmKit();
    const lease = await leaseContractDraftPdf(sq(), k.pm.ctx, k.lease.id);
    expect(lease.subarray(0, 5).toString()).toBe("%PDF-");
    const stranger = await pmKit();
    await expect(leaseContractDraftPdf(sq(), stranger.pm.ctx, k.lease.id)).rejects.toThrow(/not found/i);

    const st: any = await generateOwnerStatement(sq(), k.pm.ctx, k.portfolio.id, ym());
    expect((await ownerStatementPdf(sq(), k.pm.ctx, st.id)).subarray(0, 5).toString()).toBe("%PDF-");
    await expect(ownerStatementPdf(sq(), stranger.pm.ctx, st.id)).rejects.toThrow(/not found/i);
    const viewer = await makeUser(k.t, ["viewer"]);
    await expect(receiptPdf(sq(), viewer.ctx, "00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(ForbiddenError);

    const doc: any = await savePdfAsDocument(sq(), k.t.admin, "Statement test", pdf);
    expect(doc).toMatchObject({ kind: "other", version: 1 });
    await expect(savePdfAsDocument(sq(), viewer.ctx, "x", pdf)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("owner and tenant portals", () => {
  async function invite(k: Awaited<ReturnType<typeof pmKit>>, contactId: string, kind: "owner" | "tenant", email: string) {
    const r = await invitePortalUser(sq(), k.pm.ctx, { contactId, kind, baseUrl: BASE });
    expect(r.delivered).toBe(true);
    await acceptInvite(sq(), { token: tokenFrom(mockMailer.last(email)), password: PASSWORD });
    const session = await login(sq(), { tenantSlug: k.t.slug, email, password: PASSWORD });
    const ctx = await resolveRequestContext(sq(), session.token, { correlationId: "corr_portal_test" });
    return { ...r, ctx, token: session.token };
  }

  it("shows an owner only their own portfolio, with issued statements only, and no CRM access", async () => {
    const k = await pmKit();
    const other = await pmKit(); // a second tenant with its own owner
    const st: any = await generateOwnerStatement(sq(), k.pm.ctx, k.portfolio.id, ym());
    const owner = await invite(k, k.owner.id, "owner", `owner@${k.t.slug}.test`);
    expect(await portalMe(sq(), owner.ctx)).toMatchObject({ kind: "owner", name: "Hassan Mansoori" });

    let view: any = await ownerPortal(sq(), owner.ctx);
    expect(view.portfolios.map((p: any) => p.name)).toEqual(["Mansoori Holdings"]);
    expect(view.leases).toHaveLength(1);
    expect(view.leases[0].tenant).toBe("Priya Nair");
    expect(view.statements).toEqual([]); // the draft is internal
    await expect(ownerStatementPdfForPortal(sq(), owner.ctx, st.id)).rejects.toThrow(/not found/i);
    await issueOwnerStatement(sq(), k.pm.ctx, st.id);
    view = await ownerPortal(sq(), owner.ctx);
    expect(view.statements).toHaveLength(1);
    expect((await ownerStatementPdfForPortal(sq(), owner.ctx, st.id)).subarray(0, 5).toString()).toBe("%PDF-");

    // no CRM access at all
    expect(owner.ctx.grants.map((g) => g.permission)).toEqual(["portal.access"]);
    expect(hasPermission(owner.ctx, "lead.read")).toBe(false);
    await expect(listContacts(sq(), owner.ctx, { limit: 10, offset: 0 })).rejects.toThrow();
    await expect(tenantPortal(sq(), owner.ctx)).rejects.toBeInstanceOf(ForbiddenError); // an owner link cannot read tenant data
    // another tenant's owner cannot be invited with this tenant's contact, and cannot see this data
    const foreign = await invite(other, other.owner.id, "owner", `owner@${other.t.slug}.test`);
    expect((await ownerPortal(sq(), foreign.ctx) as any).statements).toEqual([]);
    await expect(ownerStatementPdfForPortal(sq(), foreign.ctx, st.id)).rejects.toThrow(/not found/i);
  });

  it("lets a tenant see their own lease and raise requests for it only", async () => {
    const k = await pmKit();
    const tenant = await invite(k, k.tenant.id, "tenant", `tenant@${k.t.slug}.test`);
    const view: any = await tenantPortal(sq(), tenant.ctx);
    expect(view.leases).toHaveLength(1);
    expect(view.leases[0].schedule).toHaveLength(12);
    expect(view.leases[0].tenant).toBeUndefined();
    await expect(ownerPortal(sq(), tenant.ctx)).rejects.toBeInstanceOf(ForbiddenError);

    const t1: any = await tenantRequestMaintenance(sq(), tenant.ctx, { leaseId: view.leases[0].id, category: "plumbing", title: "Kitchen tap is leaking" });
    expect(t1).toMatchObject({ status: "new", priority: "normal" });
    const row = await sq().query<any>("SELECT reporter_contact_id, lease_id FROM maintenance_tickets WHERE id=:id", { replacements: { id: t1.id }, type: QueryTypes.SELECT });
    expect(row[0]).toMatchObject({ reporter_contact_id: k.tenant.id, lease_id: view.leases[0].id });
    expect(((await tenantPortal(sq(), tenant.ctx)) as any).tickets).toHaveLength(1);

    // someone else's lease, a fake lease id, and an inactive lease are all refused
    const stranger = await pmKit();
    await expect(tenantRequestMaintenance(sq(), tenant.ctx, { leaseId: stranger.lease.id, category: "hvac", title: "AC broken" })).rejects.toThrow(/active lease/);
    await sq().query("UPDATE leases SET status='terminated' WHERE id=:id", { replacements: { id: k.lease.id } });
    await expect(tenantRequestMaintenance(sq(), tenant.ctx, { leaseId: k.lease.id, category: "hvac", title: "AC broken" })).rejects.toThrow(/active lease/);
  });

  it("needs a real relationship to invite, rejects duplicates, and revoking removes access immediately", async () => {
    const k = await pmKit();
    const nobody = await createContact(sq(), k.t.admin, { firstName: "No", lastName: "Email", phone: phone() });
    await expect(invitePortalUser(sq(), k.pm.ctx, { contactId: nobody.id, kind: "owner", baseUrl: BASE })).rejects.toThrow(/valid email/);
    const stranger = await createContact(sq(), k.t.admin, { firstName: "Not", lastName: "Owner", email: `x@${k.t.slug}.test`, phone: phone() });
    await expect(invitePortalUser(sq(), k.pm.ctx, { contactId: stranger.id, kind: "owner", baseUrl: BASE })).rejects.toThrow(/owns no portfolio/);
    await expect(invitePortalUser(sq(), k.pm.ctx, { contactId: stranger.id, kind: "tenant", baseUrl: BASE })).rejects.toThrow(/not a tenant/);
    const agent = await agentIn(k.t, k.org.marina.id, k.org.bu.id);
    await expect(invitePortalUser(sq(), agent.ctx, { contactId: k.owner.id, kind: "owner", baseUrl: BASE })).rejects.toBeInstanceOf(ForbiddenError);

    const owner = await invite(k, k.owner.id, "owner", `owner@${k.t.slug}.test`);
    await expect(invitePortalUser(sq(), k.pm.ctx, { contactId: k.owner.id, kind: "owner", baseUrl: BASE })).rejects.toThrow(/already has portal access/);
    const users: any[] = await listPortalUsers(sq(), k.pm.ctx);
    expect(users).toHaveLength(1);
    await revokePortalAccess(sq(), k.pm.ctx, users[0].id);
    await expect(resolveRequestContext(sq(), owner.token, { correlationId: "corr_x" })).rejects.toThrow();
    await expect(login(sq(), { tenantSlug: k.t.slug, email: `owner@${k.t.slug}.test`, password: PASSWORD })).rejects.toMatchObject({ code: "invalid_credentials" });
    void contextFor;
  });
});

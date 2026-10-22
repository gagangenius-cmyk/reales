import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { authorize, hasPermission } from "@reales/rbac";
import { getSetting } from "./config";
import { dubaiDate, selfEmployee, usersWith } from "./hr";
import { notifyUser } from "./notify";
import { plain } from "./scope";
import { getStorage, scanUpload, storageKeyFor, validateUpload } from "./storage";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

const DAY = 86_400_000;
const addDays = (s: string, n: number) => new Date(new Date(`${s}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);

/* ---------------------------------------------------------------------------------------------- documents */

export const HR_DOC_CATEGORIES = ["contract", "passport", "visa", "emirates_id", "labour_card", "insurance", "certificate", "policy", "payslip", "other"];

async function docVisible(u: Uow, ctx: RequestContext, d: any) {
  if (hasPermission(ctx, "hr.manage")) return true;
  if (d.get("visibility") === "company") return true;
  if (d.get("visibility") === "employee" && d.get("employeeId")) { const me = await selfEmployee(u, ctx); return !!me && me.get("id") === d.get("employeeId"); }
  return false;
}

export async function uploadHrDocument(sq: Sequelize, ctx: RequestContext, file: { filename: string; mime?: string; bytes: Buffer }, o: { employeeId?: string | null; title: string; category: string; expiresOn?: string | null; visibility?: "hr_only" | "employee" | "company" }) {
  authorize(ctx, "hr.manage");
  if (!o.title.trim()) throw new ConflictError("Give the document a title");
  if (!HR_DOC_CATEGORIES.includes(o.category)) throw new ConflictError("Unknown document category");
  if (o.expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(o.expiresOn)) throw new ConflictError("Expiry must be a date");
  if (!o.employeeId && o.visibility === "employee") throw new ConflictError("A company document is visible to everyone or to HR only");
  const v = validateUpload(file);
  await scanUpload(v);
  return withUow(sq, ctx, async (u) => {
    if (o.employeeId && !(await u.repo("HrEmployee").findById(o.employeeId, { transaction: u.tx }))) throw new NotFoundError("Employee");
    const key = storageKeyFor(ctx.tenantId, v.hash);
    await getStorage().put(key, v.bytes);
    const id = randomUUID();
    await u.repo("HrDocument").create({ id, employeeId: o.employeeId ?? null, title: o.title.trim().slice(0, 160), category: o.category, storageKey: key, fileName: v.filename, mime: v.mime, sizeBytes: v.bytes.length, expiresOn: o.expiresOn ?? null, visibility: o.visibility ?? (o.employeeId ? "employee" : "company"), uploadedBy: ctx.userId }, { transaction: u.tx });
    await u.audit({ action: "hr.document_uploaded", entityType: "hr_document", entityId: id, after: { title: o.title, category: o.category, employeeId: o.employeeId ?? null } });
    return plain(await u.repo("HrDocument").findById(id, { transaction: u.tx }));
  });
}

export async function listHrDocuments(sq: Sequelize, ctx: RequestContext, f: { employeeId?: string; category?: string; expiringWithinDays?: number } = {}) {
  return withUow(sq, ctx, async (u) => {
    const and: any[] = [];
    if (f.employeeId) and.push({ employeeId: f.employeeId });
    if (f.category) and.push({ category: f.category });
    if (f.expiringWithinDays !== undefined) and.push({ expiresOn: { [Op.ne]: null, [Op.lte]: addDays(dubaiDate(), f.expiringWithinDays) } });
    const rows = (await u.repo("HrDocument").findAll({ where: and.length ? { [Op.and]: and } : {}, order: [["createdAt", "DESC"]], limit: 300, transaction: u.tx })) as any[];
    const emps = new Map(((await u.repo("HrEmployee").findAll({ where: { id: { [Op.in]: [...new Set(rows.map((r) => r.get("employeeId")).filter(Boolean))].concat(["-"]) } }, attributes: ["id", "fullName"], transaction: u.tx })) as any[]).map((e) => [e.get("id"), e.get("fullName") as string]));
    const out = [];
    for (const r of rows) if (await docVisible(u, ctx, r)) { const p = plain(r); delete p.storageKey; out.push({ ...p, sizeBytes: Number(p.sizeBytes), employeeName: r.get("employeeId") ? emps.get(r.get("employeeId")) ?? "" : "Company" }); }
    return out;
  });
}

export async function readHrDocument(sq: Sequelize, ctx: RequestContext, id: string) {
  const d = await withUow(sq, ctx, async (u) => {
    const r: any = await u.repo("HrDocument").findById(id, { transaction: u.tx });
    if (!r || !(await docVisible(u, ctx, r))) throw new NotFoundError("Document");
    await u.audit({ action: "hr.document_downloaded", entityType: "hr_document", entityId: id });
    return { key: r.get("storageKey") as string, name: r.get("fileName") as string, mime: r.get("mime") as string };
  });
  return { bytes: await getStorage().get(d.key), filename: d.name, mime: d.mime };
}

export async function deleteHrDocument(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "hr.manage");
  return withUow(sq, ctx, async (u) => { if (!(await u.repo("HrDocument").deleteById(id, { transaction: u.tx }))) throw new NotFoundError("Document"); await u.audit({ action: "hr.document_deleted", entityType: "hr_document", entityId: id }); return { id }; });
}

/* ---------------------------------------------------------------------------------------------- announcements and occasions */

/** HR notices everyone sees: pinned first, then newest; scheduled ones appear at their time and expired ones drop off. */
export async function listAnnouncements(sq: Sequelize, ctx: RequestContext, all = false) {
  return withUow(sq, ctx, async (u) => {
    const now = new Date();
    const where = all && hasPermission(ctx, "hr.manage") ? {} : { publishAt: { [Op.lte]: now }, [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: now } }] };
    return (await u.repo("HrAnnouncement").findAll({ where, order: [["pinned", "DESC"], ["publishAt", "DESC"]], limit: 100, transaction: u.tx })).map(plain);
  });
}
export async function saveAnnouncement(sq: Sequelize, ctx: RequestContext, i: { id?: string; title: string; body: string; pinned?: boolean; publishAt?: string; expiresAt?: string | null }) {
  authorize(ctx, "hr.manage");
  if (!i.title.trim() || !i.body.trim()) throw new ConflictError("Title and message are required");
  const publishAt = i.publishAt ? new Date(i.publishAt) : new Date(), expiresAt = i.expiresAt ? new Date(i.expiresAt) : null;
  if (Number.isNaN(+publishAt) || (expiresAt && (Number.isNaN(+expiresAt) || expiresAt <= publishAt))) throw new ConflictError("Check the publish and expiry times");
  return withUow(sq, ctx, async (u) => {
    const vals = { title: i.title.trim().slice(0, 200), body: i.body.trim(), pinned: !!i.pinned, publishAt, expiresAt };
    const id = i.id ?? randomUUID();
    if (i.id) { if (!(await u.repo("HrAnnouncement").updateById(id, vals, { transaction: u.tx }))) throw new NotFoundError("Announcement"); } else await u.repo("HrAnnouncement").create({ id, ...vals, createdBy: ctx.userId }, { transaction: u.tx });
    await u.audit({ action: i.id ? "hr.announcement_updated" : "hr.announcement_posted", entityType: "hr_announcement", entityId: id, after: { title: vals.title } });
    return plain(await u.repo("HrAnnouncement").findById(id, { transaction: u.tx }));
  });
}
export async function deleteAnnouncement(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "hr.manage");
  return withUow(sq, ctx, async (u) => { if (!(await u.repo("HrAnnouncement").deleteById(id, { transaction: u.tx }))) throw new NotFoundError("Announcement"); await u.audit({ action: "hr.announcement_removed", entityType: "hr_announcement", entityId: id }); return { id }; });
}

export async function saveOccasion(sq: Sequelize, ctx: RequestContext, i: { id?: string; title: string; onDate: string; kind?: string; message?: string | null; yearly?: boolean }) {
  authorize(ctx, "hr.manage");
  if (!i.title.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(i.onDate)) throw new ConflictError("A title and a date are required");
  return withUow(sq, ctx, async (u) => {
    const vals = { title: i.title.trim().slice(0, 160), onDate: i.onDate, kind: i.kind ?? "celebration", message: i.message?.trim().slice(0, 500) || null, yearly: !!i.yearly };
    const id = i.id ?? randomUUID();
    if (i.id) { if (!(await u.repo("HrOccasion").updateById(id, vals, { transaction: u.tx }))) throw new NotFoundError("Occasion"); } else await u.repo("HrOccasion").create({ id, ...vals, createdBy: ctx.userId }, { transaction: u.tx });
    return plain(await u.repo("HrOccasion").findById(id, { transaction: u.tx }));
  });
}
export async function deleteOccasion(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "hr.manage");
  return withUow(sq, ctx, async (u) => { if (!(await u.repo("HrOccasion").deleteById(id, { transaction: u.tx }))) throw new NotFoundError("Occasion"); return { id }; });
}

export interface Celebration { kind: "birthday" | "anniversary" | "new_joiner" | "occasion" | "holiday"; date: string; daysAway: number; title: string; detail?: string }

/**
 * What to celebrate in the next N days: birthdays and work anniversaries (month and day only, never the birth year), recent joiners, company occasions
 * and public holidays. Everyone who is signed in may see it; it contains names and dates only.
 */
export async function celebrations(sq: Sequelize, ctx: RequestContext, days = 30): Promise<Celebration[]> {
  return withUow(sq, ctx, async (u) => {
    const today = dubaiDate(), end = addDays(today, days), year = Number(today.slice(0, 4));
    const out: Celebration[] = [];
    const away = (d: string) => Math.round((Date.parse(d) - Date.parse(today)) / DAY);
    const nextOccurrence = (mmdd: string) => { let d = `${year}-${mmdd}`; if (d < today) d = `${year + 1}-${mmdd}`; return d; };
    const emps = (await u.repo("HrEmployee").findAll({ where: { status: { [Op.ne]: "exited" } }, attributes: ["fullName", "dateOfBirth", "joinedOn", "designation"], transaction: u.tx })) as any[];
    for (const e of emps) {
      if (e.get("dateOfBirth")) { const d = nextOccurrence(String(e.get("dateOfBirth")).slice(5, 10)); if (d <= end) out.push({ kind: "birthday", date: d, daysAway: away(d), title: `${e.get("fullName")}'s birthday` }); }
      const j = String(e.get("joinedOn")); const d = nextOccurrence(j.slice(5, 10)), yrs = Number(d.slice(0, 4)) - Number(j.slice(0, 4));
      if (yrs > 0 && d <= end) out.push({ kind: "anniversary", date: d, daysAway: away(d), title: `${e.get("fullName")}: ${yrs} year${yrs > 1 ? "s" : ""} with us`, detail: e.get("designation") ?? undefined });
      if (j >= addDays(today, -30) && j <= today) out.push({ kind: "new_joiner", date: j, daysAway: away(j), title: `Welcome ${e.get("fullName")}`, detail: e.get("designation") ?? undefined });
    }
    for (const o of (await u.repo("HrOccasion").findAll({ transaction: u.tx })) as any[]) {
      const base = String(o.get("onDate")), d = o.get("yearly") ? nextOccurrence(base.slice(5, 10)) : base;
      if (d >= today && d <= end) out.push({ kind: "occasion", date: d, daysAway: away(d), title: o.get("title"), detail: o.get("message") ?? undefined });
    }
    for (const h of (await u.repo("HrHoliday").findAll({ where: { onDate: { [Op.between]: [today, end] } }, transaction: u.tx })) as any[]) out.push({ kind: "holiday", date: String(h.get("onDate")), daysAway: away(String(h.get("onDate"))), title: h.get("name") });
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  });
}

/* ---------------------------------------------------------------------------------------------- dashboard and expiry alerts */

export async function hrDashboard(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "hr.read");
  return withUow(sq, ctx, async (u) => {
    const t = ctx.tenantId, today = dubaiDate(), soon = addDays(today, 60), month = addDays(today, 30);
    const q = async (sql: string, rep: Record<string, unknown> = {}) => (await u.sq.query(sql, { replacements: { t, today, soon, month, ...rep }, transaction: u.tx, type: QueryTypes.SELECT })) as any[];
    const [[head], byDept, [att], [pending], expiring, probation] = await Promise.all([
      q("SELECT SUM(status='active') AS active, SUM(status='on_notice') AS notice, SUM(status='exited') AS exited, SUM(joined_on >= :month AND status<>'exited') AS joiners FROM hr_employees WHERE tenant_id=:t"),
      q("SELECT COALESCE(department,'Unassigned') AS label, COUNT(*) AS value FROM hr_employees WHERE tenant_id=:t AND status<>'exited' GROUP BY department ORDER BY value DESC LIMIT 10"),
      q("SELECT SUM(a.check_in_at IS NOT NULL) AS present, SUM(a.late_minutes>0) AS late FROM hr_attendance a WHERE a.tenant_id=:t AND a.work_date=:today"),
      q("SELECT COUNT(*) AS n FROM hr_leave_requests WHERE tenant_id=:t AND status='pending'"),
      q("SELECT e.id, e.full_name AS name, x.what, x.on_date AS onDate FROM hr_employees e JOIN (SELECT id, 'Passport' AS what, passport_expires_on AS on_date FROM hr_employees WHERE tenant_id=:t UNION ALL SELECT id, 'Visa', visa_expires_on FROM hr_employees WHERE tenant_id=:t UNION ALL SELECT id, 'Emirates ID', emirates_id_expires_on FROM hr_employees WHERE tenant_id=:t) x ON x.id=e.id WHERE e.tenant_id=:t AND e.status<>'exited' AND x.on_date IS NOT NULL AND x.on_date <= :soon ORDER BY x.on_date LIMIT 20"),
      q("SELECT id, full_name AS name, probation_ends_on AS onDate FROM hr_employees WHERE tenant_id=:t AND status='active' AND probation_ends_on BETWEEN :today AND :month ORDER BY probation_ends_on LIMIT 20"),
    ]);
    const onLeaveToday = Number((await q("SELECT COUNT(DISTINCT employee_id) AS n FROM hr_leave_requests WHERE tenant_id=:t AND status='approved' AND :today BETWEEN from_date AND to_date"))[0]?.n ?? 0);
    return {
      headcount: { active: Number(head?.active ?? 0), onNotice: Number(head?.notice ?? 0), exited: Number(head?.exited ?? 0), newJoiners: Number(head?.joiners ?? 0) },
      today: { present: Number(att?.present ?? 0), late: Number(att?.late ?? 0), onLeave: onLeaveToday }, pendingLeave: Number(pending?.n ?? 0),
      byDepartment: byDept.map((d) => ({ label: d.label as string, value: Number(d.value) })),
      expiring: expiring.map((x) => ({ employeeId: x.id as string, name: x.name as string, what: x.what as string, date: String(x.onDate).slice(0, 10), expired: String(x.onDate).slice(0, 10) < today })),
      probationEnding: probation.map((x) => ({ employeeId: x.id as string, name: x.name as string, date: String(x.onDate).slice(0, 10) })),
    };
  });
}

/** Warns HR (and the employee) before a passport, visa, Emirates ID or uploaded document expires. One alert per item per expiry date. */
export async function hrExpirySweep(sq: Sequelize, ctx: RequestContext, now = new Date()) {
  return withUow(sq, ctx, async (u) => {
    const days = await getSetting<number>(u.sq, ctx.tenantId, "hr.expiry_alert_days");
    const today = dubaiDate(now), limit = addDays(today, days);
    const hr = await usersWith(u, "hr.manage");
    let n = 0;
    const alert = async (key: string, employee: any | null, what: string, date: string) => {
      const expired = date < today, title = `${what}${employee ? ` of ${employee.get("fullName")}` : ""} ${expired ? "expired" : "expires"} on ${date}`;
      for (const id of hr) if (await notifyUser(u, { userId: id, kind: "hr.expiry", title, entityType: "hr_employee", entityId: employee?.get("id"), dedupeKey: `hrexp:${key}:${date}:${id}`, path: employee ? `/hr/employees/${employee.get("id")}` : "/hr/documents" })) n++;
      if (employee?.get("userId") && !expired && (await notifyUser(u, { userId: employee.get("userId"), kind: "hr.expiry", title, dedupeKey: `hrexp:${key}:${date}:self` }))) n++;
    };
    for (const e of (await u.repo("HrEmployee").findAll({ where: { status: { [Op.ne]: "exited" } }, transaction: u.tx })) as any[]) {
      for (const [field, what] of [["passportExpiresOn", "Passport"], ["visaExpiresOn", "Visa"], ["emiratesIdExpiresOn", "Emirates ID"]] as const) { const d = e.get(field) ? String(e.get(field)).slice(0, 10) : null; if (d && d <= limit) await alert(`${e.get("id")}:${field}`, e, what, d); }
    }
    for (const d of (await u.repo("HrDocument").findAll({ where: { expiresOn: { [Op.ne]: null, [Op.lte]: limit } }, transaction: u.tx })) as any[]) {
      const e = d.get("employeeId") ? await u.repo("HrEmployee").findById(d.get("employeeId"), { transaction: u.tx }) : null;
      await alert(`doc:${d.get("id")}`, e, `Document "${d.get("title")}"`, String(d.get("expiresOn")).slice(0, 10));
    }
    return n;
  });
}

import { randomUUID } from "node:crypto";
import { Op, Sequelize } from "sequelize";
import { RequestContext } from "@reales/database";
import { hasPermission, ForbiddenError } from "@reales/rbac";
import { INSPECTION_SCOPE } from "./inspections";
import { LEASE_SCOPE } from "./leases";
import { notifyInUow } from "./notifications";
import { plain, scopeWhere } from "./scope";
import { TICKET_SCOPE } from "./maintenance";
import { VIEWING_SCOPE } from "./viewings";
import { assertSweepAllowed, ConflictError, NotFoundError, Uow, withUow } from "./uow";

export type CalendarKind = "task" | "viewing" | "rent_due" | "lease_expiry" | "inspection" | "ticket_sla" | "dsr_due" | "kyc_expiry";
export interface CalendarEvent { id: string; kind: CalendarKind; title: string; start: string; allDay: boolean; link: string | null; detail?: string }

const iso = (d: unknown) => new Date(d as string).toISOString();
const day = (d: unknown) => String(d).slice(0, 10);
const MAX_RANGE_DAYS = 100;

/**
 * One merged agenda of everything dated that the caller can see: tasks, viewings, rent due dates, lease expiries, inspections, maintenance SLAs,
 * privacy-request deadlines and KYC expiries. Each source applies the SAME scope as its own list, so the calendar never reveals more than the app does.
 */
export async function getCalendar(sq: Sequelize, ctx: RequestContext, range: { from: string; to: string }): Promise<CalendarEvent[]> {
  const from = new Date(range.from), to = new Date(range.to);
  if (isNaN(+from) || isNaN(+to) || to <= from) throw new ConflictError("Invalid date range");
  if ((+to - +from) / 86_400_000 > MAX_RANGE_DAYS) throw new ConflictError(`The range is limited to ${MAX_RANGE_DAYS} days`);
  const fromD = range.from.slice(0, 10), toD = range.to.slice(0, 10);
  return withUow(sq, ctx, async (u) => {
    const ev: CalendarEvent[] = [];
    const wide = (p: string) => ctx.grants.some((g) => g.permission === p && g.scope !== "own_records");

    for (const t of (await u.repo("Task").findAll({ where: { status: "open", dueAt: { [Op.gte]: from, [Op.lt]: to }, ...(hasPermission(ctx, "lead.assign") ? {} : { assigneeId: ctx.userId }) }, limit: 500, transaction: u.tx })) as any[]) {
      ev.push({ id: `task:${t.get("id")}`, kind: "task", title: t.get("title"), start: iso(t.get("dueAt")), allDay: false, link: t.get("leadId") ? `/leads/${t.get("leadId")}` : "/tasks" });
    }
    if (hasPermission(ctx, "viewing.read")) {
      const scope = await scopeWhere(u, ctx, "viewing.read", VIEWING_SCOPE);
      for (const v of (await u.repo("Viewing").findAll({ where: { [Op.and]: [scope, { status: { [Op.in]: ["scheduled", "checked_in"] }, scheduledAt: { [Op.gte]: from, [Op.lt]: to } }] }, limit: 500, transaction: u.tx })) as any[]) {
        ev.push({ id: `viewing:${v.get("id")}`, kind: "viewing", title: `Viewing${v.get("locationNote") ? ` - ${v.get("locationNote")}` : ""}`, start: iso(v.get("scheduledAt")), allDay: false, link: "/viewings" });
      }
    }
    if (hasPermission(ctx, "lease.read")) {
      const scope = await scopeWhere(u, ctx, "lease.read", LEASE_SCOPE);
      const leases = (await u.repo("Lease").findAll({ where: scope, attributes: ["id", "endsOn", "status"], limit: 5000, transaction: u.tx })) as any[];
      const ids = leases.map((l) => l.get("id"));
      for (const l of leases.filter((x) => x.get("status") === "active" && day(x.get("endsOn")) >= fromD && day(x.get("endsOn")) < toD)) {
        ev.push({ id: `lease_expiry:${l.get("id")}`, kind: "lease_expiry", title: "Lease ends", start: day(l.get("endsOn")), allDay: true, link: `/leases/${l.get("id")}` });
      }
      if (ids.length) {
        for (const r of (await u.repo("RentSchedule").findAll({ where: { leaseId: { [Op.in]: ids }, status: { [Op.in]: ["pending", "partial", "overdue"] }, dueDate: { [Op.gte]: fromD, [Op.lt]: toD } }, limit: 1000, transaction: u.tx })) as any[]) {
          ev.push({ id: `rent:${r.get("id")}`, kind: "rent_due", title: `Rent instalment ${r.get("seq")} due`, start: day(r.get("dueDate")), allDay: true, link: `/leases/${r.get("leaseId")}`, detail: `${r.get("amount")} (paid ${r.get("paidAmount")})` });
        }
      }
    }
    if (hasPermission(ctx, "inspection.read")) {
      const scope = await scopeWhere(u, ctx, "inspection.read", INSPECTION_SCOPE);
      for (const i of (await u.repo("Inspection").findAll({ where: { [Op.and]: [scope, { status: { [Op.in]: ["scheduled", "in_progress"] }, scheduledFor: { [Op.gte]: from, [Op.lt]: to } }] }, limit: 500, transaction: u.tx })) as any[]) {
        ev.push({ id: `inspection:${i.get("id")}`, kind: "inspection", title: `${String(i.get("kind")).replace("_", "-")} inspection`, start: iso(i.get("scheduledFor")), allDay: false, link: "/inspections" });
      }
    }
    if (hasPermission(ctx, "maintenance.read")) {
      const scope = await scopeWhere(u, ctx, "maintenance.read", TICKET_SCOPE);
      for (const t of (await u.repo("Ticket").findAll({ where: { [Op.and]: [scope, { status: { [Op.in]: ["new", "triaged", "quoted", "approved", "in_progress"] }, slaDueAt: { [Op.gte]: from, [Op.lt]: to } }] }, limit: 500, transaction: u.tx })) as any[]) {
        ev.push({ id: `ticket:${t.get("id")}`, kind: "ticket_sla", title: `SLA due: ${t.get("title")}`, start: iso(t.get("slaDueAt")), allDay: false, link: `/maintenance/${t.get("id")}`, detail: t.get("priority") });
      }
    }
    if (hasPermission(ctx, "dsr.manage")) {
      for (const r of (await u.repo("DsrRequest").findAll({ where: { status: "received", dueAt: { [Op.gte]: from, [Op.lt]: to } }, limit: 200, transaction: u.tx })) as any[]) {
        ev.push({ id: `dsr:${r.get("id")}`, kind: "dsr_due", title: `Data request (${r.get("kind")}) due`, start: iso(r.get("dueAt")), allDay: false, link: "/compliance" });
      }
    }
    if (wide("kyc.read")) {
      for (const k of (await u.repo("KycProfile").findAll({ where: { status: "approved", expiresAt: { [Op.gte]: fromD, [Op.lt]: toD } }, limit: 200, transaction: u.tx })) as any[]) {
        ev.push({ id: `kyc:${k.get("id")}`, kind: "kyc_expiry", title: "KYC expires", start: day(k.get("expiresAt")), allDay: true, link: "/compliance" });
      }
    }
    return ev.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
  });
}

// ---------------------------------------------------------------- iCalendar (RFC 5545) export
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
/** Content lines are limited to 75 octets; continuation lines start with a space. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export function toIcs(events: CalendarEvent[], now = new Date(), calName = "Reales CRM"): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Reales CRM//Calendar//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${esc(calName)}`];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.id}@reales.crm`, `DTSTAMP:${stamp(now)}`);
    if (e.allDay) lines.push(`DTSTART;VALUE=DATE:${e.start.replace(/-/g, "")}`);
    else { const s = new Date(e.start); lines.push(`DTSTART:${stamp(s)}`, `DTEND:${stamp(new Date(+s + 30 * 60_000))}`); }
    lines.push(`SUMMARY:${esc(e.title)}`);
    if (e.detail) lines.push(`DESCRIPTION:${esc(e.detail)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------- task centre
export interface TaskFilter { scope?: "mine" | "all"; status?: "open" | "done"; overdueOnly?: boolean; limit?: number }

export async function listTasks(sq: Sequelize, ctx: RequestContext, f: TaskFilter = {}) {
  return withUow(sq, ctx, async (u) => {
    const all = f.scope === "all";
    if (all && !hasPermission(ctx, "lead.assign")) throw new ForbiddenError("Missing permission: lead.assign");
    const where: any = { ...(all ? {} : { assigneeId: ctx.userId }), status: f.status ?? "open", ...(f.overdueOnly ? { dueAt: { [Op.lt]: new Date() } } : {}) };
    const rows = (await u.repo("Task").findAll({ where, order: [["dueAt", "ASC"]], limit: Math.min(f.limit ?? 200, 500), transaction: u.tx })) as any[];
    return rows.map((t) => ({ ...plain(t), overdue: t.get("status") === "open" && !!t.get("dueAt") && new Date(t.get("dueAt")) < new Date() }));
  });
}

export async function rescheduleTask(sq: Sequelize, ctx: RequestContext, id: string, dueAt: string | null) {
  return withUow(sq, ctx, async (u) => {
    const t: any = await u.repo("Task").findById(id, { transaction: u.tx });
    if (!t || (t.get("assigneeId") !== ctx.userId && !hasPermission(ctx, "lead.assign"))) throw new NotFoundError("Task");
    if (t.get("status") !== "open") throw new ConflictError("Only an open task can be rescheduled");
    await u.repo("Task").updateById(id, { dueAt: dueAt ? new Date(dueAt) : null }, { transaction: u.tx });
    return plain(await u.repo("Task").findById(id, { transaction: u.tx }));
  });
}

/** Reminders: tell the assignee once when a task falls due within the next hour, and once more when it becomes overdue. */
export async function taskReminderSweep(sq: Sequelize, ctx: RequestContext, now = new Date()) {
  assertSweepAllowed(ctx, "lead.update");
  return withUow(sq, ctx, async (u: Uow) => {
    let n = 0;
    const soon = new Date(+now + 3_600_000);
    for (const t of (await u.repo("Task").findAll({ where: { status: "open", assigneeId: { [Op.ne]: null }, dueAt: { [Op.lt]: soon, [Op.ne]: null } }, limit: 1000, transaction: u.tx })) as any[]) {
      const overdue = new Date(t.get("dueAt")) < now;
      if (await notifyInUow(u, { userId: t.get("assigneeId"), kind: overdue ? "task.overdue" : "task.due_soon", title: `${overdue ? "Overdue" : "Due within the hour"}: ${t.get("title")}`, entityType: t.get("leadId") ? "lead" : "task", entityId: t.get("leadId") ?? t.get("id"), dedupeKey: `task:${t.get("id")}:${overdue ? "overdue" : "soon"}` })) n++;
    }
    return n;
  });
}

void randomUUID;

import { randomUUID } from "node:crypto";
import { Op, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

/** UAE has a fixed offset (UTC+4, no daylight saving), so wall-clock to UTC conversion is exact. */
const OFFSET_MS = 4 * 3_600_000;
export const WORKSPACE_TZ = "Asia/Dubai";

export interface Window { weekday: number; startTime: string; endTime: string }
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const toDubai = (d: Date) => new Date(d.getTime() + OFFSET_MS); // read with getUTC* to get Dubai wall-clock
export const fromDubai = (date: string, minutes: number) => new Date(Date.parse(`${date}T00:00:00Z`) + minutes * 60_000 - OFFSET_MS);

function ownOrManage(ctx: RequestContext, userId: string) {
  authorize(ctx, "viewing.manage", { ownerUserId: userId });
}

export async function getAvailability(sq: Sequelize, ctx: RequestContext, userId: string) {
  authorize(ctx, "viewing.read");
  return withUow(sq, ctx, async (u) => {
    const [windows, timeOff] = await Promise.all([
      u.repo("AgentAvailability").findAll({ where: { userId }, order: [["weekday", "ASC"], ["startTime", "ASC"]], transaction: u.tx }),
      u.repo("AgentTimeOff").findAll({ where: { userId, endsAt: { [Op.gte]: new Date() } }, order: [["startsAt", "ASC"]], transaction: u.tx }),
    ]);
    return { timezone: WORKSPACE_TZ, windows: windows.map(plain), timeOff: timeOff.map(plain) };
  });
}

/** Replace the agent's weekly windows. Overlapping windows on one day are rejected. */
export async function setWeeklyAvailability(sq: Sequelize, ctx: RequestContext, userId: string, windows: Window[]) {
  ownOrManage(ctx, userId);
  for (const w of windows) {
    if (!(Number.isInteger(w.weekday) && w.weekday >= 0 && w.weekday <= 6)) throw new ConflictError("Weekday must be 0 (Sunday) to 6 (Saturday)");
    if (!HHMM.test(w.startTime) || !HHMM.test(w.endTime)) throw new ConflictError("Times must look like 09:00");
    if (toMin(w.endTime) <= toMin(w.startTime)) throw new ConflictError("A window must end after it starts");
  }
  for (let d = 0; d < 7; d++) {
    const day = windows.filter((w) => w.weekday === d).sort((a, b) => toMin(a.startTime) - toMin(b.startTime));
    for (let i = 1; i < day.length; i++) if (toMin(day[i]!.startTime) < toMin(day[i - 1]!.endTime)) throw new ConflictError("Windows on the same day overlap");
  }
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("User").findById(userId, { transaction: u.tx }))) throw new NotFoundError("User");
    await u.repo("AgentAvailability").deleteWhere({ userId }, { transaction: u.tx });
    for (const w of windows) await u.repo("AgentAvailability").create({ id: randomUUID(), userId, weekday: w.weekday, startTime: w.startTime, endTime: w.endTime }, { transaction: u.tx });
    await u.audit({ action: "availability.updated", entityType: "user", entityId: userId, after: { windows } });
    return { windows: windows.length };
  });
}

export async function addTimeOff(sq: Sequelize, ctx: RequestContext, userId: string, i: { startsAt: string; endsAt: string; reason?: string }) {
  ownOrManage(ctx, userId);
  const s = new Date(i.startsAt), e = new Date(i.endsAt);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) throw new ConflictError("Time off must end after it starts");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("User").findById(userId, { transaction: u.tx }))) throw new NotFoundError("User");
    const id = randomUUID();
    await u.repo("AgentTimeOff").create({ id, userId, startsAt: s, endsAt: e, reason: i.reason?.trim() || null, createdBy: ctx.userId }, { transaction: u.tx });
    await u.audit({ action: "time_off.added", entityType: "user", entityId: userId, after: { startsAt: i.startsAt, endsAt: i.endsAt, reason: i.reason } });
    return { id };
  });
}

export async function removeTimeOff(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const row: any = await u.repo("AgentTimeOff").findById(id, { transaction: u.tx });
    if (!row) throw new NotFoundError("Time off");
    ownOrManage(ctx, row.get("userId"));
    await u.repo("AgentTimeOff").deleteById(id, { transaction: u.tx });
    await u.audit({ action: "time_off.removed", entityType: "user", entityId: row.get("userId") });
  });
}

/** Throws when the agent has set working hours and the requested viewing falls outside them or inside time off. No windows = no restriction. */
export async function assertAgentAvailable(u: Uow, agentId: string, start: Date, end: Date) {
  const windows: any[] = await u.repo("AgentAvailability").findAll({ where: { userId: agentId }, transaction: u.tx });
  if (windows.length) {
    const ls = toDubai(start), le = toDubai(end);
    const sameDay = ls.toISOString().slice(0, 10) === le.toISOString().slice(0, 10);
    const sMin = ls.getUTCHours() * 60 + ls.getUTCMinutes(), eMin = le.getUTCHours() * 60 + le.getUTCMinutes();
    const ok = sameDay && windows.some((w) => w.get("weekday") === ls.getUTCDay() && toMin(w.get("startTime")) <= sMin && eMin <= toMin(w.get("endTime")));
    if (!ok) throw new ConflictError("The agent is not available at that time (outside their working hours)");
  }
  const off = await u.repo("AgentTimeOff").findOne({ where: { userId: agentId, startsAt: { [Op.lt]: end }, endsAt: { [Op.gt]: start } }, transaction: u.tx });
  if (off) throw new ConflictError(`The agent is on time off then${off.get("reason") ? ` (${off.get("reason")})` : ""}`);
}

/** Free start times for one agent on one Dubai calendar day: inside working hours, outside time off and existing viewings, in the future. */
export async function freeSlots(sq: Sequelize, ctx: RequestContext, agentUserId: string, date: string, durationMin = 30, stepMin = 30) {
  authorize(ctx, "viewing.read");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ConflictError("Date must look like 2026-11-02");
  return withUow(sq, ctx, async (u) => {
    const dayStart = fromDubai(date, 0), dayEnd = fromDubai(date, 24 * 60);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const [windows, off, viewings] = await Promise.all([
      u.repo("AgentAvailability").findAll({ where: { userId: agentUserId, weekday }, transaction: u.tx }),
      u.repo("AgentTimeOff").findAll({ where: { userId: agentUserId, startsAt: { [Op.lt]: dayEnd }, endsAt: { [Op.gt]: dayStart } }, transaction: u.tx }),
      u.repo("Viewing").findAll({ where: { agentUserId, status: { [Op.in]: ["scheduled", "checked_in"] }, scheduledAt: { [Op.between]: [new Date(dayStart.getTime() - 8 * 3_600_000), dayEnd] } }, transaction: u.tx }),
    ]);
    // Without any weekly window the agent is unrestricted, which we show as the default 09:00-18:00 day.
    const hasRules = !!(await u.repo("AgentAvailability").findOne({ where: { userId: agentUserId }, transaction: u.tx }));
    const spans: [number, number][] = hasRules ? (windows as any[]).map((w) => [toMin(w.get("startTime")), toMin(w.get("endTime"))]) : [[9 * 60, 18 * 60]];
    const busy = [
      ...(off as any[]).map((o) => [new Date(o.get("startsAt")).getTime(), new Date(o.get("endsAt")).getTime()] as [number, number]),
      ...(viewings as any[]).map((v) => { const s = new Date(v.get("scheduledAt")).getTime(); return [s, s + v.get("durationMin") * 60_000] as [number, number]; }),
    ];
    const slots: string[] = [];
    for (const [from, to] of spans) {
      for (let m = from; m + durationMin <= to; m += stepMin) {
        const s = fromDubai(date, m).getTime(), e = s + durationMin * 60_000;
        if (s < Date.now()) continue;
        if (busy.some(([bs, be]) => s < be && bs < e)) continue;
        slots.push(new Date(s).toISOString());
      }
    }
    return { date, timezone: WORKSPACE_TZ, durationMin, restricted: hasRules, slots };
  });
}

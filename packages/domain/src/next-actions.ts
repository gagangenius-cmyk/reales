import { Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { hasPermission } from "@reales/rbac";
import { getLead } from "./leads";
import { withUow } from "./uow";

/**
 * Next best actions for one lead, from plain rules over what the CRM already knows (assignment, first response, follow-up, last contact, stage age,
 * matching listings). Each action says what to do and why, most urgent first. Nothing here is a prediction: every line is a fact about the lead that a
 * manager could check, so agents can trust and act on it.
 */
export interface NextAction { key: string; severity: "urgent" | "soon" | "info"; title: string; detail: string; href?: string }

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const ago = (ms: number) => (ms < HOUR ? `${Math.max(1, Math.round(ms / MIN))} minutes` : ms < DAY ? `${Math.round(ms / HOUR)} hours` : `${Math.round(ms / DAY)} days`);

export async function nextBestActions(sq: Sequelize, ctx: RequestContext, leadId: string, now = new Date()): Promise<NextAction[]> {
  const lead: any = await getLead(sq, ctx, leadId);
  if (lead.status !== "open") return [];
  const t = +now, created = +new Date(lead.createdAt);
  const lastContact = lead.lastContactedAt ? +new Date(lead.lastContactedAt) : null, follow = lead.nextFollowUpAt ? +new Date(lead.nextFollowUpAt) : null;
  const out: NextAction[] = [];
  if (!lead.assignedUserId && !lead.poolId) out.push({ key: "assign", severity: "urgent", title: "Give this lead an owner", detail: `It has been unassigned for ${ago(t - created)}.`, ...(hasPermission(ctx, "lead.assign") ? { href: "#assign" } : {}) });
  if (lead.assignedUserId && !lastContact && !lead.firstResponseAt) out.push({ key: "first_contact", severity: t - created > 15 * MIN ? "urgent" : "soon", title: "Make first contact", detail: `Nobody has contacted this lead yet; it arrived ${ago(t - created)} ago.` });
  if (follow !== null && follow < t) out.push({ key: "follow_up_overdue", severity: "urgent", title: "Follow-up is overdue", detail: `It was due ${ago(t - follow)} ago. Call or reschedule it.` });
  if (lead.isHot && lastContact !== null && t - lastContact > 2 * DAY) out.push({ key: "hot_quiet", severity: "urgent", title: "Hot lead has gone quiet", detail: `Last contact was ${ago(t - lastContact)} ago.` });
  if (follow === null && lead.assignedUserId) out.push({ key: "set_follow_up", severity: "soon", title: "Set the next follow-up", detail: "No follow-up is scheduled, so this lead can slip through." });
  if (!lead.isHot && lastContact !== null && t - lastContact > 7 * DAY && (follow === null || follow < t + DAY)) out.push({ key: "re_engage", severity: "soon", title: "Re-engage this lead", detail: `No contact for ${ago(t - lastContact)}.` });
  const extra = await withUow(sq, ctx, async (u) => {
    const stage: any = (await u.sq.query("SELECT MAX(created_at) AS at FROM lead_stage_events WHERE tenant_id=:t AND lead_id=:l", { replacements: { t: ctx.tenantId, l: leadId }, transaction: u.tx, type: "SELECT" as never })) as unknown as { at: Date | null }[];
    const matches = hasPermission(ctx, "match.read") ? ((await u.sq.query("SELECT COUNT(*) AS n FROM property_matches WHERE tenant_id=:t AND lead_id=:l AND status='new'", { replacements: { t: ctx.tenantId, l: leadId }, transaction: u.tx, type: "SELECT" as never })) as unknown as { n: number }[])[0] : { n: 0 };
    return { stageAt: stage[0]?.at ? +new Date(stage[0].at) : created, matches: Number(matches?.n ?? 0) };
  });
  if (extra.matches > 0) out.push({ key: "share_matches", severity: "soon", title: `Share ${extra.matches} matching listing${extra.matches === 1 ? "" : "s"}`, detail: "New listings fit this lead's budget and requirements and have not been shared yet." });
  if (t - extra.stageAt > 14 * DAY) out.push({ key: "stage_stuck", severity: "info", title: "Stuck in this stage", detail: `It has not moved for ${ago(t - extra.stageAt)}. Move it forward or mark it lost with a reason.` });
  const rank = { urgent: 0, soon: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

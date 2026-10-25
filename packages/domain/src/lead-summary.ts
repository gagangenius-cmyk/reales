import { QueryTypes, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { hasPermission } from "@reales/rbac";
import { getLead } from "./leads";
import { withUow } from "./uow";

/**
 * A short written summary of a lead, built only from what the CRM recorded: who they are, what they want, where they came from, what has been tried and
 * what is outstanding. It is composed by fixed rules, so every sentence can be traced to a record and nothing is invented; the lead's own text (notes) is
 * never sent to a third party. A language-model rewrite could be layered on later, but this version already gives a manager the picture in ten seconds.
 */
const DAY = 86_400_000;
const ago = (ms: number) => (ms < 3_600_000 ? "less than an hour" : ms < DAY ? `${Math.round(ms / 3_600_000)} hours` : `${Math.round(ms / DAY)} days`);
const money = (n: unknown) => (n == null ? null : Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }));
const nice = (s: unknown) => String(s ?? "").replace(/_/g, " ");

/**
 * Optional model rewrite of the rule-composed summary. Off unless ANTHROPIC_API_KEY is set AND LEAD_SUMMARY_AI=1 (the text leaves the server, so it is a deliberate
 * choice). The lead's name is replaced with "the lead" before sending, and the reply is rejected (the rule text is shown instead) if it is long, or contains a number
 * that is not in the facts it was given, so the model can smooth the wording but cannot add facts.
 */
export async function polishSummary(paragraphs: string[], name: string, http: typeof fetch = (...a) => fetch(...a)): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || process.env.LEAD_SUMMARY_AI !== "1") return null;
  const facts = paragraphs.join(" ").split(name).join("the lead");
  try {
    const res = await http("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ model: process.env.ASSISTANT_MODEL ?? "claude-haiku-5-5", max_tokens: 220, temperature: 0, system: "Rewrite these CRM facts about a sales lead as a brief, plain summary of at most 70 words for a sales manager. Use only the facts given; do not add, infer or round any number, name or date. Reply with the summary only.", messages: [{ role: "user", content: facts }] }),
    });
    if (!res.ok) return null;
    const out = String(((await res.json()) as any)?.content?.[0]?.text ?? "").trim();
    if (!out || out.length > 700) return null;
    const nums = (t: string) => (t.replace(/,/g, "").match(/\d+(?:\.\d+)?/g) ?? []);
    const allowed = new Set(nums(facts));
    return nums(out).every((n) => allowed.has(n)) ? out.split("the lead").join(name) : null;
  } catch { return null; }
}

export async function summarizeLead(sq: Sequelize, ctx: RequestContext, leadId: string, now = new Date(), http?: typeof fetch): Promise<{ headline: string; paragraphs: string[]; facts: { label: string; value: string }[]; aiText?: string }> {
  const lead: any = await getLead(sq, ctx, leadId);
  const t = +now;
  const data = await withUow(sq, ctx, async (u) => {
    const q = async (sql: string) => (await u.sq.query(sql, { replacements: { t: ctx.tenantId, l: leadId }, transaction: u.tx, type: QueryTypes.SELECT })) as any[];
    const [contact] = await q("SELECT c.first_name, c.last_name, c.company_name, c.language, c.nationality FROM contacts c JOIN leads l ON l.contact_id=c.id AND l.tenant_id=c.tenant_id WHERE l.tenant_id=:t AND l.id=:l");
    const [stage] = await q("SELECT s.name, (SELECT MAX(e.created_at) FROM lead_stage_events e WHERE e.tenant_id=l.tenant_id AND e.lead_id=l.id) AS since FROM leads l JOIN pipeline_stages s ON s.id=l.stage_id AND s.tenant_id=l.tenant_id WHERE l.tenant_id=:t AND l.id=:l");
    const [src] = await q("SELECT s.name FROM leads l JOIN lead_sources s ON s.id=l.source_id AND s.tenant_id=l.tenant_id WHERE l.tenant_id=:t AND l.id=:l");
    const acts = await q("SELECT kind, COUNT(*) AS n, MAX(occurred_at) AS last FROM activities WHERE tenant_id=:t AND entity_type='lead' AND entity_id=:l AND kind <> 'system' GROUP BY kind");
    const [calls] = await q("SELECT COUNT(*) AS n, SUM(outcome='answered') AS answered, SUM(outcome IN ('no_answer','busy','voicemail')) AS unanswered, MAX(started_at) AS last FROM call_logs WHERE tenant_id=:t AND lead_id=:l");
    const [view] = await q("SELECT COUNT(*) AS n, SUM(status='completed') AS done, SUM(status IN ('scheduled','checked_in')) AS upcoming FROM viewings WHERE tenant_id=:t AND lead_id=:l AND deleted_at IS NULL");
    const [match] = hasPermission(ctx, "match.read") ? await q("SELECT COUNT(*) AS n, SUM(status='new') AS fresh FROM property_matches WHERE tenant_id=:t AND lead_id=:l") : [{ n: 0, fresh: 0 }];
    const [tasks] = await q("SELECT COUNT(*) AS n FROM tasks WHERE tenant_id=:t AND lead_id=:l AND status='open'");
    return { contact, stage, src, acts, calls, view, match, tasks };
  });
  const name = [data.contact?.first_name, data.contact?.last_name].filter(Boolean).join(" ") || data.contact?.company_name || "This lead";
  const age = t - +new Date(lead.createdAt);
  const want: string[] = [];
  if (lead.purpose) want.push(`to ${lead.purpose === "buy" ? "buy" : nice(lead.purpose)}`);
  if (lead.bedrooms != null) want.push(`${lead.bedrooms} bedroom${lead.bedrooms === 1 ? "" : "s"}`);
  const areas = Array.isArray(lead.preferredAreas) ? lead.preferredAreas.filter(Boolean) : [];
  if (areas.length) want.push(`in ${areas.slice(0, 3).join(", ")}`);
  const budget = lead.budgetMin || lead.budgetMax ? `${lead.currency ?? "AED"} ${money(lead.budgetMin) ?? "?"} to ${money(lead.budgetMax) ?? "?"}` : null;
  const paragraphs: string[] = [];
  paragraphs.push(`${name} came in ${ago(age)} ago${data.src?.name ? ` from ${data.src.name}` : ""}${lead.campaign ? ` (campaign ${lead.campaign})` : ""} and is ${lead.status === "open" ? `an open lead in the ${data.stage?.name ?? "current"} stage${data.stage?.since ? ` for ${ago(t - +new Date(data.stage.since))}` : ""}` : `${lead.status}${lead.lostReason ? ` (${lead.lostReason})` : ""}`}.${lead.isHot ? " Marked hot." : ""}`);
  if (want.length || budget || lead.financing || lead.purchaseTimeline) paragraphs.push(`Looking ${want.join(", ") || "for a property"}${budget ? `, budget ${budget}` : ""}${lead.financing ? `, financing: ${nice(lead.financing)}` : ""}${lead.purchaseTimeline ? `, wants to move ${nice(lead.purchaseTimeline)}` : ""}.`);
  const bits: string[] = [];
  const total = data.acts.reduce((a: number, x: any) => a + Number(x.n), 0), calls = Number(data.calls?.n ?? 0);
  if (calls) bits.push(`${calls} call${calls === 1 ? "" : "s"} (${Number(data.calls.answered ?? 0)} answered, ${Number(data.calls.unanswered ?? 0)} unanswered)`);
  for (const k of ["whatsapp", "email", "sms", "note"]) { const a = data.acts.find((x: any) => x.kind === k); if (a) bits.push(`${a.n} ${k === "note" ? "note" : k}${Number(a.n) === 1 ? "" : "s"}`); }
  const views = Number(data.view?.n ?? 0);
  if (views) bits.push(`${views} viewing${views === 1 ? "" : "s"} (${Number(data.view.done ?? 0)} done, ${Number(data.view.upcoming ?? 0)} upcoming)`);
  const last = lead.lastContactedAt ? +new Date(lead.lastContactedAt) : null;
  paragraphs.push(bits.length || total ? `So far: ${bits.join(", ")}. ${last ? `Last contact ${ago(t - last)} ago.` : "Nobody has recorded a contact."}` : "Nobody has contacted this lead yet.");
  const open: string[] = [];
  if (lead.nextFollowUpAt) { const f = +new Date(lead.nextFollowUpAt); open.push(f < t ? `follow-up overdue by ${ago(t - f)}` : `next follow-up in ${ago(f - t)}`); } else if (lead.status === "open") open.push("no follow-up scheduled");
  if (Number(data.tasks?.n ?? 0)) open.push(`${data.tasks.n} open task${Number(data.tasks.n) === 1 ? "" : "s"}`);
  if (Number(data.match?.fresh ?? 0)) open.push(`${data.match.fresh} new matching listing${Number(data.match.fresh) === 1 ? "" : "s"} not yet shared`);
  if (!lead.assignedUserId) open.push(lead.poolId ? "waiting in a lead pool" : "not assigned to anyone");
  if (open.length && lead.status === "open") paragraphs.push(`Outstanding: ${open.join("; ")}.`);
  const headline = `${name}: ${lead.status === "open" ? `${data.stage?.name ?? "open"}` : lead.status}${budget ? `, ${budget}` : ""}${lead.isHot ? ", hot" : ""}`;
  const facts = [{ label: "Language", value: data.contact?.language ?? "-" }, { label: "Nationality", value: data.contact?.nationality ?? "-" }, { label: "Matches", value: String(data.match?.n ?? 0) }, { label: "Activities", value: String(total + calls) }];
  const aiText = await polishSummary(paragraphs, name, http);
  return { headline, paragraphs, facts, ...(aiText ? { aiText } : {}) };
}

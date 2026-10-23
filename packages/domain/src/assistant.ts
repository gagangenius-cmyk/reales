import { Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { ForbiddenError, hasPermission } from "@reales/rbac";
import { isModuleOn } from "./config";
import { leadStatusSummary, searchLeadsAdvanced, searchListingsAdvanced } from "./filters";
import { liveBoard } from "./hr-attendance";
import { globalSearch } from "./search";

/**
 * A command assistant for the CRM: ask in plain words ("hot leads", "listings expiring this week", "who is on leave today", "find 0501234567") and it
 * answers from the data the person is allowed to see, with links. It matches the request to a fixed set of read-only tools, so it can never do more than the
 * normal screens and never invents an answer. It is deterministic by design; a language model can later be put in front to choose the tool, but would still
 * call the same tools under the same permissions.
 */
export interface AssistantItem { title: string; subtitle?: string; href: string }
export interface AssistantReply { answer: string; items: AssistantItem[]; link?: { label: string; href: string }; suggestions: string[] }

const SUGGEST = ["hot leads", "follow-ups overdue", "new leads today", "unassigned leads", "listings expiring this week", "listings without photos", "who is on leave today", "who is late today", "find Ahmed"];
const has = (q: string, ...words: string[]) => words.some((w) => q.includes(w));

async function tool<T>(run: () => Promise<T>): Promise<T | { denied: true }> {
  try { return await run(); } catch (e) { if (e instanceof ForbiddenError) return { denied: true }; throw e; }
}
const denied = (x: unknown): x is { denied: true } => !!x && typeof x === "object" && (x as { denied?: boolean }).denied === true;
const name = (l: any) => l.contactName ?? `${l.purpose} lead`;

const COMMANDS = ["hot leads", "follow-ups overdue", "new leads today", "unassigned leads", "leads never contacted", "my leads", "lead summary", "listings expiring this week", "listings without photos", "listings without permit", "draft listings", "published listings", "stale listings", "who is on leave today", "who is late today", "who is not in today", "attendance summary"];

/**
 * Optional language-model front end. When ANTHROPIC_API_KEY is set, a question the keyword rules did not understand ("which enquiries did nobody answer
 * yet?") is turned into ONE of the fixed commands above (or "find <name>"). The model only ever sees the question text, never CRM data, and cannot run
 * anything itself: the chosen command is executed by the same read-only tools under the asker's own permissions. Anything it returns that is not an
 * allowed command is thrown away.
 */
export async function interpretWithModel(message: string, http: typeof fetch = (...a) => fetch(...a)): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await http("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ model: process.env.ASSISTANT_MODEL ?? "claude-haiku-5-5", max_tokens: 40, temperature: 0, system: `You route questions for a real-estate CRM. Reply with exactly one line: either one of these commands verbatim (${COMMANDS.join(" | ")}), or "find <name, phone, unit or reference>" when the user is looking for a specific person, listing or unit, or UNKNOWN. No explanations.`, messages: [{ role: "user", content: message.slice(0, 200) }] }),
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const out = String(j?.content?.[0]?.text ?? "").trim().replace(/^["']|["']$/g, "");
    if (COMMANDS.includes(out.toLowerCase())) return out.toLowerCase();
    const f = /^find (.{2,60})$/i.exec(out);
    return f && out.split(/\s/).length < 12 ?`find ${f[1]!.trim()}` : null;
  } catch { return null; }
}

export async function askAssistant(sq: Sequelize, ctx: RequestContext, message: string): Promise<AssistantReply> {
  const first = await answer(sq, ctx, message);
  if (first.understood) return first.reply;
  const mapped = await interpretWithModel(message);
  if (mapped) { const second = await answer(sq, ctx, mapped); if (second.understood) return { ...second.reply, answer: second.reply.answer }; }
  return first.reply;
}

async function answer(sq: Sequelize, ctx: RequestContext, message: string): Promise<{ understood: boolean; reply: AssistantReply }> {
  const reply = await answerRaw(sq, ctx, message);
  return { understood: !reply.answer.startsWith("I can look things up"), reply };
}

async function answerRaw(sq: Sequelize, ctx: RequestContext, message: string): Promise<AssistantReply> {
  const q = message.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
  if (!q) return { answer: "Ask me something about your leads, listings or team, for example:", items: [], suggestions: SUGGEST };
  const noAccess = (what: string): AssistantReply => ({ answer: `You do not have access to ${what}.`, items: [], suggestions: SUGGEST });
  const leadsOn = await isModuleOn(sq, ctx.tenantId, "leads"), listingsOn = await isModuleOn(sq, ctx.tenantId, "listings"), hrOn = await isModuleOn(sq, ctx.tenantId, "hr");

  // ---- leads
  if (has(q, "lead") && !has(q, "find", "search", "who is")) {
    if (!leadsOn) return { answer: "Leads are switched off for your company.", items: [], suggestions: SUGGEST };
    const sum: any = await tool(() => leadStatusSummary(sq, ctx));
    if (denied(sum)) return noAccess("leads");
    const list = async (f: Parameters<typeof searchLeadsAdvanced>[2], label: string, href: string, count: number) => {
      const res: any = await tool(() => searchLeadsAdvanced(sq, ctx, { ...f, limit: 8 }));
      if (denied(res)) return noAccess("leads");
      return { answer: count === 0 ? `No ${label}.` : `${count} ${label}${count > 8 ? ", here are the first 8" : ""}.`, items: res.rows.map((l: any) => ({ title: `${l.purpose} lead${l.isHot ? " (hot)" : ""}`, subtitle: l.nextFollowUpAt ? `Follow-up ${new Date(l.nextFollowUpAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : `Received ${new Date(l.createdAt).toISOString().slice(0, 10)}`, href: `/leads/${l.id}` })), link: { label: "Open in Leads", href }, suggestions: SUGGEST } as AssistantReply;
    };
    if (has(q, "hot")) return list({ status: "open", hot: true, sort: "newest" }, "hot open leads", "/leads?hot=1&status=open", sum.hot);
    if (has(q, "overdue", "follow-up", "follow up", "followup")) return list({ status: "open", followUp: "overdue", sort: "followup" }, "leads with an overdue follow-up", "/leads?followUp=overdue&status=open&sort=followup", sum.overdue);
    if (has(q, "unassigned", "not assigned", "no agent")) return list({ status: "open", assigned: "unassigned" }, "unassigned open leads", "/leads?assigned=unassigned&status=open", sum.unassigned);
    if (has(q, "never contacted", "not contacted", "untouched")) return list({ status: "open", neverContacted: true }, "open leads nobody has contacted yet", "/leads?never=1&status=open", sum.neverContacted);
    if (has(q, "today", "new")) return list({ createdFrom: new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10), sort: "newest" }, "new leads today", "/leads?sort=newest", sum.today);
    if (has(q, "my ")) return list({ status: "open", assigned: "me" }, "open leads assigned to you", "/leads?assigned=me&status=open", sum.open);
    return { answer: `${sum.open} open leads: ${sum.stages.map((s: any) => `${s.name} ${s.count}`).join(", ")}. ${sum.won} won, ${sum.lost} lost. ${sum.hot} hot, ${sum.overdue} follow-ups overdue, ${sum.unassigned} unassigned.`, items: [], link: { label: "Open Leads overview", href: "/leads/overview" }, suggestions: SUGGEST };
  }

  // ---- listings
  if (has(q, "listing", "propert")) {
    if (!listingsOn) return { answer: "Listings are switched off for your company.", items: [], suggestions: SUGGEST };
    const f: Parameters<typeof searchListingsAdvanced>[2] = { limit: 8 };
    let label = "listings", href = "/listings";
    if (has(q, "expir")) { f.expiringInDays = 7; f.status = "published"; label = "published listings expiring within 7 days"; href = "/listings?expiring=7&status=published"; }
    else if (has(q, "photo", "image")) { f.noPhotos = true; label = "listings with no photos"; href = "/listings?noPhotos=1"; }
    else if (has(q, "permit")) { f.permit = "missing"; f.status = "published"; label = "published listings without a valid permit"; href = "/listings?permit=missing&status=published"; }
    else if (has(q, "draft")) { f.status = "draft"; label = "draft listings"; href = "/listings?status=draft"; }
    else if (has(q, "publish", "live")) { f.status = "published"; label = "published listings"; href = "/listings?status=published"; }
    else if (has(q, "stale", "not refreshed")) { f.staleDays = 30; f.status = "published"; label = "published listings not refreshed for 30 days"; href = "/listings?stale=30&status=published"; }
    const res: any = await tool(() => searchListingsAdvanced(sq, ctx, f));
    if (denied(res)) return noAccess("listings");
    return { answer: res.total === 0 ? `No ${label}.` : `${res.total} ${label}${res.total > 8 ? ", here are the first 8" : ""}.`, items: res.rows.map((l: any) => ({ title: `${l.reference ?? ""} ${l.title ?? "(untitled)"}`.trim(), subtitle: [l.unit?.building, l.unit?.community, l.price ? `${l.currency} ${Number(l.price).toLocaleString("en-US")}` : null].filter(Boolean).join(", "), href: `/listings/${l.id}` })), link: { label: "Open in Listings", href }, suggestions: SUGGEST };
  }

  // ---- HR: who is in, late, on leave
  if (has(q, "leave", "late", "absent", "not in", "who is in", "who's in", "attendance", "in the office", "working")) {
    if (!hrOn) return { answer: "Human resources is switched off for your company.", items: [], suggestions: SUGGEST };
    if (!hasPermission(ctx, "hr.read")) return noAccess("the team attendance board");
    const b: any = await tool(() => liveBoard(sq, ctx));
    if (denied(b)) return noAccess("the team attendance board");
    const pick = (pred: (p: any) => boolean, label: string): AssistantReply => { const rows = b.people.filter(pred); return { answer: rows.length === 0 ? `Nobody ${label}.` : `${rows.length} ${label}.`, items: rows.slice(0, 15).map((p: any) => ({ title: p.name, subtitle: [p.department, p.late ? `${p.late} min late` : null].filter(Boolean).join(", "), href: `/hr/employees/${p.id}` })), link: { label: "Open the live board", href: "/hr/attendance" }, suggestions: SUGGEST }; };
    if (has(q, "leave")) return pick((p) => p.state === "on_leave", "on leave today");
    if (has(q, "late")) return pick((p) => p.late > 0, "late today");
    if (has(q, "absent", "not in")) return pick((p) => p.state === "not_in", "not in yet today");
    return { answer: `${b.totals.working} working, ${b.totals.onBreak} on a break, ${b.totals.done} checked out, ${b.totals.onLeave} on leave, ${b.totals.notIn} not in yet, ${b.totals.late} late.`, items: [], link: { label: "Open the live board", href: "/hr/attendance" }, suggestions: SUGGEST };
  }

  // ---- find anything
  const term = q.replace(/^(please )?(find|search( for)?|look up|show me|open|who is|where is)\s+/, "").replace(/^(lead|contact|listing|unit|deal)\s+/, "");
  if (term.length >= 2 && (has(q, "find", "search", "look up", "show", "who is", "where", "open") || /^[\d+\s()-]{6,}$/.test(q) || q.split(" ").length <= 3)) {
    const hits = await globalSearch(sq, ctx, term, 4);
    return { answer: hits.length === 0 ? `Nothing found for "${term}".` : `${hits.length} result${hits.length === 1 ? "" : "s"} for "${term}".`, items: hits.map((h) => ({ title: h.title, subtitle: `${h.kind}: ${h.subtitle}`, href: h.href })), suggestions: SUGGEST };
  }
  return { answer: "I can look things up and count things, but I did not understand that. Try one of these:", items: [], suggestions: SUGGEST };
}

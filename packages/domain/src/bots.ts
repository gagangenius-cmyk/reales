import { randomUUID } from "node:crypto";
import { Op, Sequelize } from "sequelize";
import { mysqlDate, RequestContext, systemContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { z } from "@reales/validation";
import { meterUsageInUow, remainingQuota } from "./hardening";
import { sendMessage } from "./messaging";
import { normalizePhone, normalizeEmail } from "./normalize";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

// ---------------------------------------------------------------- graph
export interface BotNode { id: string; type: string; config?: Record<string, unknown>; position?: { x: number; y: number } }
export interface BotEdge { id?: string; source: string; target: string; sourceHandle?: string | null }
export interface BotGraph { nodes: BotNode[]; edges: BotEdge[] }

/** AI tools are an allow-list implemented by the runtime. The model never receives database access, credentials or arbitrary functions. */
export const AI_TOOLS = ["search_listings"] as const;
const VALIDATORS = ["text", "number", "phone", "email", "choice"] as const;

const NODE_SPECS: Record<string, { schema: z.ZodTypeAny; handles?: (c: any) => string[] }> = {
  "bot.start": { schema: z.object({}).strict() },
  "bot.message": { schema: z.object({ text: z.string().min(1).max(1000) }).strict() },
  "bot.ask": {
    schema: z.object({ variable: z.string().regex(/^[a-z_][a-z0-9_]{0,30}$/), prompt: z.string().min(1).max(500), validate: z.enum(VALIDATORS), choices: z.array(z.string().min(1).max(60)).max(10).optional() }).strict()
      .refine((c) => c.validate !== "choice" || (c.choices && c.choices.length >= 2), { message: "choice questions need at least two choices" }),
  },
  "bot.branch": {
    schema: z.object({ variable: z.string().regex(/^[a-z_][a-z0-9_]{0,30}$/), cases: z.array(z.object({ handle: z.string().regex(/^[a-z0-9_]{1,30}$/), equals: z.string().max(100).optional(), contains: z.string().max(100).optional() }).strict().refine((c) => !!c.equals !== !!c.contains, "use equals or contains")).min(1).max(8) }).strict(),
    handles: (c) => [...c.cases.map((x: any) => x.handle), "default"],
  },
  "bot.ai_answer": {
    schema: z.object({ instruction: z.string().min(1).max(1000), tools: z.array(z.enum(AI_TOOLS)).max(2).default([]), maxTokens: z.number().int().min(50).max(1000) }).strict(),
    handles: () => ["answered", "failed"],
  },
  "bot.handoff": { schema: z.object({ reason: z.string().min(1).max(255) }).strict() },
  "bot.end": { schema: z.object({ text: z.string().max(500).optional() }).strict() },
};
const TERMINAL = new Set(["bot.handoff", "bot.end"]);
const MAX_NODES = 60;
export const MAX_STEPS_PER_TURN = 40;
export const MAX_TURNS = 100;

export interface BotIssue { code: string; nodeId?: string; message: string }

/** Static analysis before publish: structure, per-node config, reachability, handle wiring, and no loop that can spin without waiting for the user. */
export function validateBotGraph(graph: unknown): BotIssue[] {
  const issues: BotIssue[] = [];
  const g = z.object({ nodes: z.array(z.object({ id: z.string().min(1).max(80), type: z.string(), config: z.record(z.unknown()).optional() }).passthrough()).max(MAX_NODES), edges: z.array(z.object({ source: z.string(), target: z.string(), sourceHandle: z.string().nullable().optional() }).passthrough()).max(200) }).safeParse(graph);
  if (!g.success) return [{ code: "shape", message: "Graph shape is invalid (or has more than 60 nodes)" }];
  const { nodes, edges } = g.data;
  const byId = new Map<string, (typeof nodes)[number]>();
  for (const n of nodes) {
    if (byId.has(n.id)) issues.push({ code: "duplicate_id", nodeId: n.id, message: "Duplicate node id" });
    byId.set(n.id, n);
  }
  const starts = nodes.filter((n) => n.type === "bot.start");
  if (starts.length !== 1) issues.push({ code: "start", message: "Exactly one bot.start node is required" });
  const out = new Map<string, typeof edges>();
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) { issues.push({ code: "dangling_edge", message: `Edge ${e.source} -> ${e.target} points to a missing node` }); continue; }
    out.set(e.source, [...(out.get(e.source) ?? []), e]);
  }
  for (const n of nodes) {
    const spec = NODE_SPECS[n.type];
    if (!spec) { issues.push({ code: "unknown_node", nodeId: n.id, message: `Unknown node type ${n.type}` }); continue; }
    const parsed = spec.schema.safeParse(n.config ?? {});
    if (!parsed.success) { issues.push({ code: "bad_config", nodeId: n.id, message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }); continue; }
    const edgesOut = out.get(n.id) ?? [];
    if (TERMINAL.has(n.type)) { if (edgesOut.length) issues.push({ code: "terminal_has_edges", nodeId: n.id, message: "Terminal nodes cannot have outgoing edges" }); continue; }
    const handles = spec.handles ? spec.handles(parsed.data) : [];
    if (handles.length) {
      for (const h of handles) if (!edgesOut.some((e) => e.sourceHandle === h)) issues.push({ code: "unwired_handle", nodeId: n.id, message: `Handle "${h}" has no outgoing edge` });
      for (const e of edgesOut) if (!handles.includes(e.sourceHandle ?? "")) issues.push({ code: "unknown_handle", nodeId: n.id, message: `Edge uses unknown handle "${e.sourceHandle ?? ""}"` });
    } else if (edgesOut.length !== 1) issues.push({ code: "needs_one_edge", nodeId: n.id, message: "This node needs exactly one outgoing edge" });
  }
  if (starts.length === 1) {
    const seen = new Set<string>();
    const stack = [starts[0]!.id];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      for (const e of out.get(c) ?? []) stack.push(e.target);
    }
    for (const n of nodes) if (!seen.has(n.id)) issues.push({ code: "unreachable", nodeId: n.id, message: "Node cannot be reached from the start" });
    if (![...seen].some((id) => TERMINAL.has(byId.get(id)!.type))) issues.push({ code: "no_end", message: "The bot needs a reachable end or handoff" });
  }
  // A cycle is only safe if it passes through an ask node (the bot then waits for the customer instead of spinning).
  const color = new Map<string, number>();
  const dfs = (id: string, sawAsk: boolean): boolean => {
    if (color.get(id) === 1) return !sawAsk;
    if (color.get(id) === 2) return false;
    color.set(id, 1);
    const ask = sawAsk || byId.get(id)?.type === "bot.ask";
    for (const e of out.get(id) ?? []) if (dfs(e.target, ask)) return true;
    color.set(id, 2);
    return false;
  };
  if (starts.length === 1 && dfs(starts[0]!.id, false)) issues.push({ code: "cycle", message: "A loop must pass through a question (bot.ask)" });
  return issues;
}

export class BotInvalidError extends Error {
  status = 422;
  constructor(public issues: BotIssue[]) { super("The bot has validation issues"); this.name = "BotInvalidError"; }
}

// ---------------------------------------------------------------- AI adapter
export interface AiRequest { instruction: string; userText: string; context: Record<string, string>; toolResults: Record<string, unknown>; maxTokens: number }
export interface AiResponse { text: string; tokensUsed: number }
export interface AiProvider { code: string; complete(r: AiRequest): Promise<AiResponse> }

/** Deterministic mock: echoes a templated answer in the required JSON shape (so schema validation is exercised). Not a language model. */
export const mockAi: AiProvider = {
  code: "mock",
  async complete(r) {
    if (/\bfail\b/i.test(r.userText)) return { text: "not json", tokensUsed: 20 };
    if (/\bexpensive\b/i.test(r.userText)) return { text: JSON.stringify({ answer: "x".repeat(40) }), tokensUsed: 5000 };
    const listings = (r.toolResults.search_listings as Array<{ title: string }> | undefined) ?? [];
    return { text: JSON.stringify({ answer: listings.length ? `I found: ${listings.map((l) => l.title).join("; ")}` : "Let me connect you with an agent for details." }), tokensUsed: 60 + r.userText.length };
  },
};
let aiProvider: AiProvider = mockAi;
export const setAiProvider = (p: AiProvider | null) => { aiProvider = p ?? mockAi; };
const AI_OUTPUT = z.object({ answer: z.string().min(1).max(1000) }).strict();

// ---------------------------------------------------------------- bot CRUD
export async function createBot(sq: Sequelize, ctx: RequestContext, i: { name: string; channel: "whatsapp" | "sms" | "email"; graph?: BotGraph }) {
  authorize(ctx, "bot.manage");
  return withUow(sq, ctx, async (u) => {
    if (await u.repo("Bot").findOne({ where: { name: i.name }, transaction: u.tx })) throw new ConflictError("A bot with this name exists");
    const b = await u.repo("Bot").create({ id: randomUUID(), name: i.name, channel: i.channel, status: "draft", currentVersion: 0, draftGraph: i.graph ?? { nodes: [{ id: "start", type: "bot.start", config: {} }], edges: [] } }, { transaction: u.tx });
    await u.audit({ action: "bot.created", entityType: "bot", entityId: (b as any).get("id"), after: { name: i.name } });
    return plain(b);
  });
}
export async function listBots(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "bot.read");
  return withUow(sq, ctx, async (u) => (await u.repo("Bot").findAll({ order: [["name", "ASC"]], transaction: u.tx })).map(plain));
}
export async function getBot(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "bot.read");
  return withUow(sq, ctx, async (u) => {
    const b = await u.repo("Bot").findById(id, { transaction: u.tx });
    if (!b) throw new NotFoundError("Bot");
    return plain(b);
  });
}
export async function saveBotDraft(sq: Sequelize, ctx: RequestContext, id: string, graph: BotGraph) {
  authorize(ctx, "bot.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Bot").findById(id, { transaction: u.tx }))) throw new NotFoundError("Bot");
    await u.repo("Bot").updateById(id, { draftGraph: graph }, { transaction: u.tx });
    return { id, issues: validateBotGraph(graph) };
  });
}
export async function publishBot(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "bot.manage");
  return withUow(sq, ctx, async (u) => {
    const b: any = await u.repo("Bot").findById(id, { transaction: u.tx });
    if (!b) throw new NotFoundError("Bot");
    const issues = validateBotGraph(b.get("draftGraph"));
    if (issues.length) throw new BotInvalidError(issues);
    const version = Number(b.get("currentVersion")) + 1;
    await u.repo("BotVersion").create({ id: randomUUID(), botId: id, version, graph: b.get("draftGraph"), createdBy: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    await u.repo("Bot").updateById(id, { status: "published", currentVersion: version }, { transaction: u.tx });
    await u.audit({ action: "bot.published", entityType: "bot", entityId: id, after: { version } });
    return plain(await u.repo("Bot").findById(id, { transaction: u.tx }));
  });
}
export async function setBotStatus(sq: Sequelize, ctx: RequestContext, id: string, status: "published" | "disabled") {
  authorize(ctx, "bot.manage");
  return withUow(sq, ctx, async (u) => {
    const b: any = await u.repo("Bot").findById(id, { transaction: u.tx });
    if (!b) throw new NotFoundError("Bot");
    if (status === "published" && !b.get("currentVersion")) throw new ConflictError("Publish the bot first");
    await u.repo("Bot").updateById(id, { status }, { transaction: u.tx });
    return plain(await u.repo("Bot").findById(id, { transaction: u.tx }));
  });
}

// ---------------------------------------------------------------- runtime
export interface BotTurn { sessionId: string; status: "active" | "handed_off" | "completed"; replies: string[]; handoffReason?: string }

const sub = (t: string, vars: Record<string, string>) => t.replace(/\{\{([a-z_][a-z0-9_]{0,30})\}\}/g, (_m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k]! : ""));
const HANDOFF_WORDS = /\b(human|agent|person|representative|operator)\b/i;

async function log(u: Uow, sessionId: string, direction: "user" | "bot" | "system", nodeId: string | null, text: string | null, detail?: unknown) {
  await u.repo("BotSessionEvent").create({ id: randomUUID(), sessionId, direction, nodeId, text, detail: detail ?? null, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
}

function validateAnswer(kind: string, raw: string, choices?: string[]): { ok: true; value: string } | { ok: false } {
  const t = raw.trim();
  if (!t) return { ok: false };
  if (kind === "number") { const n = Number(t.replace(/[, ]/g, "")); return Number.isFinite(n) && n >= 0 ? { ok: true, value: String(n) } : { ok: false }; }
  if (kind === "phone") { const p = normalizePhone(t); return p ? { ok: true, value: p } : { ok: false }; }
  if (kind === "email") { const e = normalizeEmail(t); return e ? { ok: true, value: e } : { ok: false }; }
  if (kind === "choice") { const hit = choices?.find((c) => c.toLowerCase() === t.toLowerCase()); return hit ? { ok: true, value: hit } : { ok: false }; }
  return { ok: true, value: t.slice(0, 500) };
}

async function aiTools(u: Uow, tools: string[], vars: Record<string, string>) {
  const out: Record<string, unknown> = {};
  if (tools.includes("search_listings")) {
    // Read-only, tenant-scoped, published listings only, bounded; no free-form query reaches the database.
    const max = Number(vars.budget);
    const rows = (await u.repo("Listing").findAll({ where: { status: "published", ...(Number.isFinite(max) && max > 0 ? { price: { [Op.lte]: max } } : {}) }, order: [["publishedAt", "DESC"]], limit: 3, transaction: u.tx })) as any[];
    out.search_listings = rows.map((l) => ({ title: l.get("title"), price: l.get("price"), currency: l.get("currency") }));
  }
  return out;
}

/** Advance from `nodeId` until the bot must wait for the customer, hands off, or ends. Mutates `s` (vars, node, status) and appends replies. */
async function run(u: Uow, s: any, graph: BotGraph, nodeId: string, userText: string, replies: string[]): Promise<void> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const next = (from: string, handle?: string) => graph.edges.find((e) => e.source === from && (handle === undefined ? true : (e.sourceHandle ?? "") === handle))?.target;
  const vars: Record<string, string> = { ...(s.get("vars") ?? {}) };
  let cur: string | undefined = nodeId;
  let steps = 0;
  const finish = async (status: "active" | "handed_off" | "completed", node: string | null, reason?: string) => {
    s.set("vars", vars); s.set("currentNode", node); s.set("status", status); if (reason) s.set("handoffReason", reason);
  };
  while (cur) {
    if (++steps > MAX_STEPS_PER_TURN) { await finish("handed_off", null, "step limit reached"); await log(u, s.get("id"), "system", cur, "step limit"); return; }
    const node = byId.get(cur)!;
    const c = (node.config ?? {}) as any;
    s.set("stepCount", Number(s.get("stepCount")) + 1);
    switch (node.type) {
      case "bot.start": cur = next(cur); break;
      case "bot.message": { const t = sub(c.text, vars); replies.push(t); await log(u, s.get("id"), "bot", cur, t); cur = next(cur); break; }
      case "bot.ask": {
        const t = sub(c.prompt, vars) + (c.validate === "choice" ? ` (${c.choices.join(" / ")})` : "");
        replies.push(t); await log(u, s.get("id"), "bot", cur, t);
        await finish("active", cur); return; // wait for the customer
      }
      case "bot.branch": {
        const v = (vars[c.variable] ?? "").toLowerCase();
        const hit = c.cases.find((k: any) => (k.equals !== undefined ? v === String(k.equals).toLowerCase() : v.includes(String(k.contains).toLowerCase())));
        cur = next(cur, hit ? hit.handle : "default"); break;
      }
      case "bot.ai_answer": {
        const cap = Number(process.env.BOT_AI_TOKEN_CAP ?? 3000);
        const used = Number(s.get("aiTokensUsed"));
        const fail = async (why: string) => { await log(u, s.get("id"), "system", cur!, `AI step failed: ${why}`); cur = next(cur!, "failed"); };
        if (used >= cap) { await fail("session AI budget exhausted"); break; }
        const left = await remainingQuota(u.sq, u.tenantId, "ai_tokens");
        if (left !== null && left < c.maxTokens) { await fail("monthly AI token quota reached"); break; }
        let res: AiResponse;
        try {
          res = await aiProvider.complete({ instruction: c.instruction, userText, context: vars, toolResults: await aiTools(u, c.tools ?? [], vars), maxTokens: c.maxTokens });
        } catch (e) { await fail((e as Error).message); break; }
        s.set("aiTokensUsed", used + res.tokensUsed);
        await meterUsageInUow(u, "ai_tokens", res.tokensUsed);
        if (res.tokensUsed > c.maxTokens) { await fail("token limit per answer exceeded"); break; }
        let parsed: z.infer<typeof AI_OUTPUT>;
        try { parsed = AI_OUTPUT.parse(JSON.parse(res.text)); } catch { await fail("output did not match the required schema"); break; }
        replies.push(parsed.answer); await log(u, s.get("id"), "bot", cur, parsed.answer, { ai: true, tokens: res.tokensUsed });
        cur = next(cur, "answered"); break;
      }
      case "bot.handoff": { const r = sub(c.reason, vars); await log(u, s.get("id"), "system", cur, `Handoff: ${r}`); await finish("handed_off", null, r); return; }
      case "bot.end": { if (c.text) { const t = sub(c.text, vars); replies.push(t); await log(u, s.get("id"), "bot", cur, t); } await finish("completed", null); return; }
      default: await finish("handed_off", null, "unsupported node"); return;
    }
  }
  await finish("handed_off", null, "flow ended without a terminal node");
}

async function afterHandoff(u: Uow, s: any) {
  if (s.get("status") !== "handed_off") return;
  const lead: any = s.get("leadId") ? await u.repo("Lead").findById(s.get("leadId"), { transaction: u.tx }) : null;
  const contact: any = await u.repo("Contact").findById(s.get("contactId"), { transaction: u.tx });
  const assignee = lead?.get("assignedUserId") ?? contact?.get("ownerUserId") ?? null;
  await u.repo("Task").create({ id: randomUUID(), title: `Bot handoff: ${s.get("handoffReason")}`, leadId: lead?.get("id") ?? null, assigneeId: assignee, dueAt: new Date(Date.now() + 3_600_000), status: "open" }, { transaction: u.tx });
  if (s.get("conversationId") && assignee) await u.repo("Conversation").updateById(s.get("conversationId"), { assignedUserId: assignee }, { transaction: u.tx });
  await u.emit({ type: "bot.handoff", aggregateType: "bot_session", aggregateId: s.get("id"), payload: { reason: s.get("handoffReason"), contactId: s.get("contactId") } });
}

async function turnOf(u: Uow, s: any, replies: string[]): Promise<BotTurn> {
  await u.repo("BotSession").updateById(s.get("id"), { vars: s.get("vars"), currentNode: s.get("currentNode"), status: s.get("status"), aiTokensUsed: s.get("aiTokensUsed"), stepCount: s.get("stepCount"), handoffReason: s.get("handoffReason") ?? null }, { transaction: u.tx });
  await afterHandoff(u, s);
  return { sessionId: s.get("id"), status: s.get("status"), replies, ...(s.get("handoffReason") ? { handoffReason: s.get("handoffReason") } : {}) };
}

async function loadGraph(u: Uow, botId: string, version: number): Promise<BotGraph> {
  const v: any = await u.repo("BotVersion").findOne({ where: { botId, version }, transaction: u.tx });
  if (!v) throw new NotFoundError("Bot version");
  return v.get("graph");
}

export async function startBotSession(sq: Sequelize, ctx: RequestContext, i: { botId: string; contactId: string; conversationId?: string; leadId?: string }): Promise<BotTurn> {
  return withUow(sq, ctx, async (u) => {
    const bot: any = await u.repo("Bot").findById(i.botId, { transaction: u.tx });
    if (!bot) throw new NotFoundError("Bot");
    if (bot.get("status") !== "published") throw new ConflictError("The bot is not published");
    if (!(await u.repo("Contact").findById(i.contactId, { transaction: u.tx }))) throw new NotFoundError("Contact");
    if (await u.repo("BotSession").findOne({ where: { contactId: i.contactId, status: "active" }, transaction: u.tx })) throw new ConflictError("This contact already has an active bot session");
    const version = Number(bot.get("currentVersion"));
    const graph = await loadGraph(u, i.botId, version);
    const id = randomUUID();
    const s: any = await u.repo("BotSession").create({ id, botId: i.botId, botVersion: version, contactId: i.contactId, conversationId: i.conversationId ?? null, leadId: i.leadId ?? null, status: "active", vars: {}, aiTokensUsed: 0, stepCount: 0 }, { transaction: u.tx });
    const replies: string[] = [];
    await run(u, s, graph, graph.nodes.find((n) => n.type === "bot.start")!.id, "", replies);
    return turnOf(u, s, replies);
  });
}

/** One customer message in. Customers can always ask for a person: those words hand off immediately, regardless of the flow. */
export async function botReceive(sq: Sequelize, ctx: RequestContext, sessionId: string, text: string): Promise<BotTurn> {
  return withUow(sq, ctx, async (u) => {
    await u.sq.query("SELECT id FROM bot_sessions WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: sessionId, t: ctx.tenantId }, transaction: u.tx });
    const s: any = await u.repo("BotSession").findById(sessionId, { transaction: u.tx });
    if (!s) throw new NotFoundError("Bot session");
    if (s.get("status") !== "active") throw new ConflictError(`The session is ${s.get("status")}`);
    const clipped = String(text ?? "").slice(0, 1000);
    await log(u, sessionId, "user", s.get("currentNode"), clipped);
    const replies: string[] = [];
    if (HANDOFF_WORDS.test(clipped) || Number(s.get("stepCount")) > MAX_TURNS * MAX_STEPS_PER_TURN) {
      s.set("status", "handed_off"); s.set("handoffReason", "Customer asked for a person"); s.set("currentNode", null);
      replies.push("Connecting you with a member of our team."); await log(u, sessionId, "bot", null, replies[0]!);
      return turnOf(u, s, replies);
    }
    const graph = await loadGraph(u, s.get("botId"), Number(s.get("botVersion")));
    const node = graph.nodes.find((n) => n.id === s.get("currentNode"));
    if (!node || node.type !== "bot.ask") throw new ConflictError("The bot is not waiting for an answer");
    const c = node.config as any;
    const v = validateAnswer(c.validate, clipped, c.choices);
    if (!v.ok) {
      const again = `Sorry, I did not understand that. ${c.prompt}`;
      replies.push(again); await log(u, sessionId, "bot", node.id, again);
      return turnOf(u, s, replies);
    }
    const vars = { ...(s.get("vars") ?? {}), [c.variable]: v.value };
    s.set("vars", vars);
    const nextId = graph.edges.find((e) => e.source === node.id)?.target;
    await run(u, s, graph, nextId!, clipped, replies);
    return turnOf(u, s, replies);
  });
}

export async function getBotSession(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "bot.read");
  return withUow(sq, ctx, async (u) => {
    const s = await u.repo("BotSession").findById(id, { transaction: u.tx });
    if (!s) throw new NotFoundError("Bot session");
    const events = await u.repo("BotSessionEvent").findAll({ where: { sessionId: id }, order: [["createdAt", "ASC"]], transaction: u.tx });
    return { ...plain(s), events: events.map(plain) };
  });
}

/** Optional delivery adapter: sends bot replies through the single outbound path (consent, suppression, WhatsApp window all apply). */
export async function deliverBotReplies(sq: Sequelize, tenantId: string, i: { contactId: string; channel: "whatsapp" | "sms" | "email"; replies: string[]; sessionId: string }) {
  const ctx = systemContext(tenantId, `corr_${randomUUID()}`);
  const out = [];
  for (const [idx, body] of i.replies.entries()) out.push(await sendMessage(sq, ctx, { contactId: i.contactId, channel: i.channel, purposeCode: "service", body, idempotencyKey: `bot:${i.sessionId}:${randomUUID()}:${idx}` }));
  return out;
}

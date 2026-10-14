import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  activateScoringModel, auc, BotInvalidError, botReceive, createBot, createContact, createLead, createRoutingRule, DEFAULT_RULES, evaluateModel, exportForWarehouse, FEATURES,
  getBotSession, getDashboard, getLeadScore, listScoringModels, publishBot, rescoreOpenLeads, saveBotDraft, scoreLead, setBotStatus, setAiProvider, startBotSession,
  trainLogistic, trainScoringModel, upsertKycProfile, validateBotGraph, type BotGraph, type FeatureVector,
} from "@reales/domain";
import { systemContext } from "@reales/database";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, contextFor, makeTenant, makeUser, testDb, uniq } from "./helpers";
import { agentIn, makeOrg } from "./brokerage-helpers";
import { phone } from "./deal-helpers";

afterAll(async () => { setAiProvider(null); await closeTestDb(); });
const sq = () => testDb();
const vec = (o: Partial<FeatureVector> = {}): FeatureVector => ({ ...Object.fromEntries(FEATURES.map((k) => [k, 0])), ...o }) as FeatureVector;

describe("scoring model maths", () => {
  it("is deterministic, explains itself with ranked reasons, and excludes protected attributes", () => {
    const a = evaluateModel(DEFAULT_RULES, vec({ has_phone: 1, budget_set: 1, replied: 1, viewing_booked: 1 }));
    const b = evaluateModel(DEFAULT_RULES, vec({ has_phone: 1, budget_set: 1, replied: 1, viewing_booked: 1 }));
    expect(a).toEqual(b);
    expect(a.score).toBe(15 + 8 + 12 + 15 + 20);
    expect(a.band).toBe("hot"); // 70 is the hot threshold (inclusive)
    expect(evaluateModel(DEFAULT_RULES, vec({ has_phone: 1, budget_set: 1, replied: 1 })).band).toBe("warm");
    expect(a.reasons[0]).toMatchObject({ code: "viewing_booked", points: 20 });
    expect(evaluateModel(DEFAULT_RULES, vec()).band).toBe("cold");
    expect(evaluateModel(DEFAULT_RULES, vec(Object.fromEntries(FEATURES.map((k) => [k, 1])))).band).toBe("hot");
    for (const banned of ["nationality", "language", "gender", "name", "religion"]) expect(FEATURES.join(" ")).not.toContain(banned);
  });

  it("learns a separable pattern and measures held-out quality with AUC", () => {
    const samples = Array.from({ length: 200 }, (_, i) => {
      const win = i % 2 === 0;
      return { y: (win ? 1 : 0) as 0 | 1, x: vec({ replied: win ? 1 : (i % 10 === 1 ? 1 : 0), viewing_booked: win ? (i % 4 === 0 ? 1 : 0) : 0, budget_set: 1 }) };
    });
    const fit = trainLogistic(samples);
    expect(fit.weights.replied).toBeGreaterThan(0);
    const scores = samples.map((s) => evaluateModel({ kind: "logistic", ...fit, hot: 70, warm: 40 }, s.x).score);
    expect(auc(scores, samples.map((s) => s.y))!).toBeGreaterThan(0.8);
    expect(auc([1, 2], [1, 1])).toBeNull();
  });
});

async function salesKit() {
  const t = await makeTenant();
  const org = await makeOrg(t);
  const agent = await agentIn(t, org.marina.id, org.bu.id);
  const other = await agentIn(t, org.marina.id, org.bu.id);
  const mgr = await agentIn(t, org.marina.id, org.bu.id, "branch_manager");
  await createRoutingRule(sq(), t.admin, { name: "all to agent", conditions: {}, target: { userIds: [agent.id] } });
  return { t, org, agent, other, mgr };
}
const mkLead = (ctx: any, extra: Record<string, unknown> = {}) => createLead(sq(), ctx, { contact: { firstName: uniq("L"), phone: phone() }, purpose: "buy", sourceCode: "website", ...extra } as any);

describe("lead scoring lifecycle", () => {
  it("scores with the default model, stores reasons and version, respects scope, and rescoring is idempotent", async () => {
    const k = await salesKit();
    const rich = await mkLead(k.agent.ctx, { budgetMax: 3_000_000, preferredAreas: ["Marina"], bedrooms: 2 });
    const poor = await mkLead(k.agent.ctx, { purpose: "rent" });
    const s1 = await scoreLead(sq(), k.agent.ctx, rich.lead.id);
    const s2 = await scoreLead(sq(), k.agent.ctx, poor.lead.id);
    expect(s1.modelVersion).toBe(1);
    expect(s1.score).toBeGreaterThan(s2.score);
    expect(s1.reasons.length).toBeGreaterThan(0);
    const detail = await getLeadScore(sq(), k.agent.ctx, rich.lead.id);
    expect(detail.latest).toMatchObject({ score: s1.score, modelVersion: 1 });
    expect((await sq().query<any>("SELECT score FROM leads WHERE id=:id", { replacements: { id: rich.lead.id }, type: QueryTypes.SELECT }))[0].score).toEqual(expect.anything());
    expect(Number((await sq().query<any>("SELECT score FROM leads WHERE id=:id", { replacements: { id: rich.lead.id }, type: QueryTypes.SELECT }))[0].score)).toBe(s1.score);
    await expect(scoreLead(sq(), k.other.ctx, rich.lead.id)).rejects.toThrow(/not found/i);
    const n1 = await rescoreOpenLeads(sq(), systemContext(k.t.tenantId, "corr_rescore_test"));
    expect(n1).toBe(0); // both were scored a moment ago by the current model
  });

  it("refuses to train without enough data, trains a draft from won/lost history, and activation is explicit and versioned", async () => {
    const k = await salesKit();
    await expect(trainScoringModel(sq(), k.t.admin)).rejects.toThrow(/At least 30 closed leads/);
    for (let i = 0; i < 36; i++) {
      const win = i % 2 === 0;
      const r = await mkLead(k.agent.ctx, win ? { budgetMax: 2_000_000 + i * 10_000, preferredAreas: ["Marina"], bedrooms: 2 } : {});
      await sq().query("UPDATE leads SET status=:s WHERE id=:id", { replacements: { s: win ? "won" : "lost", id: r.lead.id } });
    }
    const draft: any = await trainScoringModel(sq(), k.t.admin);
    expect(draft).toMatchObject({ kind: "logistic", status: "draft", version: 2, trainedOn: 36 });
    expect(draft.metrics.heldOutAuc === null || draft.metrics.heldOutAuc > 0.6).toBe(true);
    expect(draft.metrics.caveat).toMatch(/not causation/);
    await expect(activateScoringModel(sq(), k.agent.ctx, draft.id)).rejects.toBeInstanceOf(ForbiddenError);
    const live: any = await activateScoringModel(sq(), k.t.admin, draft.id, { acknowledgeWeak: true });
    expect(live.status).toBe("active");
    await expect(activateScoringModel(sq(), k.t.admin, draft.id)).rejects.toThrow(/cannot be activated/);
    const models: any[] = await listScoringModels(sq(), k.t.admin);
    expect(models.map((m) => [m.version, m.status])).toEqual([[2, "active"], [1, "retired"]]);

    const fresh = await mkLead(k.agent.ctx, { budgetMax: 2_500_000, preferredAreas: ["Marina"], bedrooms: 2 });
    expect((await scoreLead(sq(), k.agent.ctx, fresh.lead.id)).modelVersion).toBe(2);
    expect((await getLeadScore(sq(), k.agent.ctx, fresh.lead.id)).history[0].modelVersion).toBe(2);
  }, 180_000);
});

// ---------------------------------------------------------------- bots
const GRAPH: BotGraph = {
  nodes: [
    { id: "start", type: "bot.start", config: {} },
    { id: "hello", type: "bot.message", config: { text: "Hi, I am the Reales assistant." } },
    { id: "name", type: "bot.ask", config: { variable: "name", prompt: "What is your name?", validate: "text" } },
    { id: "budget", type: "bot.ask", config: { variable: "budget", prompt: "What is your budget in AED?", validate: "number" } },
    { id: "intent", type: "bot.ask", config: { variable: "intent", prompt: "Are you buying or renting?", validate: "choice", choices: ["buy", "rent"] } },
    { id: "route", type: "bot.branch", config: { variable: "intent", cases: [{ handle: "buy", equals: "buy" }] } },
    { id: "ai", type: "bot.ai_answer", config: { instruction: "Answer briefly using the listings tool.", tools: ["search_listings"], maxTokens: 300 } },
    { id: "bye", type: "bot.end", config: { text: "Thanks {{name}}, an agent will follow up." } },
    { id: "agent", type: "bot.handoff", config: { reason: "Customer wants to rent" } },
    { id: "aifail", type: "bot.handoff", config: { reason: "AI answer unavailable" } },
  ],
  edges: [
    { source: "start", target: "hello" }, { source: "hello", target: "name" }, { source: "name", target: "budget" }, { source: "budget", target: "intent" }, { source: "intent", target: "route" },
    { source: "route", target: "ai", sourceHandle: "buy" }, { source: "route", target: "agent", sourceHandle: "default" },
    { source: "ai", target: "bye", sourceHandle: "answered" }, { source: "ai", target: "aifail", sourceHandle: "failed" },
  ],
};

async function botKit() {
  const k = await salesKit();
  const bot: any = await createBot(sq(), k.t.admin, { name: uniq("Qualifier"), channel: "whatsapp", graph: GRAPH });
  await publishBot(sq(), k.t.admin, bot.id);
  const contact = await createContact(sq(), k.t.admin, { firstName: uniq("Cust"), phone: phone(), ownerUserId: k.agent.id } as any);
  return { ...k, bot, contact };
}

describe("bot graph validation", () => {
  it("accepts the reference flow and reports precise structural problems", () => {
    expect(validateBotGraph(GRAPH)).toEqual([]);
    expect(validateBotGraph({ nodes: [{ id: "a", type: "bot.message", config: { text: "x" } }], edges: [] }).map((i) => i.code)).toEqual(expect.arrayContaining(["start"]));
    const noWait: BotGraph = { nodes: [{ id: "s", type: "bot.start", config: {} }, { id: "m", type: "bot.message", config: { text: "loop" } }], edges: [{ source: "s", target: "m" }, { source: "m", target: "m" }] };
    expect(validateBotGraph(noWait).map((i) => i.code)).toEqual(expect.arrayContaining(["cycle", "no_end"]));
    const loopWithAsk: BotGraph = {
      nodes: [{ id: "s", type: "bot.start", config: {} }, { id: "q", type: "bot.ask", config: { variable: "x", prompt: "?", validate: "text" } }, { id: "b", type: "bot.branch", config: { variable: "x", cases: [{ handle: "stop", equals: "stop" }] } }, { id: "e", type: "bot.end", config: {} }],
      edges: [{ source: "s", target: "q" }, { source: "q", target: "b" }, { source: "b", target: "e", sourceHandle: "stop" }, { source: "b", target: "q", sourceHandle: "default" }],
    };
    expect(validateBotGraph(loopWithAsk)).toEqual([]);
    const bad = JSON.parse(JSON.stringify(GRAPH)) as BotGraph;
    bad.edges = bad.edges.filter((e) => !(e.source === "ai" && e.sourceHandle === "failed"));
    bad.nodes.find((n) => n.id === "ai")!.config = { instruction: "x", tools: ["drop_tables"], maxTokens: 300 };
    const codes = validateBotGraph(bad).map((i) => i.code);
    expect(codes).toContain("bad_config");
    expect(codes).toContain("unreachable");
  });

  it("will not publish an invalid bot", async () => {
    const k = await salesKit();
    const bot: any = await createBot(sq(), k.t.admin, { name: uniq("Broken"), channel: "sms" });
    await saveBotDraft(sq(), k.t.admin, bot.id, { nodes: [{ id: "start", type: "bot.start", config: {} }], edges: [] });
    await expect(publishBot(sq(), k.t.admin, bot.id)).rejects.toBeInstanceOf(BotInvalidError);
  });
});

describe("bot runtime", () => {
  it("runs a qualification flow: validates answers, substitutes variables, uses the AI node, and completes", async () => {
    const k = await botKit();
    const t1 = await startBotSession(sq(), k.t.admin, { botId: k.bot.id, contactId: k.contact.id });
    expect(t1.replies).toEqual(["Hi, I am the Reales assistant.", "What is your name?"]);
    await expect(startBotSession(sq(), k.t.admin, { botId: k.bot.id, contactId: k.contact.id })).rejects.toThrow(/already has an active/);
    const t2 = await botReceive(sq(), k.t.admin, t1.sessionId, "Sara");
    expect(t2.replies).toEqual(["What is your budget in AED?"]);
    const bad = await botReceive(sq(), k.t.admin, t1.sessionId, "lots of money");
    expect(bad.replies[0]).toMatch(/did not understand/);
    await botReceive(sq(), k.t.admin, t1.sessionId, "2,500,000");
    const wrong = await botReceive(sq(), k.t.admin, t1.sessionId, "maybe");
    expect(wrong.replies[0]).toMatch(/did not understand/);
    const done = await botReceive(sq(), k.t.admin, t1.sessionId, "BUY");
    expect(done.status).toBe("completed");
    expect(done.replies.at(-1)).toBe("Thanks Sara, an agent will follow up.");
    const s: any = await getBotSession(sq(), k.t.admin, t1.sessionId);
    expect(s.vars).toMatchObject({ name: "Sara", budget: "2500000", intent: "buy" });
    expect(s.aiTokensUsed).toBeGreaterThan(0);
    expect(s.events.some((e: any) => e.detail?.ai)).toBe(true);
    await expect(botReceive(sq(), k.t.admin, t1.sessionId, "hello")).rejects.toThrow(/session is completed/);
  });

  it("hands off to a person on request, with a task for the owner, regardless of where the flow is", async () => {
    const k = await botKit();
    const t = await startBotSession(sq(), k.t.admin, { botId: k.bot.id, contactId: k.contact.id });
    const h = await botReceive(sq(), k.t.admin, t.sessionId, "I want to speak to a human please");
    expect(h).toMatchObject({ status: "handed_off", handoffReason: "Customer asked for a person" });
    const tasks = await sq().query<any>("SELECT title, assignee_id FROM tasks WHERE tenant_id=:t AND title LIKE 'Bot handoff%'", { replacements: { t: k.t.tenantId }, type: QueryTypes.SELECT });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assignee_id).toBe(k.agent.id);
    const outbox = await sq().query<any>("SELECT type FROM outbox_events WHERE tenant_id=:t AND type='bot.handoff'", { replacements: { t: k.t.tenantId }, type: QueryTypes.SELECT });
    expect(outbox.length).toBeGreaterThan(0);
  });

  it("routes by branch, and contains AI failures: bad output and over-budget answers go to the failed path", async () => {
    const k = await botKit();
    const rent = await startBotSession(sq(), k.t.admin, { botId: k.bot.id, contactId: k.contact.id });
    for (const a of ["Omar", "100000"]) await botReceive(sq(), k.t.admin, rent.sessionId, a);
    expect(await botReceive(sq(), k.t.admin, rent.sessionId, "rent")).toMatchObject({ status: "handed_off", handoffReason: "Customer wants to rent" });

    // direct provider behaviour: schema violations and token overruns are rejected by the runtime
    setAiProvider({ code: "t", complete: async () => ({ text: "not json", tokensUsed: 10 }) });
    const c2 = await createContact(sq(), k.t.admin, { firstName: uniq("C"), phone: phone() });
    const s2 = await startBotSession(sq(), k.t.admin, { botId: k.bot.id, contactId: c2.id });
    for (const a of ["Ann", "1000"]) await botReceive(sq(), k.t.admin, s2.sessionId, a);
    expect(await botReceive(sq(), k.t.admin, s2.sessionId, "buy")).toMatchObject({ status: "handed_off", handoffReason: "AI answer unavailable" });
    setAiProvider({ code: "t", complete: async () => ({ text: JSON.stringify({ answer: "ok" }), tokensUsed: 9999 }) });
    const c3 = await createContact(sq(), k.t.admin, { firstName: uniq("C"), phone: phone() });
    const s3 = await startBotSession(sq(), k.t.admin, { botId: k.bot.id, contactId: c3.id });
    for (const a of ["Bo", "1000"]) await botReceive(sq(), k.t.admin, s3.sessionId, a);
    expect(await botReceive(sq(), k.t.admin, s3.sessionId, "buy")).toMatchObject({ status: "handed_off", handoffReason: "AI answer unavailable" });
    setAiProvider({ code: "t", complete: async () => ({ text: JSON.stringify({ answer: "ok", extra: "<script>" }), tokensUsed: 5 }) });
    const c4 = await createContact(sq(), k.t.admin, { firstName: uniq("C"), phone: phone() });
    const s4 = await startBotSession(sq(), k.t.admin, { botId: k.bot.id, contactId: c4.id });
    for (const a of ["Cy", "1000"]) await botReceive(sq(), k.t.admin, s4.sessionId, a);
    expect((await botReceive(sq(), k.t.admin, s4.sessionId, "buy")).status).toBe("handed_off"); // extra keys violate the strict output schema
    setAiProvider(null);
  }, 120_000);

  it("pins sessions to the published version, can be disabled, and is isolated per tenant", async () => {
    const k = await botKit();
    const t = await startBotSession(sq(), k.t.admin, { botId: k.bot.id, contactId: k.contact.id });
    const edited = JSON.parse(JSON.stringify(GRAPH)) as BotGraph;
    edited.nodes.find((n) => n.id === "hello")!.config = { text: "CHANGED" };
    await saveBotDraft(sq(), k.t.admin, k.bot.id, edited);
    await publishBot(sq(), k.t.admin, k.bot.id);
    expect((await getBotSession(sq(), k.t.admin, t.sessionId) as any).botVersion).toBe(1);
    const c = await createContact(sq(), k.t.admin, { firstName: uniq("C"), phone: phone() });
    expect((await startBotSession(sq(), k.t.admin, { botId: k.bot.id, contactId: c.id })).replies[0]).toBe("CHANGED");
    await setBotStatus(sq(), k.t.admin, k.bot.id, "disabled");
    const c2 = await createContact(sq(), k.t.admin, { firstName: uniq("C"), phone: phone() });
    await expect(startBotSession(sq(), k.t.admin, { botId: k.bot.id, contactId: c2.id })).rejects.toThrow(/not published/);
    const other = await makeTenant();
    await expect(startBotSession(sq(), other.admin, { botId: k.bot.id, contactId: c2.id })).rejects.toThrow(/not found/i);
    await expect(botReceive(sq(), other.admin, t.sessionId, "hi")).rejects.toThrow(/not found/i);
  });
});

describe("dashboards", () => {
  it("shows agents their own numbers and managers the branch, from the same scoped data", async () => {
    const k = await salesKit();
    await mkLead(k.agent.ctx);
    await mkLead(k.agent.ctx);
    const mine: any = await getDashboard(sq(), k.agent.ctx, "sales");
    expect(mine.leads.total).toBe(2);
    const theirs: any = await getDashboard(sq(), k.other.ctx, "sales");
    expect(theirs.leads.total).toBe(0);
    const branch: any = await getDashboard(sq(), k.mgr.ctx, "sales");
    expect(branch.leads.total).toBe(2);
    const board: any = await getDashboard(sq(), k.mgr.ctx, "manager");
    expect(board.agents.find((a: any) => a.agentId === k.agent.id)).toMatchObject({ open: 2 });
    await expect(getDashboard(sq(), k.agent.ctx, "compliance")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getDashboard(sq(), k.agent.ctx, "property")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("reports compliance and property figures to tenant-wide roles only", async () => {
    const t = await makeTenant();
    const officer = await makeUser(t, ["compliance_officer"]);
    const oc = await contextFor(t.tenantId, officer.id, { stepUp: true });
    const c = await createContact(sq(), t.admin, { firstName: "K", phone: phone() });
    await upsertKycProfile(sq(), oc, c.id, { idType: "passport", idNumber: "AB123456" });
    const d: any = await getDashboard(sq(), oc, "compliance");
    expect(d.kyc.byStatus).toEqual([{ name: "draft", count: 1 }]);
    await expect(getDashboard(sq(), oc, "property")).rejects.toBeInstanceOf(ForbiddenError); // officers hold no lease.read
    const pm = await makeUser(t, ["property_manager"]);
    const p: any = await getDashboard(sq(), pm.ctx, "property");
    expect(p.units).toEqual({ managed: 0, occupied: 0, occupancyRate: null });
  });
});

describe("warehouse export", () => {
  it("needs step-up and permission, pseudonymises person ids, leaves out contact details, and pages without gaps or repeats", async () => {
    const k = await salesKit();
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await mkLead(k.agent.ctx));
    const noStep = await contextFor(k.t.tenantId, k.t.adminId);
    await expect(exportForWarehouse(sq(), noStep, { entity: "leads" })).rejects.toThrow();
    await expect(exportForWarehouse(sq(), k.agent.ctx, { entity: "leads" })).rejects.toBeInstanceOf(ForbiddenError);
    const page1: any = await exportForWarehouse(sq(), k.t.admin, { entity: "leads", limit: 3 });
    expect(page1.rows).toHaveLength(3);
    expect(page1.hasMore).toBe(true);
    const page2: any = await exportForWarehouse(sq(), k.t.admin, { entity: "leads", limit: 3, after: page1.nextCursor });
    const ids = [...page1.rows, ...page2.rows].map((r: any) => r.id);
    expect(new Set(ids).size).toBe(5);
    expect(page2.rows).toHaveLength(2);
    const row = page1.rows[0];
    expect(Object.keys(row)).not.toEqual(expect.arrayContaining(["email", "phone_e164", "first_name"]));
    const realContactIds = made.map((m) => m.lead.contactId);
    expect(realContactIds).not.toContain(row.contact_id);
    const again: any = await exportForWarehouse(sq(), k.t.admin, { entity: "leads", limit: 3 });
    expect(again.rows[0].contact_id).toBe(row.contact_id); // stable pseudonym
    const other = await makeTenant();
    expect((await exportForWarehouse(sq(), other.admin, { entity: "leads" }) as any).rows).toHaveLength(0);
  });
});

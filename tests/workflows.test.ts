import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import {
  approveTemplate, changeLeadStage, createRoutingRule, createChannelAccount, createContact, createLead, createTemplate, createWorkflow, evaluateCondition, getLead, getRun, getWorkflow,
  handleDomainEvent, ingestLead, listRuns, mockMessaging, processDueWaits, publishWorkflow, recordConsent, saveDraft, setWorkflowStatus, validateGraph, validateWorkflow,
  WorkflowGraph, WorkflowInvalidError, DomainEventLike, NotFoundError,
} from "@reales/domain";
import { ForbiddenError } from "@reales/rbac";
import { closeTestDb, makeTenant, makeUser, testDb, uniq } from "./helpers";
import { phone } from "./deal-helpers";

afterAll(closeTestDb);
beforeEach(() => mockMessaging.reset());
const sq = () => testDb();

const trig = (type = "lead.created") => ({ id: "t", type: `trigger.${type}` });
const g = (nodes: any[], edges: any[]): WorkflowGraph => ({ nodes, edges });
const codes = (graph: unknown) => validateGraph(graph).issues.map((i) => i.code).sort();

describe("graph static analysis", () => {
  it("accepts a well-formed graph and reports its trigger", () => {
    const r = validateGraph(g([trig(), { id: "a", type: "crm.add_note", config: { text: "hi" } }], [{ source: "t", target: "a" }]));
    expect(r).toEqual({ issues: [], triggerType: "lead.created" });
  });

  it("finds structural problems", () => {
    expect(codes(null)).toEqual(["schema"]);
    expect(codes(g([], []))).toEqual(["empty"]);
    expect(codes(g([{ id: "a", type: "crm.add_note", config: { text: "x" } }], []))).toContain("trigger_count");
    expect(codes(g([trig(), { id: "t", type: "control.stop", config: {} }], []))).toContain("node_duplicate");
    expect(codes(g([trig(), { id: "x", type: "evil.exec", config: {} }], [{ source: "t", target: "x" }]))).toContain("node_type_unknown");
    expect(codes(g([trig(), { id: "n", type: "crm.add_note", config: { text: "" } }], [{ source: "t", target: "n" }]))).toContain("node_config");
    expect(codes(g([trig(), { id: "n", type: "crm.add_note", config: { text: "x", extra: 1 } }], [{ source: "t", target: "n" }]))).toContain("node_config"); // strict schemas
    expect(codes(g([trig()], [{ source: "t", target: "ghost" }]))).toContain("edge_dangling");
    expect(codes(g([trig(), { id: "o", type: "control.stop", config: {} }], []))).toContain("unreachable");
  });

  it("requires every branch, rejects cycles and arbitrary condition fields", () => {
    const cond = { id: "c", type: "condition", config: { field: "lead.budget_max", operator: "gte", value: 1 } };
    expect(codes(g([trig(), cond, { id: "s", type: "control.stop", config: {} }], [{ source: "t", target: "c" }, { source: "c", target: "s", sourceHandle: "true" }]))).toContain("branch_missing");
    expect(codes(g([trig(), { ...cond, config: { field: "lead.__proto__", operator: "eq", value: 1 } }], [{ source: "t", target: "c" }]))).toContain("node_config");
    const a = { id: "a", type: "crm.add_note", config: { text: "a" } };
    const b = { id: "b", type: "crm.add_note", config: { text: "b" } };
    expect(codes(g([trig(), a, b], [{ source: "t", target: "a" }, { source: "a", target: "b" }, { source: "b", target: "a" }]))).toContain("cycle");
    const w = { id: "w", type: "wait.event", config: { eventType: "lead.replied", timeoutMinutes: 60 } };
    expect(codes(g([trig(), w, { id: "s", type: "control.stop", config: {} }], [{ source: "t", target: "w" }, { source: "w", target: "s", sourceHandle: "resumed" }]))).toContain("branch_missing"); // timeout branch is mandatory
    expect(codes(g([trig(), a, b], [{ source: "t", target: "a" }, { source: "t", target: "b" }]))).toContain("branch_unlabelled");
  });

  it("evaluates conditions safely and treats missing data as false", () => {
    const data = { lead: { budget_max: 3_000_000, purpose: "buy" }, contact: { language: "ar" }, event: { type: "x", payload: { amount: 5 } } } as any;
    expect(evaluateCondition({ field: "lead.budget_max", operator: "gte", value: 3_000_000 }, data)).toBe(true);
    expect(evaluateCondition({ field: "lead.purpose", operator: "in", value: ["rent", "buy"] }, data)).toBe(true);
    expect(evaluateCondition({ field: "contact.language", operator: "eq", value: "en" }, data)).toBe(false);
    expect(evaluateCondition({ field: "lead.score", operator: "gt", value: 1 }, data)).toBe(false);
    expect(evaluateCondition({ field: "lead.score", operator: "exists" }, data)).toBe(false);
    expect(evaluateCondition({ field: "event.payload.amount", operator: "lt", value: 10 }, data)).toBe(true);
  });
});

async function setup() {
  const t = await makeTenant();
  const manager = await makeUser(t, ["branch_manager"]);
  await createChannelAccount(sq(), t.admin, { channel: "sms", provider: "mock", name: "sms", identity: "+971400000000" });
  const tpl = await createTemplate(sq(), manager.ctx, { name: uniq("welcome"), channel: "sms", purpose: "marketing", text: "Hi {{ contact.first_name }}, thanks for your enquiry" });
  await approveTemplate(sq(), t.admin, tpl.id, "approved");
  const draft = (extra: Partial<WorkflowGraph> = {}) => g(
    [trig("lead.created"), { id: "send", type: "communication.send", config: { channel: "sms", templateVersionId: tpl.currentVersionId, purposeCode: "marketing" } }, { id: "stage", type: "crm.change_stage", config: { stageKey: "contacted" } }],
    [{ source: "t", target: "send" }, { source: "send", target: "stage" }],
  );
  void draft;
  return { t, manager, tpl };
}

const eventFor = (t: { tenantId: string }, leadId: string, type = "lead.created", id = uniq("evt"), corr = "corr_x"): DomainEventLike => ({ id, type, tenantId: t.tenantId, aggregateType: "lead", aggregateId: leadId, correlationId: corr, payload: {} });

describe("publishing", () => {
  it("publishes immutable versions and enforces template, entitlement and permission checks", async () => {
    const { t, manager, tpl } = await setup();
    const wf = await createWorkflow(sq(), manager.ctx, { name: uniq("wf") });
    await expect(publishWorkflow(sq(), manager.ctx, wf.id)).rejects.toBeInstanceOf(WorkflowInvalidError);

    const bad = g([trig(), { id: "send", type: "communication.send", config: { channel: "sms", templateVersionId: "11111111-1111-4111-8111-111111111111", purposeCode: "marketing" } }], [{ source: "t", target: "send" }]);
    await saveDraft(sq(), manager.ctx, wf.id, bad);
    expect((await validateWorkflow(sq(), manager.ctx, wf.id)).issues.map((i) => i.code)).toContain("template_missing");

    const good = g([trig(), { id: "send", type: "communication.send", config: { channel: "sms", templateVersionId: tpl.currentVersionId, purposeCode: "marketing" } }], [{ source: "t", target: "send" }]);
    await saveDraft(sq(), manager.ctx, wf.id, good);
    const wrongChannel = g([trig(), { id: "send", type: "communication.send", config: { channel: "email", templateVersionId: tpl.currentVersionId, purposeCode: "marketing" } }], [{ source: "t", target: "send" }]);
    await saveDraft(sq(), manager.ctx, wf.id, wrongChannel);
    expect((await validateWorkflow(sq(), manager.ctx, wf.id)).issues.map((i) => i.code)).toContain("template_channel");
    await saveDraft(sq(), manager.ctx, wf.id, good);

    const published = await publishWorkflow(sq(), manager.ctx, wf.id);
    expect(published).toMatchObject({ status: "published", currentVersion: 1 });
    await saveDraft(sq(), manager.ctx, wf.id, g([trig(), { id: "n", type: "crm.add_note", config: { text: "v2" } }], [{ source: "t", target: "n" }]));
    expect((await publishWorkflow(sq(), manager.ctx, wf.id)).currentVersion).toBe(2);
    expect((await getWorkflow(sq(), manager.ctx, wf.id)).versions.map((v: any) => v.version)).toEqual([2, 1]);
    await expect(sq().query("UPDATE workflow_versions SET trigger_type='x' WHERE tenant_id=:t", { replacements: { t: t.tenantId } })).rejects.toThrow(/append-only/);

    const agent = await makeUser(t, ["agent"]);
    await expect(createWorkflow(sq(), agent.ctx, { name: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await sq().query("UPDATE tenant_entitlements SET enabled=0 WHERE tenant_id=:t AND feature_code='automation'", { replacements: { t: t.tenantId } });
    await expect(publishWorkflow(sq(), manager.ctx, wf.id)).rejects.toBeInstanceOf(WorkflowInvalidError);
    const other = await makeTenant();
    await expect(getWorkflow(sq(), other.admin, wf.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

async function publish(manager: Awaited<ReturnType<typeof makeUser>>, graph: WorkflowGraph) {
  const wf = await createWorkflow(sq(), manager.ctx, { name: uniq("wf"), graph });
  await publishWorkflow(sq(), manager.ctx, wf.id);
  return wf;
}

describe("execution", () => {
  it("runs a welcome flow on lead creation: consent-gated send, then stage change, recorded step by step", async () => {
    const { t, manager, tpl } = await setup();
    const wf = await publish(manager, g(
      [trig(), { id: "send", type: "communication.send", config: { channel: "sms", templateVersionId: tpl.currentVersionId, purposeCode: "marketing" } }, { id: "stage", type: "crm.change_stage", config: { stageKey: "contacted" } }],
      [{ source: "t", target: "send" }, { source: "send", target: "stage" }],
    ));
    // Person A consented, person B did not
    const a = await createContact(sq(), t.admin, { firstName: "Aya", phone: phone() });
    await recordConsent(sq(), t.admin, { contactId: a.id, purposeCode: "marketing", channel: "sms", granted: true });
    const la = await createLead(sq(), t.admin, { contactId: a.id, purpose: "buy", sourceCode: "website" });
    const ra = await handleDomainEvent(sq(), eventFor(t, la.lead.id));
    expect(ra).toMatchObject({ started: 1 });
    expect(mockMessaging.sent.map((m) => m.body)).toEqual(["Hi Aya, thanks for your enquiry"]);
    expect((await getLead(sq(), t.admin, la.lead.id)).stageEvents.length).toBe(2);

    const [run] = await listRuns(sq(), manager.ctx, wf.id);
    const detail = await getRun(sq(), manager.ctx, run.id);
    expect(detail.status).toBe("completed");
    expect(detail.steps.map((s: any) => [s.nodeId, s.status])).toEqual([["send", "completed"], ["stage", "completed"]]);

    const b = await createContact(sq(), t.admin, { firstName: "Bo", phone: phone() });
    const lb = await createLead(sq(), t.admin, { contactId: b.id, purpose: "buy", sourceCode: "website" });
    await handleDomainEvent(sq(), eventFor(t, lb.lead.id));
    expect(mockMessaging.sent).toHaveLength(1); // no consent: nothing sent, but the flow continued
    const runs = await listRuns(sq(), manager.ctx, wf.id);
    const rb = await getRun(sq(), manager.ctx, runs.find((r: any) => r.entityId === lb.lead.id).id);
    expect(rb.steps.find((s: any) => s.nodeId === "send")).toMatchObject({ status: "skipped", output: { blocked: ["no_consent"] } });
    expect(rb.status).toBe("completed");
  });

  it("starts each run once per trigger event even when the event is delivered twice", async () => {
    const { t, manager } = await setup();
    const wf = await publish(manager, g([trig(), { id: "n", type: "crm.add_note", config: { text: "auto" } }], [{ source: "t", target: "n" }]));
    const l = await createLead(sq(), t.admin, { contact: { firstName: "D", phone: phone() }, purpose: "rent", sourceCode: "website" });
    const ev = eventFor(t, l.lead.id, "lead.created", "same-event");
    expect((await handleDomainEvent(sq(), ev)).started).toBe(1);
    expect((await handleDomainEvent(sq(), ev)).started).toBe(0);
    expect(await listRuns(sq(), manager.ctx, wf.id)).toHaveLength(1);
    expect((await getLead(sq(), t.admin, l.lead.id)).activities.filter((a: any) => a.summary === "auto")).toHaveLength(1);
  });

  it("branches on conditions", async () => {
    const { t, manager } = await setup();
    const wf = await publish(manager, g(
      [trig(), { id: "c", type: "condition", config: { field: "lead.budget_max", operator: "gte", value: 5_000_000 } }, { id: "vip", type: "crm.add_note", config: { text: "VIP" } }, { id: "std", type: "crm.add_note", config: { text: "standard" } }],
      [{ source: "t", target: "c" }, { source: "c", target: "vip", sourceHandle: "true" }, { source: "c", target: "std", sourceHandle: "false" }],
    ));
    const big = await ingestLead(sq(), t.tenantId, { contact: { firstName: "Big", phone: phone() }, purpose: "buy", sourceCode: "website", budgetMax: 9_000_000 });
    const small = await ingestLead(sq(), t.tenantId, { contact: { firstName: "Small", phone: phone() }, purpose: "buy", sourceCode: "website", budgetMax: 500_000 });
    await handleDomainEvent(sq(), eventFor(t, big.lead.id));
    await handleDomainEvent(sq(), eventFor(t, small.lead.id));
    expect((await getLead(sq(), t.admin, big.lead.id)).activities.map((a: any) => a.summary)).toContain("VIP");
    expect((await getLead(sq(), t.admin, small.lead.id)).activities.map((a: any) => a.summary)).toEqual(expect.arrayContaining(["standard"]));
    void wf;
  });

  it("waits on a database row for a delay, and resumes only when due", async () => {
    const { t, manager } = await setup();
    const wf = await publish(manager, g(
      [trig(), { id: "d", type: "time.delay", config: { minutes: 60 } }, { id: "n", type: "crm.add_note", config: { text: "followed up" } }],
      [{ source: "t", target: "d" }, { source: "d", target: "n" }],
    ));
    const l = await createLead(sq(), t.admin, { contact: { firstName: "W", phone: phone() }, purpose: "buy", sourceCode: "website" });
    await handleDomainEvent(sq(), eventFor(t, l.lead.id));
    const [run] = await listRuns(sq(), manager.ctx, wf.id);
    expect(run.status).toBe("waiting");
    expect(await processDueWaits(sq(), t.tenantId)).toEqual({ resumed: 0, timedOut: 0 }); // not due
    expect((await getLead(sq(), t.admin, l.lead.id)).activities.some((a: any) => a.summary === "followed up")).toBe(false);

    const later = new Date(Date.now() + 61 * 60_000);
    expect(await processDueWaits(sq(), t.tenantId, later)).toEqual({ resumed: 1, timedOut: 0 });
    expect(await processDueWaits(sq(), t.tenantId, later)).toEqual({ resumed: 0, timedOut: 0 }); // idempotent
    expect((await getRun(sq(), manager.ctx, run.id)).status).toBe("completed");
    expect((await getLead(sq(), t.admin, l.lead.id)).activities.some((a: any) => a.summary === "followed up")).toBe(true);
  });

  it("waits for an event with a timeout branch: reply resumes, silence times out", async () => {
    const { t, manager } = await setup();
    await createRoutingRule(sq(), t.admin, { name: "mgr", conditions: {}, target: { userIds: [manager.id] } });
    const wf = await publish(manager, g(
      [trig(), { id: "w", type: "wait.event", config: { eventType: "lead.replied", timeoutMinutes: 30 } }, { id: "yes", type: "crm.add_note", config: { text: "replied" } }, { id: "no", type: "crm.create_task", config: { title: "Call the lead" } }],
      [{ source: "t", target: "w" }, { source: "w", target: "yes", sourceHandle: "resumed" }, { source: "w", target: "no", sourceHandle: "timeout" }],
    ));
    const a = await createLead(sq(), t.admin, { contact: { firstName: "Replies", phone: phone() }, purpose: "buy", sourceCode: "website" });
    const b = await createLead(sq(), t.admin, { contact: { firstName: "Silent", phone: phone() }, purpose: "buy", sourceCode: "website" });
    await handleDomainEvent(sq(), eventFor(t, a.lead.id));
    await handleDomainEvent(sq(), eventFor(t, b.lead.id));
    // a reply on lead A only
    expect((await handleDomainEvent(sq(), eventFor(t, a.lead.id, "lead.replied"))).resumed).toBe(1);
    expect((await getLead(sq(), t.admin, a.lead.id)).activities.some((x: any) => x.summary === "replied")).toBe(true);
    // lead B times out
    expect(await processDueWaits(sq(), t.tenantId, new Date(Date.now() + 31 * 60_000))).toEqual({ resumed: 0, timedOut: 1 });
    const tasks = await sq().query<{ title: string }>("SELECT title FROM tasks WHERE tenant_id=:t AND lead_id=:l", { replacements: { t: t.tenantId, l: b.lead.id }, type: QueryTypes.SELECT });
    expect(tasks).toEqual([{ title: "Call the lead" }]);
    const runs = await listRuns(sq(), manager.ctx, wf.id);
    expect(runs.every((r: any) => r.status === "completed")).toBe(true);
  });

  it("disabling a workflow cancels in-flight runs and their waits", async () => {
    const { t, manager } = await setup();
    const wf = await publish(manager, g([trig(), { id: "d", type: "time.delay", config: { minutes: 10 } }, { id: "n", type: "crm.add_note", config: { text: "late" } }], [{ source: "t", target: "d" }, { source: "d", target: "n" }]));
    const l = await createLead(sq(), t.admin, { contact: { firstName: "X", phone: phone() }, purpose: "buy", sourceCode: "website" });
    await handleDomainEvent(sq(), eventFor(t, l.lead.id));
    await setWorkflowStatus(sq(), manager.ctx, wf.id, "disabled");
    expect(await processDueWaits(sq(), t.tenantId, new Date(Date.now() + 3_600_000))).toEqual({ resumed: 0, timedOut: 0 });
    expect((await listRuns(sq(), manager.ctx, wf.id))[0].status).toBe("cancelled");
    expect((await handleDomainEvent(sq(), eventFor(t, l.lead.id, "lead.created", "new-evt"))).started).toBe(0); // disabled: no new runs
  });

  it("stops runaway chains between workflows and isolates tenants", async () => {
    const { t, manager } = await setup();
    // A: on lead.created -> move to "contacted"; B: on lead.stage_changed -> move to "qualified"; C: on stage_changed -> back... bounded by depth
    await publish(manager, g([trig("lead.stage_changed"), { id: "s", type: "crm.change_stage", config: { stageKey: "qualified" } }], [{ source: "t", target: "s" }]));
    const l = await createLead(sq(), t.admin, { contact: { firstName: "Loop", phone: phone() }, purpose: "buy", sourceCode: "website" });
    await changeLeadStage(sq(), t.admin, l.lead.id, { stageKey: "contacted" });
    let started = 0;
    for (let depth = 0; depth < 6; depth++) {
      const r = await handleDomainEvent(sq(), eventFor(t, l.lead.id, "lead.stage_changed", `chain-${depth}`, `wf:${depth}:r`));
      started += r.started;
    }
    expect(started).toBeLessThanOrEqual(3); // MAX_DEPTH hops, then the chain is cut

    const other = await makeTenant();
    expect(await handleDomainEvent(sq(), { ...eventFor(other, l.lead.id), id: "cross" })).toEqual({ started: 0, resumed: 0 }); // other tenant has no workflows and cannot reach this lead
  });
});

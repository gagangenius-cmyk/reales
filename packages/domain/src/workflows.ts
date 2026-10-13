import { randomUUID } from "node:crypto";
import { Op, QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, RequestContext, systemContext, Grant } from "@reales/database";
import { authorize } from "@reales/rbac";
import { z } from "@reales/validation";
import { changeLeadStage, createTask, addLeadActivity } from "./leads";
import { sendMessage } from "./messaging";
import { MissingVariableError } from "./templating";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

// ---------------------------------------------------------------- graph types (React Flow shape)
export interface GraphNode { id: string; type: string; config?: Record<string, unknown>; position?: { x: number; y: number } }
export interface GraphEdge { id?: string; source: string; target: string; sourceHandle?: string | null }
export interface WorkflowGraph { nodes: GraphNode[]; edges: GraphEdge[] }

export interface RunData {
  lead: Record<string, any> | null; contact: Record<string, any> | null; event: { type: string; payload: Record<string, any> };
}

interface NodeSpec {
  schema: z.ZodTypeAny;
  /** Outgoing handles this node must have wired. Empty = at most one unlabelled edge. */
  handles: string[];
  requiredPermission?: string;
  requiredEntitlement?: string;
  /** Needs a lead in context. */
  needsLead?: boolean;
  needsContact?: boolean;
}

/** Fields a condition may read: an allow-list, never arbitrary property traversal. */
export const CONDITION_FIELDS = ["lead.budget_max", "lead.budget_min", "lead.purpose", "lead.score", "lead.status", "lead.bedrooms", "lead.language", "contact.language", "contact.nationality", "event.payload.amount", "event.payload.channel"] as const;
const OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "exists"] as const;

const uuid = z.string().uuid();
export const NODE_SPECS: Record<string, NodeSpec> = {
  condition: { schema: z.object({ field: z.enum(CONDITION_FIELDS), operator: z.enum(OPERATORS), value: z.unknown().optional() }).strict(), handles: ["true", "false"] },
  "crm.change_stage": { schema: z.object({ stageKey: z.string().min(1).max(40), reason: z.string().max(255).optional() }).strict(), handles: [], requiredPermission: "lead.update", needsLead: true },
  "crm.create_task": { schema: z.object({ title: z.string().min(1).max(255), dueInHours: z.number().min(0).max(24 * 90).optional() }).strict(), handles: [], requiredPermission: "lead.update", needsLead: true },
  "crm.add_note": { schema: z.object({ text: z.string().min(1).max(2000) }).strict(), handles: [], requiredPermission: "lead.update", needsLead: true },
  "communication.send": {
    schema: z.object({ channel: z.enum(["whatsapp", "sms", "email"]), templateVersionId: uuid, purposeCode: z.string().min(1).max(60) }).strict(), handles: [],
    requiredPermission: "workflow.communication.send", needsContact: true,
  },
  "time.delay": { schema: z.object({ minutes: z.number().int().min(1).max(60 * 24 * 90) }).strict(), handles: [] },
  "wait.event": { schema: z.object({ eventType: z.string().regex(/^[a-z_]+\.[a-z_.]+$/), timeoutMinutes: z.number().int().min(1).max(60 * 24 * 90) }).strict(), handles: ["resumed", "timeout"], needsLead: true },
  "control.stop": { schema: z.object({}).strict(), handles: [] },
};

export const isTriggerType = (t: string) => /^trigger\.[a-z_]+\.[a-z_.]+$/.test(t);
export const triggerEvent = (t: string) => t.slice("trigger.".length);
const MAX_NODES = 100;
const MAX_STEPS = 200;
const MAX_DEPTH = 3;

export interface GraphIssue { code: string; nodeId?: string; message: string }

/** Static analysis run before publication (blueprint): structure, per-node config, reachability, branches, cycles, waits. */
export function validateGraph(graph: unknown): { issues: GraphIssue[]; triggerType: string | null } {
  const issues: GraphIssue[] = [];
  const g = graph as WorkflowGraph;
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return { issues: [{ code: "schema", message: "A workflow needs nodes and edges" }], triggerType: null };
  if (g.nodes.length === 0) return { issues: [{ code: "empty", message: "The workflow has no nodes" }], triggerType: null };
  if (g.nodes.length > MAX_NODES) issues.push({ code: "too_large", message: `At most ${MAX_NODES} nodes are allowed` });
  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (!n || typeof n.id !== "string" || !n.id) { issues.push({ code: "node_id", message: "Every node needs an id" }); continue; }
    if (ids.has(n.id)) issues.push({ code: "node_duplicate", nodeId: n.id, message: `Duplicate node id ${n.id}` });
    ids.add(n.id);
  }
  const triggers = g.nodes.filter((n) => typeof n?.type === "string" && isTriggerType(n.type));
  if (triggers.length !== 1) issues.push({ code: "trigger_count", message: `A workflow needs exactly one trigger (found ${triggers.length})` });
  const out = new Map<string, GraphEdge[]>();
  for (const e of g.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) { issues.push({ code: "edge_dangling", message: `Edge ${e.source} -> ${e.target} references a missing node` }); continue; }
    if (e.source === e.target) issues.push({ code: "edge_self", nodeId: e.source, message: "A node cannot connect to itself" });
    out.set(e.source, [...(out.get(e.source) ?? []), e]);
  }
  for (const n of g.nodes) {
    if (!n?.id) continue;
    const edges = out.get(n.id) ?? [];
    if (isTriggerType(n.type)) {
      if (edges.length > 1) issues.push({ code: "branch_unlabelled", nodeId: n.id, message: "A trigger has a single outgoing edge" });
      continue;
    }
    const spec = NODE_SPECS[n.type];
    if (!spec) { issues.push({ code: "node_type_unknown", nodeId: n.id, message: `Unknown node type "${n.type}"` }); continue; }
    const parsed = spec.schema.safeParse(n.config ?? {});
    if (!parsed.success) issues.push({ code: "node_config", nodeId: n.id, message: `${n.type}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "config"} ${i.message}`).join("; ")}` });
    if (spec.handles.length) {
      for (const h of spec.handles) if (!edges.some((e) => e.sourceHandle === h)) issues.push({ code: "branch_missing", nodeId: n.id, message: `${n.type} needs a "${h}" branch` });
      for (const e of edges) if (!spec.handles.includes(e.sourceHandle ?? "")) issues.push({ code: "branch_unknown", nodeId: n.id, message: `Unexpected branch "${e.sourceHandle ?? ""}" on ${n.type}` });
    } else if (edges.length > 1) issues.push({ code: "branch_unlabelled", nodeId: n.id, message: `${n.type} has more than one outgoing edge` });
  }
  // Reachability from the trigger, and cycle detection (workflows are DAGs; repeats come from new events, not loops).
  if (triggers.length === 1) {
    const seen = new Set<string>();
    const stack = [triggers[0]!.id];
    while (stack.length) { const id = stack.pop()!; if (seen.has(id)) continue; seen.add(id); for (const e of out.get(id) ?? []) stack.push(e.target); }
    for (const n of g.nodes) if (n?.id && !seen.has(n.id)) issues.push({ code: "unreachable", nodeId: n.id, message: `Node ${n.id} is not reachable from the trigger` });
    const state = new Map<string, number>();
    const visit = (id: string): boolean => {
      state.set(id, 1);
      for (const e of out.get(id) ?? []) { const s = state.get(e.target); if (s === 1) return true; if (!s && visit(e.target)) return true; }
      state.set(id, 2);
      return false;
    };
    if (visit(triggers[0]!.id)) issues.push({ code: "cycle", message: "The workflow contains a loop; use a new trigger to repeat work" });
  }
  return { issues, triggerType: triggers.length === 1 ? triggerEvent(triggers[0]!.type) : null };
}

/** Least-privilege identity workflows act as: they can do exactly what the node registry allows, and nothing else. */
function workflowCtx(tenantId: string, runId: string, depth: number): RequestContext {
  const g = (permission: string): Grant => ({ permission, scope: "tenant" });
  return { ...systemContext(tenantId, `wf:${depth}:${runId}`), grants: [g("lead.read"), g("lead.update"), g("lead.assign"), g("contact.read")] };
}
const depthOf = (correlationId: string) => { const m = /^wf:(\d+):/.exec(correlationId); return m ? Number(m[1]) : 0; };

// ---------------------------------------------------------------- authoring
async function entitlements(u: Uow): Promise<Set<string>> {
  const rows = await u.repo("TenantEntitlement").findAll({ where: { enabled: true }, transaction: u.tx });
  return new Set((rows as any[]).map((r) => r.get("featureCode") as string));
}

export async function createWorkflow(sq: Sequelize, ctx: RequestContext, i: { name: string; projectId?: string; graph?: WorkflowGraph }) {
  authorize(ctx, "workflow.manage");
  return withUow(sq, ctx, async (u) => {
    if (await u.repo("Workflow").findOne({ where: { name: i.name }, transaction: u.tx })) throw new ConflictError("A workflow with this name already exists");
    if (i.projectId && !(await u.repo("Project").findById(i.projectId, { transaction: u.tx }))) throw new NotFoundError("Project");
    const id = randomUUID();
    await u.repo("Workflow").create({ id, projectId: i.projectId ?? null, name: i.name, status: "draft", draftGraph: i.graph ?? { nodes: [], edges: [] }, currentVersion: 0, createdBy: ctx.userId }, { transaction: u.tx });
    return plain(await u.repo("Workflow").findById(id, { transaction: u.tx }));
  });
}

export async function saveDraft(sq: Sequelize, ctx: RequestContext, id: string, graph: WorkflowGraph) {
  authorize(ctx, "workflow.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Workflow").findById(id, { transaction: u.tx }))) throw new NotFoundError("Workflow");
    if (JSON.stringify(graph).length > 500_000) throw new ConflictError("The workflow is too large");
    await u.repo("Workflow").updateById(id, { draftGraph: graph }, { transaction: u.tx });
    return plain(await u.repo("Workflow").findById(id, { transaction: u.tx }));
  });
}

/** Everything validateGraph cannot know: do the referenced templates exist and are they approved; does the tenant own the feature; may the publisher use each node. */
async function deepValidate(u: Uow, ctx: RequestContext, graph: WorkflowGraph): Promise<GraphIssue[]> {
  const issues: GraphIssue[] = [];
  const ent = await entitlements(u);
  for (const n of graph.nodes) {
    const spec = NODE_SPECS[n.type];
    if (!spec) continue;
    if (n.type === "communication.send") {
      const c = n.config as any;
      const v: any = c?.templateVersionId ? await u.repo("TemplateVersion").findById(c.templateVersionId, { transaction: u.tx }) : null;
      const t: any = v ? await u.repo("Template").findById(v.get("templateId"), { transaction: u.tx }) : null;
      if (!t) issues.push({ code: "template_missing", nodeId: n.id, message: "The template does not exist" });
      else if (t.get("channel") !== c.channel) issues.push({ code: "template_channel", nodeId: n.id, message: "The template is for a different channel" });
      else if (t.get("status") !== "approved" || ["pending", "rejected"].includes(v.get("approvalStatus"))) issues.push({ code: "template_unapproved", nodeId: n.id, message: "The template is not approved" });
      if (!(await u.repo("ConsentPurpose").findOne({ where: { code: c?.purposeCode }, transaction: u.tx }))) issues.push({ code: "purpose_unknown", nodeId: n.id, message: "Unknown consent purpose" });
      if (c?.channel === "whatsapp" && !ent.has("whatsapp")) issues.push({ code: "entitlement", nodeId: n.id, message: "Your plan does not include WhatsApp" });
      if (!ctx.grants.some((g) => g.permission === "inbox.send")) issues.push({ code: "permission", nodeId: n.id, message: "You need permission to send messages to add a send node" });
    }
    if (n.type === "crm.change_stage" && !ctx.grants.some((g) => g.permission === "lead.update")) issues.push({ code: "permission", nodeId: n.id, message: "You need lead.update to add a stage-change node" });
  }
  if (!ent.has("automation")) issues.push({ code: "entitlement", message: "Your plan does not include automation" });
  return issues;
}

export class WorkflowInvalidError extends Error {
  status = 422;
  constructor(public issues: GraphIssue[]) {
    super("The workflow cannot be published");
    this.name = "WorkflowInvalidError";
  }
}

export async function validateWorkflow(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "workflow.read");
  return withUow(sq, ctx, async (u) => {
    const w: any = await u.repo("Workflow").findById(id, { transaction: u.tx });
    if (!w) throw new NotFoundError("Workflow");
    const g = w.get("draftGraph") as WorkflowGraph;
    const base = validateGraph(g);
    const deep = base.issues.length ? [] : await deepValidate(u, ctx, g);
    return { issues: [...base.issues, ...deep], triggerType: base.triggerType };
  });
}

/** Publishing freezes the draft into an immutable version; running instances keep the version they started with. */
export async function publishWorkflow(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "workflow.manage");
  return withUow(sq, ctx, async (u) => {
    const w: any = await u.repo("Workflow").findById(id, { transaction: u.tx });
    if (!w) throw new NotFoundError("Workflow");
    const g = JSON.parse(JSON.stringify(w.get("draftGraph"))) as WorkflowGraph;
    const base = validateGraph(g);
    const issues = [...base.issues, ...(base.issues.length ? [] : await deepValidate(u, ctx, g))];
    if (issues.length) throw new WorkflowInvalidError(issues);
    const version = Number(w.get("currentVersion")) + 1;
    await u.repo("WorkflowVersion").create({ id: randomUUID(), workflowId: id, version, graph: g, triggerType: base.triggerType, publishedBy: ctx.userId, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    await u.repo("Workflow").updateById(id, { status: "published", currentVersion: version }, { transaction: u.tx });
    await u.audit({ action: "workflow.published", entityType: "workflow", entityId: id, after: { version, trigger: base.triggerType, nodes: g.nodes.length } });
    await u.emit({ type: "workflow.published", aggregateType: "workflow", aggregateId: id, payload: { version } });
    return plain(await u.repo("Workflow").findById(id, { transaction: u.tx }));
  });
}

export async function setWorkflowStatus(sq: Sequelize, ctx: RequestContext, id: string, status: "published" | "disabled") {
  authorize(ctx, "workflow.manage");
  return withUow(sq, ctx, async (u) => {
    const w: any = await u.repo("Workflow").findById(id, { transaction: u.tx });
    if (!w) throw new NotFoundError("Workflow");
    if (status === "published" && w.get("currentVersion") === 0) throw new ConflictError("Publish a version first");
    await u.repo("Workflow").updateById(id, { status }, { transaction: u.tx });
    if (status === "disabled") {
      // Disabling stops in-flight runs from continuing: their waits are cancelled and the runs cancelled.
      await u.sq.query("UPDATE workflow_waits SET status='cancelled', resolved_by='disabled' WHERE tenant_id=:t AND status='waiting' AND run_id IN (SELECT id FROM workflow_runs WHERE tenant_id=:t AND workflow_id=:w)", { replacements: { t: ctx.tenantId, w: id }, transaction: u.tx });
      await u.sq.query("UPDATE workflow_runs SET status='cancelled', finished_at=NOW(3) WHERE tenant_id=:t AND workflow_id=:w AND status IN ('running','waiting')", { replacements: { t: ctx.tenantId, w: id }, transaction: u.tx });
    }
    await u.audit({ action: `workflow.${status === "disabled" ? "disabled" : "enabled"}`, entityType: "workflow", entityId: id });
    return plain(await u.repo("Workflow").findById(id, { transaction: u.tx }));
  });
}

export async function listWorkflows(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "workflow.read");
  return withUow(sq, ctx, async (u) => (await u.repo("Workflow").findAll({ order: [["createdAt", "DESC"]], transaction: u.tx })).map(plain));
}

export async function getWorkflow(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "workflow.read");
  return withUow(sq, ctx, async (u) => {
    const w: any = await u.repo("Workflow").findById(id, { transaction: u.tx });
    if (!w) throw new NotFoundError("Workflow");
    const versions = await u.repo("WorkflowVersion").findAll({ where: { workflowId: id }, order: [["version", "DESC"]], attributes: ["id", "version", "triggerType", "publishedBy", "createdAt"], transaction: u.tx });
    return { ...plain(w), versions: versions.map(plain) };
  });
}

export async function getRun(sq: Sequelize, ctx: RequestContext, runId: string) {
  authorize(ctx, "workflow.read");
  return withUow(sq, ctx, async (u) => {
    const r: any = await u.repo("WorkflowRun").findById(runId, { transaction: u.tx });
    if (!r) throw new NotFoundError("Workflow run");
    const [steps, waits] = await Promise.all([
      u.repo("WorkflowStep").findAll({ where: { runId }, order: [["createdAt", "ASC"]], transaction: u.tx }),
      u.repo("WorkflowWait").findAll({ where: { runId }, order: [["createdAt", "ASC"]], transaction: u.tx }),
    ]);
    return { ...plain(r), steps: steps.map(plain), waits: waits.map(plain) };
  });
}

export async function listRuns(sq: Sequelize, ctx: RequestContext, workflowId: string) {
  authorize(ctx, "workflow.read");
  return withUow(sq, ctx, async (u) => (await u.repo("WorkflowRun").findAll({ where: { workflowId }, order: [["startedAt", "DESC"]], limit: 100, transaction: u.tx })).map(plain));
}

// ---------------------------------------------------------------- execution
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

function readField(data: RunData, field: string): unknown {
  const own = (o: any, k: string) => (o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
  const [root, ...rest] = field.split(".");
  if (root === "event") return own(data.event.payload, rest[1]!); // event.payload.<key>
  return own(root === "lead" ? data.lead : root === "contact" ? data.contact : null, rest[0]!);
}

export function evaluateCondition(c: { field: string; operator: string; value?: unknown }, data: RunData): boolean {
  const left = readField(data, c.field);
  if (c.operator === "exists") return left !== undefined && left !== null && left !== "";
  if (left === undefined || left === null) return false; // missing data never satisfies a comparison
  const l = typeof c.value === "number" ? Number(left) : left;
  switch (c.operator) {
    case "eq": return String(l) === String(c.value);
    case "neq": return String(l) !== String(c.value);
    case "gt": return Number(left) > Number(c.value);
    case "gte": return Number(left) >= Number(c.value);
    case "lt": return Number(left) < Number(c.value);
    case "lte": return Number(left) <= Number(c.value);
    case "in": return Array.isArray(c.value) && c.value.map(String).includes(String(left));
    default: return false;
  }
}

async function loadData(u: Uow, run: any, event: { type: string; payload: any }): Promise<RunData> {
  const type = run.get("entityType") as string;
  const id = run.get("entityId") as string;
  let lead: any = null;
  let contactId: string | null = null;
  if (type === "lead") { lead = await u.repo("Lead").findById(id, { transaction: u.tx }); contactId = lead?.get("contactId") ?? null; }
  else if (type === "contact") contactId = id;
  else if (["deal", "viewing", "offer", "reservation"].includes(type)) {
    const model = ({ deal: "Deal", viewing: "Viewing", offer: "Offer", reservation: "Reservation" } as const)[type as "deal"];
    const row: any = await u.repo(model).findById(id, { transaction: u.tx });
    contactId = row?.get("contactId") ?? null;
  }
  const contact: any = contactId ? await u.repo("Contact").findById(contactId, { transaction: u.tx }) : null;
  const l = lead && { id: lead.get("id"), purpose: lead.get("purpose"), status: lead.get("status"), budget_max: num(lead.get("budgetMax")), budget_min: num(lead.get("budgetMin")), score: num(lead.get("score")), bedrooms: lead.get("bedrooms"), language: lead.get("language"), assigned_user_id: lead.get("assignedUserId") };
  const c = contact && { id: contact.get("id"), language: contact.get("language"), nationality: contact.get("nationality"), first_name: contact.get("firstName"), last_name: contact.get("lastName"), full_name: [contact.get("firstName"), contact.get("lastName")].filter(Boolean).join(" ") || contact.get("companyName"), email: contact.get("email"), phone: contact.get("phoneE164") };
  return { lead: l, contact: c, event: { type: event.type, payload: event.payload ?? {} } };
}

const step = (u: Uow, runId: string, node: GraphNode, status: "completed" | "failed" | "skipped", output?: unknown, error?: string) =>
  u.repo("WorkflowStep").create({ id: randomUUID(), runId, nodeId: node.id, nodeType: node.type, status, output: output ?? null, error: error?.slice(0, 500) ?? null, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });

async function failRun(u: Uow, runId: string, error: string) {
  await u.repo("WorkflowRun").updateById(runId, { status: "failed", error: error.slice(0, 500), finishedAt: new Date() }, { transaction: u.tx });
}

/**
 * Walk the graph from `fromNodeId`. Each node's effects are performed through the same domain services a human would use
 * (so consent, state machines and audit all apply). A wait persists a database row and ends this pass; resuming re-enters here.
 * Provider sends happen via sendMessage, whose idempotency key `wf:<run>:<node>` makes a re-run of a step safe.
 */
async function executeFrom(sq: Sequelize, tenantId: string, runId: string, fromNodeId: string | null, event: { type: string; payload: any }): Promise<void> {
  const base = systemContext(tenantId, `wf:0:${runId}`);
  const loaded = await withUow(sq, base, async (u) => {
    const run: any = await u.repo("WorkflowRun").findById(runId, { transaction: u.tx });
    if (!run || !["running", "waiting"].includes(run.get("status"))) return null;
    const version: any = await u.repo("WorkflowVersion").findById(run.get("versionId"), { transaction: u.tx });
    return { run: plain(run), graph: version.get("graph") as WorkflowGraph };
  });
  if (!loaded) return;
  const { graph } = loaded;
  const ctx = workflowCtx(tenantId, runId, Number((loaded.run.context as any)?.depth ?? 1));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const next = (id: string, handle?: string) => graph.edges.find((e) => e.source === id && (handle === undefined ? true : e.sourceHandle === handle))?.target ?? null;

  let cur: string | null = fromNodeId ?? next(graph.nodes.find((n) => isTriggerType(n.type))!.id);
  let executed = Number(loaded.run.stepsExecuted);
  while (cur) {
    if (executed >= MAX_STEPS) { await withUow(sq, ctx, (u) => failRun(u, runId, "step limit exceeded")); return; }
    const node = byId.get(cur)!;
    executed++;
    const outcome = await runNode(sq, ctx, loaded.run, node, event);
    if (outcome.kind === "wait") { await sq.query("UPDATE workflow_runs SET steps_executed=:n WHERE id=:id AND tenant_id=:t", { replacements: { n: executed, id: runId, t: tenantId } }); return; }
    if (outcome.kind === "stop") break;
    if (outcome.kind === "fail") { await sq.query("UPDATE workflow_runs SET steps_executed=:n WHERE id=:id AND tenant_id=:t", { replacements: { n: executed, id: runId, t: tenantId } }); return; }
    cur = next(cur, outcome.handle);
  }
  await withUow(sq, ctx, async (u) => {
    await u.repo("WorkflowRun").updateById(runId, { status: "completed", stepsExecuted: executed, finishedAt: new Date() }, { transaction: u.tx });
    await u.emit({ type: "workflow.run_completed", aggregateType: "workflow_run", aggregateId: runId, payload: {} });
  });
}

type Outcome = { kind: "next"; handle?: string } | { kind: "wait" } | { kind: "stop" } | { kind: "fail" };

async function runNode(sq: Sequelize, ctx: RequestContext, run: any, node: GraphNode, event: { type: string; payload: any }): Promise<Outcome> {
  const tenantId = ctx.tenantId;
  const cfg = (node.config ?? {}) as any;
  const record = (status: "completed" | "failed" | "skipped", output?: unknown, error?: string) => withUow(sq, ctx, (u) => step(u, run.id, node, status, output, error));
  const fail = async (error: string): Promise<Outcome> => {
    await withUow(sq, ctx, async (u) => { await step(u, run.id, node, "failed", null, error); await failRun(u, run.id, `${node.id}: ${error}`); });
    return { kind: "fail" };
  };
  if (isTriggerType(node.type)) { await record("completed", { event: event.type }); return { kind: "next" }; }
  try {
    const data = await withUow(sq, ctx, async (u) => loadData(u, { get: (k: string) => ({ entityType: run.entityType, entityId: run.entityId })[k] }, event));
    switch (node.type) {
      case "condition": {
        const result = evaluateCondition(cfg, data);
        await record("completed", { result });
        return { kind: "next", handle: result ? "true" : "false" };
      }
      case "crm.change_stage": {
        if (!data.lead) { await record("skipped", { reason: "no lead" }); return { kind: "next" }; }
        await changeLeadStage(sq, ctx, data.lead.id, { stageKey: cfg.stageKey, reason: cfg.reason ?? "workflow" });
        await record("completed", { stageKey: cfg.stageKey });
        return { kind: "next" };
      }
      case "crm.create_task": {
        if (!data.lead) { await record("skipped", { reason: "no lead" }); return { kind: "next" }; }
        if (!data.lead.assigned_user_id) { await record("skipped", { reason: "lead has no assigned agent" }); return { kind: "next" }; }
        await createTask(sq, ctx, { title: cfg.title, leadId: data.lead.id, assigneeId: data.lead.assigned_user_id, dueAt: cfg.dueInHours ? new Date(Date.now() + cfg.dueInHours * 3_600_000).toISOString() : undefined });
        await record("completed", {});
        return { kind: "next" };
      }
      case "crm.add_note": {
        if (!data.lead) { await record("skipped", { reason: "no lead" }); return { kind: "next" }; }
        await addLeadActivity(sq, ctx, data.lead.id, { kind: "note", summary: cfg.text });
        await record("completed", {});
        return { kind: "next" };
      }
      case "communication.send": {
        if (!data.contact) { await record("skipped", { reason: "no contact" }); return { kind: "next" }; }
        const r = await sendMessage(sq, ctx, {
          contactId: data.contact.id, channel: cfg.channel, purposeCode: cfg.purposeCode, templateVersionId: cfg.templateVersionId, workflowRunId: run.id, idempotencyKey: `wf:${run.id}:${node.id}`,
          values: { contact: data.contact, lead: data.lead ?? {} } as any,
        });
        if (r.status === "queued") return fail(`provider unavailable: ${r.error}`);
        if (r.status === "failed") return fail(r.error ?? "send failed");
        // A consent block is a normal business outcome, not an error: record it and carry on.
        await record(r.status === "blocked" ? "skipped" : "completed", r.status === "blocked" ? { blocked: r.blockedReasons } : { messageId: r.messageId });
        return { kind: "next" };
      }
      case "time.delay": {
        const at = new Date(Date.now() + cfg.minutes * 60_000);
        await withUow(sq, ctx, async (u) => {
          await step(u, run.id, node, "completed", { resumeAt: at.toISOString() });
          await u.repo("WorkflowWait").create({ id: randomUUID(), runId: run.id, nodeId: node.id, kind: "until", resumeAt: at, status: "waiting", createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
          await u.repo("WorkflowRun").updateById(run.id, { status: "waiting" }, { transaction: u.tx });
        });
        return { kind: "wait" };
      }
      case "wait.event": {
        const timeout = new Date(Date.now() + cfg.timeoutMinutes * 60_000);
        await withUow(sq, ctx, async (u) => {
          await step(u, run.id, node, "completed", { waitingFor: cfg.eventType, timeoutAt: timeout.toISOString() });
          await u.repo("WorkflowWait").create({ id: randomUUID(), runId: run.id, nodeId: node.id, kind: "event", eventType: cfg.eventType, matchEntityId: run.entityId, timeoutAt: timeout, status: "waiting", createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
          await u.repo("WorkflowRun").updateById(run.id, { status: "waiting" }, { transaction: u.tx });
        });
        return { kind: "wait" };
      }
      case "control.stop": await record("completed", {}); return { kind: "stop" };
      default: return fail(`unknown node type ${node.type}`);
    }
  } catch (e) {
    if (e instanceof MissingVariableError) { await record("skipped", { reason: e.message }); return { kind: "next" }; }
    return fail(String((e as Error).message));
  }
}

export interface DomainEventLike { id: string; type: string; tenantId: string; aggregateType: string; aggregateId: string; correlationId: string; payload: any }

/**
 * Event entry point (called by the worker for every domain event). Starts every published workflow whose trigger matches,
 * once per (version, event) - at-least-once delivery cannot start a run twice - and resolves event waits.
 */
export async function handleDomainEvent(sq: Sequelize, ev: DomainEventLike): Promise<{ started: number; resumed: number }> {
  if (ev.type.startsWith("workflow.")) return { started: 0, resumed: 0 };
  const depth = depthOf(ev.correlationId);
  const ctx = systemContext(ev.tenantId, `wf:${depth}:evt`);
  const out = { started: 0, resumed: 0 };

  // 1. event waits
  const waits = await withUow(sq, ctx, async (u) => (await u.repo("WorkflowWait").findAll({ where: { status: "waiting", kind: "event", eventType: ev.type, matchEntityId: ev.aggregateId }, transaction: u.tx })).map((w: any) => ({ id: w.get("id") as string })));
  for (const w of waits) if (await resolveWait(sq, ev.tenantId, w.id, "resumed", { type: ev.type, payload: ev.payload })) out.resumed++;

  // 2. triggers (a workflow-caused event may trigger others, but only a few hops deep)
  if (depth >= MAX_DEPTH) return out;
  const versions = await withUow(sq, ctx, async (u) => {
    const candidates = await u.repo("WorkflowVersion").findAll({ where: { triggerType: ev.type }, transaction: u.tx });
    const res: Array<{ id: string; workflowId: string }> = [];
    for (const v of candidates as any[]) {
      const w: any = await u.repo("Workflow").findById(v.get("workflowId"), { transaction: u.tx });
      if (w && w.get("status") === "published" && w.get("currentVersion") === v.get("version")) res.push({ id: v.get("id"), workflowId: w.get("id") });
    }
    return res;
  });
  for (const v of versions) {
    const runId = randomUUID();
    const created = await withUow(sq, ctx, async (u) => {
      try {
        await u.repo("WorkflowRun").create({
          id: runId, workflowId: v.workflowId, versionId: v.id, triggerEventId: ev.id, entityType: ev.aggregateType, entityId: ev.aggregateId, status: "running",
          context: { depth: depth + 1, correlationId: ev.correlationId }, stepsExecuted: 0, startedAt: new Date(),
        }, { transaction: u.tx });
        return true;
      } catch (e: any) {
        if (e?.original?.code === "ER_DUP_ENTRY" || e?.parent?.code === "ER_DUP_ENTRY") return false;
        throw e;
      }
    });
    if (!created) continue;
    out.started++;
    await executeFrom(sq, ev.tenantId, runId, null, { type: ev.type, payload: ev.payload });
  }
  return out;
}

async function resolveWait(sq: Sequelize, tenantId: string, waitId: string, how: "resumed" | "timed_out", event?: { type: string; payload: any }): Promise<boolean> {
  const ctx = systemContext(tenantId, `wf:0:wait`);
  const claimed = await withUow(sq, ctx, async (u) => {
    await u.sq.query("SELECT id FROM workflow_waits WHERE id=:id AND tenant_id=:t FOR UPDATE", { replacements: { id: waitId, t: tenantId }, transaction: u.tx });
    const w: any = await u.repo("WorkflowWait").findById(waitId, { transaction: u.tx });
    if (!w || w.get("status") !== "waiting") return null;
    const run: any = await u.repo("WorkflowRun").findById(w.get("runId"), { transaction: u.tx });
    if (!run || run.get("status") !== "waiting") { await u.repo("WorkflowWait").updateById(waitId, { status: "cancelled", resolvedBy: "run_inactive" }, { transaction: u.tx }); return null; }
    await u.repo("WorkflowWait").updateById(waitId, { status: how, resolvedBy: how === "resumed" && w.get("kind") === "until" ? "timer" : how === "resumed" ? "event" : "timeout" }, { transaction: u.tx });
    await u.repo("WorkflowRun").updateById(run.get("id"), { status: "running" }, { transaction: u.tx });
    const version: any = await u.repo("WorkflowVersion").findById(run.get("versionId"), { transaction: u.tx });
    return { runId: run.get("id") as string, nodeId: w.get("nodeId") as string, kind: w.get("kind") as string, graph: version.get("graph") as WorkflowGraph };
  });
  if (!claimed) return false;
  const edge = claimed.graph.edges.find((e) => e.source === claimed.nodeId && (claimed.kind === "event" ? e.sourceHandle === (how === "resumed" ? "resumed" : "timeout") : true));
  const ev = event ?? { type: "timer", payload: {} };
  if (!edge) { await withUow(sq, ctx, async (u) => { await u.repo("WorkflowRun").updateById(claimed.runId, { status: "completed", finishedAt: new Date() }, { transaction: u.tx }); }); return true; }
  await executeFrom(sq, tenantId, claimed.runId, edge.target, ev);
  return true;
}

/** Scheduler entry point. Business deadlines are database rows; a queue timer is only a hint to look at them. */
export async function processDueWaits(sq: Sequelize, tenantId: string, now = new Date()): Promise<{ resumed: number; timedOut: number }> {
  const ctx = systemContext(tenantId, "wf:0:due");
  const due = await withUow(sq, ctx, async (u) => (await u.repo("WorkflowWait").findAll({
    where: { status: "waiting", [Op.or]: [{ kind: "until", resumeAt: { [Op.lte]: now } }, { kind: "event", timeoutAt: { [Op.lte]: now } }] }, order: [["createdAt", "ASC"]], limit: 200, transaction: u.tx,
  })).map((w: any) => ({ id: w.get("id") as string, kind: w.get("kind") as string })));
  const out = { resumed: 0, timedOut: 0 };
  for (const w of due) {
    const ok = await resolveWait(sq, tenantId, w.id, w.kind === "event" ? "timed_out" : "resumed");
    if (ok) w.kind === "event" ? out.timedOut++ : out.resumed++;
  }
  return out;
}

void QueryTypes;

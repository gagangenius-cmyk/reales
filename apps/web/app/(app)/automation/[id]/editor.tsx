"use client";

import "@xyflow/react/dist/style.css";
import { useCallback, useMemo, useState } from "react";
import { addEdge, Background, Controls, Handle, Position, ReactFlow, useEdgesState, useNodesState, type Connection, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { errMsg, postJson } from "@/lib/client";

/** React Flow is only the UI representation: the saved JSON is validated and executed server side, never trusted or run in the browser. */
interface Field { key: string; label: string; kind: "text" | "number" | "select"; options?: string[]; placeholder?: string }
interface NodeDef { label: string; handles: string[]; fields: Field[]; defaults: Record<string, unknown> }

const CHANNELS = ["sms", "whatsapp", "email"];
const DEFS: Record<string, NodeDef> = {
  condition: { label: "Condition", handles: ["true", "false"], defaults: { field: "lead.budget_max", operator: "gte", value: 1000000 }, fields: [
    { key: "field", label: "Field", kind: "select", options: ["lead.budget_max", "lead.budget_min", "lead.purpose", "lead.score", "lead.status", "lead.bedrooms", "lead.language", "contact.language", "contact.nationality"] },
    { key: "operator", label: "Operator", kind: "select", options: ["eq", "neq", "gt", "gte", "lt", "lte", "in", "exists"] },
    { key: "value", label: "Value", kind: "text" }] },
  "crm.change_stage": { label: "Change stage", handles: [], defaults: { stageKey: "contacted" }, fields: [{ key: "stageKey", label: "Stage key", kind: "text" }, { key: "reason", label: "Reason", kind: "text" }] },
  "crm.create_task": { label: "Create task", handles: [], defaults: { title: "Follow up" }, fields: [{ key: "title", label: "Title", kind: "text" }, { key: "dueInHours", label: "Due in (hours)", kind: "number" }] },
  "crm.add_note": { label: "Add note", handles: [], defaults: { text: "Automated note" }, fields: [{ key: "text", label: "Text", kind: "text" }] },
  "communication.send": { label: "Send message", handles: [], defaults: { channel: "sms", purposeCode: "marketing", templateVersionId: "" }, fields: [
    { key: "channel", label: "Channel", kind: "select", options: CHANNELS }, { key: "purposeCode", label: "Consent purpose", kind: "text" }, { key: "templateVersionId", label: "Template version id", kind: "text", placeholder: "uuid of an approved template version" }] },
  "time.delay": { label: "Delay", handles: [], defaults: { minutes: 60 }, fields: [{ key: "minutes", label: "Minutes", kind: "number" }] },
  "wait.event": { label: "Wait for event", handles: ["resumed", "timeout"], defaults: { eventType: "lead.replied", timeoutMinutes: 1440 }, fields: [{ key: "eventType", label: "Event", kind: "text" }, { key: "timeoutMinutes", label: "Timeout (minutes)", kind: "number" }] },
  "control.stop": { label: "Stop", handles: [], defaults: {}, fields: [] },
};
const TRIGGERS = ["lead.created", "lead.assigned", "lead.stage_changed", "lead.replied", "viewing.completed", "deal.reserved", "deal.closed", "payment.received", "listing.published"];
const triggerLabel = (t: string) => `Trigger: ${t.replace("trigger.", "")}`;

function FlowNode({ data, selected }: NodeProps) {
  const d = data as { type: string; label: string; handles: string[]; invalid?: boolean };
  const isTrigger = d.type.startsWith("trigger.");
  return (
    <div className="card px-3 py-2 text-sm" style={{ minWidth: 150, borderColor: d.invalid ? "var(--danger)" : selected ? "var(--accent)" : undefined, borderWidth: 2 }}>
      {!isTrigger && <Handle type="target" position={Position.Top} />}
      <div className="font-semibold">{d.label}</div>
      {d.handles.length === 0 ? (
        d.type !== "control.stop" && <Handle type="source" position={Position.Bottom} />
      ) : (
        <>
          <div className="muted mt-2 flex justify-between text-xs">{d.handles.map((h) => <span key={h}>{h}</span>)}</div>
          {d.handles.map((h, i) => <Handle key={h} id={h} type="source" position={Position.Bottom} style={{ left: `${((i + 1) * 100) / (d.handles.length + 1)}%` }} />)}
        </>
      )}
    </div>
  );
}
const nodeTypes = { flow: FlowNode };

interface GraphJson { nodes: Array<{ id: string; type: string; config?: Record<string, unknown>; position?: { x: number; y: number } }>; edges: Array<{ id?: string; source: string; target: string; sourceHandle?: string | null }> }
type Issue = { code: string; nodeId?: string; message: string };

const toFlowNode = (n: GraphJson["nodes"][number], invalid = false): Node => {
  const def = DEFS[n.type];
  return { id: n.id, type: "flow", position: n.position ?? { x: 0, y: 0 }, data: { type: n.type, config: n.config ?? {}, label: def ? def.label : triggerLabel(n.type), handles: def?.handles ?? [], invalid } };
};

export function WorkflowEditor({ id, initial, status }: { id: string; initial: GraphJson; status: string }) {
  const seed = initial.nodes.length ? initial : { nodes: [{ id: "trigger", type: "trigger.lead.created", position: { x: 200, y: 0 } }], edges: [] };
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(seed.nodes.map((n) => toFlowNode(n)));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(seed.edges.map((e, i) => ({ id: e.id ?? `e${i}`, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? undefined, label: e.sourceHandle ?? undefined })));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onConnect = useCallback((c: Connection) => setEdges((es) => addEdge({ ...c, label: c.sourceHandle ?? undefined }, es.filter((e) => !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null))))), [setEdges]);
  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  const graph = useMemo<GraphJson>(() => ({
    nodes: nodes.map((n) => ({ id: n.id, type: (n.data as any).type, config: (n.data as any).config, position: n.position })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
  }), [nodes, edges]);

  function add(type: string) {
    const def = DEFS[type]!;
    const nid = `${type.split(".").pop()}_${Math.random().toString(36).slice(2, 6)}`;
    setNodes((ns) => [...ns, { id: nid, type: "flow", position: { x: 200 + ns.length * 12, y: 120 + ns.length * 70 }, data: { type, config: { ...def.defaults }, label: def.label, handles: def.handles } }]);
    setSelectedId(nid);
  }
  function setConfig(key: string, raw: string, kind: Field["kind"]) {
    const value: unknown = kind === "number" ? (raw === "" ? undefined : Number(raw)) : raw;
    setNodes((ns) => ns.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, config: { ...(n.data as any).config, [key]: value === "" ? undefined : value } } } : n)));
  }
  function changeTrigger(t: string) {
    setNodes((ns) => ns.map((n) => ((n.data as any).type.startsWith("trigger.") ? { ...n, data: { ...n.data, type: `trigger.${t}`, label: triggerLabel(t) } } : n)));
  }
  function remove() {
    if (!selected || (selected.data as any).type.startsWith("trigger.")) return;
    setNodes((ns) => ns.filter((n) => n.id !== selectedId));
    setEdges((es) => es.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
  }

  async function call(path: string, method: string, body?: unknown) {
    const res = await fetch(`/api/v1/workflows/${id}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    let data: any = null; try { data = await res.json(); } catch { /* empty */ }
    return { ok: res.ok, status: res.status, data };
  }
  const mark = (is: Issue[]) => setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, invalid: is.some((i) => i.nodeId === n.id) } })));

  async function save() {
    setBusy(true); setMsg(null);
    const r = await call("", "PUT", { graph });
    setBusy(false);
    setMsg(r.ok ? "Draft saved." : errMsg(r as any));
    return r.ok;
  }
  async function validate() {
    if (!(await save())) return;
    setBusy(true);
    const r = await postJson(`/api/v1/workflows/${id}/validate`);
    setBusy(false);
    if (!r.ok) return setMsg(errMsg(r));
    setIssues(r.data.issues); mark(r.data.issues);
    setMsg(r.data.issues.length ? `${r.data.issues.length} problem(s) found.` : "No problems found. Ready to publish.");
  }
  async function publish() {
    if (!(await save())) return;
    setBusy(true);
    const r = await postJson(`/api/v1/workflows/${id}/publish`);
    setBusy(false);
    if (r.status === 422) { setIssues(r.data.error.issues); mark(r.data.error.issues); return setMsg("Cannot publish: fix the problems below."); }
    if (!r.ok) return setMsg(errMsg(r));
    setIssues([]); mark([]); setMsg(`Published version ${r.data.currentVersion}.`);
  }

  const def = selected ? DEFS[(selected.data as any).type] : undefined;
  const triggerNode = nodes.find((n) => (n.data as any).type.startsWith("trigger."));
  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_300px]">
      <div className="card" style={{ height: 560 }} aria-label="Workflow canvas">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_, n) => setSelectedId(n.id)} onPaneClick={() => setSelectedId(null)} fitView>
          <Background /><Controls />
        </ReactFlow>
      </div>
      <aside className="flex flex-col gap-3">
        <div className="card p-3">
          <h2 className="mb-2 text-sm font-semibold">Trigger</h2>
          <select className="input" value={triggerNode ? (triggerNode.data as any).type.replace("trigger.", "") : ""} onChange={(e) => changeTrigger(e.target.value)} aria-label="Trigger event">
            {TRIGGERS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <h2 className="mb-2 mt-3 text-sm font-semibold">Add step</h2>
          <div className="flex flex-wrap gap-2">{Object.entries(DEFS).map(([t, d]) => <button key={t} className="btn-ghost text-xs" onClick={() => add(t)}>{d.label}</button>)}</div>
        </div>
        {selected && (
          <div className="card p-3">
            <h2 className="mb-2 text-sm font-semibold">{def?.label ?? "Trigger"} settings</h2>
            {def?.fields.map((f) => (
              <label key={f.key} className="mb-2 block text-xs">{f.label}
                {f.kind === "select"
                  ? <select className="input mt-1" value={String((selected.data as any).config?.[f.key] ?? "")} onChange={(e) => setConfig(f.key, e.target.value, f.kind)}>{f.options!.map((o) => <option key={o}>{o}</option>)}</select>
                  : <input className="input mt-1" type={f.kind === "number" ? "number" : "text"} placeholder={f.placeholder} value={String((selected.data as any).config?.[f.key] ?? "")} onChange={(e) => setConfig(f.key, e.target.value, f.kind)} />}
              </label>
            ))}
            {!(selected.data as any).type.startsWith("trigger.") && <button className="btn-ghost mt-1 text-xs" onClick={remove}>Delete step</button>}
          </div>
        )}
        <div className="card flex flex-col gap-2 p-3">
          <p className="muted text-xs">Status: {status}. Drag from a step's bottom handle to the next step. Published versions are immutable.</p>
          <div className="flex gap-2"><button className="btn-ghost text-sm" onClick={save} disabled={busy}>Save draft</button><button className="btn-ghost text-sm" onClick={validate} disabled={busy}>Validate</button><button className="btn text-sm" onClick={publish} disabled={busy}>Publish</button></div>
          {msg && <p role="status" className="text-sm">{msg}</p>}
          {issues.length > 0 && <ul role="alert" className="err list-disc pl-4 text-xs">{issues.map((i, k) => <li key={k}>{i.nodeId ? `[${i.nodeId}] ` : ""}{i.message}</li>)}</ul>}
        </div>
      </aside>
    </div>
  );
}

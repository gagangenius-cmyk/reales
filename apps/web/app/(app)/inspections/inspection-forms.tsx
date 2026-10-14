"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

type Opt = { id: string; label: string };

export function TemplateForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("move_in");
  const [items, setItems] = useState("Walls and paint\nFloors\nKitchen\nBathrooms\nAC and ventilation\nDoors and windows");
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const list = items.split("\n").map((x) => x.trim()).filter(Boolean).map((label) => ({ label }));
    const r = await postJson("/api/v1/inspection-templates", { name, kind, items: list });
    if (!r.ok) return setError(errMsg(r));
    setName("");
    router.refresh();
  }
  return (
    <details className="card p-4"><summary className="cursor-pointer font-medium">New checklist template</summary>
      <form onSubmit={submit} className="mt-3 flex flex-wrap items-start gap-3">
        <label className="text-sm">Name<input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} required maxLength={160} /></label>
        <label className="text-sm">Kind<select className="input mt-1" value={kind} onChange={(e) => setKind(e.target.value)}><option value="move_in">Move-in</option><option value="move_out">Move-out</option><option value="periodic">Periodic</option></select></label>
        <label className="grow text-sm">Checklist items (one per line)<textarea className="input mt-1 w-full" rows={5} value={items} onChange={(e) => setItems(e.target.value)} /></label>
        <button className="btn">Save template</button>
        {error && <p role="alert" className="err w-full text-sm">{error}</p>}
      </form>
    </details>
  );
}

export function ScheduleForm({ templates, units, inspectors }: { templates: Array<Opt & { kind: string }>; units: Opt[]; inspectors: Opt[] }) {
  const router = useRouter();
  const [f, setF] = useState({ templateId: templates[0]?.id ?? "", unitId: units[0]?.id ?? "", inspectorUserId: inspectors[0]?.id ?? "", scheduledFor: "" });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const tpl = templates.find((t) => t.id === f.templateId)!;
    const r = await postJson("/api/v1/inspections", { unitId: f.unitId, kind: tpl.kind, inspectorUserId: f.inspectorUserId, templateId: f.templateId, ...(f.scheduledFor ? { scheduledFor: new Date(f.scheduledFor).toISOString() } : {}) });
    if (!r.ok) return setError(errMsg(r));
    router.refresh();
  }
  const sel = (k: keyof typeof f, opts: Opt[], label: string) => <label className="text-sm">{label}<select className="input mt-1" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}>{opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>;
  return (
    <form onSubmit={submit} className="card flex flex-wrap items-end gap-3 p-4">
      {sel("templateId", templates, "Checklist")}{sel("unitId", units, "Unit")}{sel("inspectorUserId", inspectors, "Inspector")}
      <label className="text-sm">When<input className="input mt-1" type="datetime-local" value={f.scheduledFor} onChange={(e) => setF({ ...f, scheduledFor: e.target.value })} /></label>
      <button className="btn" disabled={!f.unitId || !f.inspectorUserId}>Schedule inspection</button>
      {error && <p role="alert" className="err w-full text-sm">{error}</p>}
    </form>
  );
}

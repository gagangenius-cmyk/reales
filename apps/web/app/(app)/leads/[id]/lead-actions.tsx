"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function LeadActions({ leadId, stages, currentStageId, stageKeyById }: { leadId: string; stages: { key: string; name: string }[]; currentStageId: string; stageKeyById: Record<string, string> }) {
  const router = useRouter();
  const [stage, setStage] = useState(stageKeyById[currentStageId] ?? stages[0]?.key ?? "");
  const [reason, setReason] = useState("");
  const [kind, setKind] = useState("note");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function move(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await postJson(`/api/v1/leads/${leadId}/stage`, { stageKey: stage, ...(reason ? { reason } : {}) });
    if (!r.ok) return setError(errMsg(r));
    setReason("");
    router.refresh();
  }
  async function log(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await postJson(`/api/v1/leads/${leadId}/activities`, { kind, summary });
    if (!r.ok) return setError(errMsg(r));
    setSummary("");
    router.refresh();
  }
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <form onSubmit={move} className="card flex flex-col gap-2 p-4">
        <h2 className="font-semibold">Move stage</h2>
        <select className="input" value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Stage">
          {stages.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
        </select>
        <input className="input" placeholder="Reason (required for Lost)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
        <button className="btn">Update stage</button>
      </form>
      <form onSubmit={log} className="card flex flex-col gap-2 p-4">
        <h2 className="font-semibold">Log activity</h2>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Activity type">
          {["note", "call", "whatsapp", "email", "sms", "viewing"].map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input className="input" placeholder="What happened?" value={summary} onChange={(e) => setSummary(e.target.value)} required aria-label="Summary" />
        <button className="btn">Add</button>
      </form>
      {error && <p role="alert" className="err text-sm md:col-span-2">{error}</p>}
    </div>
  );
}

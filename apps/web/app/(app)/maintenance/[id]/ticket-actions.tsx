"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

interface Props {
  ticket: { id: string; status: string; quotations: any[]; workOrders: any[] };
  vendors: Array<{ id: string; name: string }>;
  canManage: boolean; canApprove: boolean;
}

/** Every transition is a button for the NEXT valid step only; the API still enforces the rules and shows its reason. */
export function TicketActions({ ticket, vendors, canManage, canApprove }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const base = `/api/v1/maintenance-tickets/${ticket.id}`;

  async function run(path: string, body: unknown = {}) {
    setError(null);
    const r = await postJson(`${base}/${path}`, body);
    if (!r.ok) return setError(errMsg(r));
    router.refresh();
  }
  const ask = (q: string) => window.prompt(q)?.trim() || null;
  const s = ticket.status;
  const submitted = ticket.quotations.filter((q) => q.status === "submitted");
  const issued = ticket.workOrders.some((w) => ["issued", "in_progress"].includes(w.status));
  if (!canManage && !canApprove) return null;

  return (
    <div className="card flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {canManage && s === "new" && <button className="btn" onClick={() => run("triage", {})}>Triage</button>}
        {canManage && ["triaged", "quoted"].includes(s) && (
          <span className="flex flex-wrap items-center gap-2">
            <select className="input" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
            <input className="input w-28" inputMode="decimal" placeholder="Quote (AED)" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <button className="btn-ghost" disabled={!vendorId || !(Number(amount) > 0)} onClick={() => run("quotations", { vendorId, amount: Number(amount) }).then(() => setAmount(""))}>Add quotation</button>
          </span>
        )}
        {canManage && submitted.map((q) => (
          <span key={q.id} className="flex items-center gap-1 text-sm">
            Quote {Number(q.amount).toLocaleString("en-US")}:
            <button className="btn-ghost text-xs" onClick={async () => { setError(null); const r = await postJson(`${base}/quotations/${q.id}/decision`, { outcome: "approved" }); if (!r.ok) return setError(r.status === 403 ? "This quote is above your approval limit: a manager must approve it." : errMsg(r)); router.refresh(); }}>{canApprove ? "Approve" : "Approve (if within limit)"}</button>
            <button className="btn-ghost text-xs" onClick={async () => { const r = await postJson(`${base}/quotations/${q.id}/decision`, { outcome: "rejected" }); if (!r.ok) return setError(errMsg(r)); router.refresh(); }}>Reject</button>
          </span>
        ))}
        {canManage && ["triaged", "quoted", "approved"].includes(s) && !issued && <button className="btn" onClick={() => run("work-order", s === "approved" ? {} : { vendorId })}>Issue work order</button>}
        {canManage && issued && s === "approved" && <button className="btn" onClick={() => run("start")}>Start work</button>}
        {canManage && s === "in_progress" && <button className="btn" onClick={() => { const c = Number(ask("Final cost (AED)")); if (c >= 0 && !isNaN(c)) run("complete", { finalCost: c }); }}>Complete work</button>}
        {canManage && s === "completed" && <button className="btn" onClick={() => run("close")}>Close ticket</button>}
        {canManage && !["completed", "closed", "cancelled"].includes(s) && <button className="btn-ghost" onClick={() => { const reason = ask("Reason for cancelling?"); if (reason) run("cancel", { reason }); }}>Cancel</button>}
      </div>
      {error && <p role="alert" className="err text-sm">{error}</p>}
    </div>
  );
}

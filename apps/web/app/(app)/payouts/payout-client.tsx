"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

interface Payable { calculationId: string; amount: string; vat: string; currency: string; calculatedAt: string }
const money = (v: unknown, c = "AED") => `${c} ${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

export function RequestForm({ payable, external }: { payable: Payable[]; external: boolean }) {
  const router = useRouter();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [invoice, setInvoice] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const chosen = payable.filter((p) => sel.has(p.calculationId));
  const total = chosen.reduce((a, p) => a + Number(p.amount) + Number(p.vat), 0);
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  if (payable.length === 0) return <p className="muted text-sm">Nothing to request yet. Approved commissions where you are a payee appear here.</p>;
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const r = await postJson("/api/v1/payouts", { calculationIds: [...sel], ...(invoice.trim() && { invoiceRef: invoice.trim() }), ...(note.trim() && { note: note.trim() }) });
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    setSel(new Set()); setInvoice(""); setNote(""); setMsg({ ok: true, text: "Requested. Finance has been notified." }); router.refresh();
  }
  return (
    <form onSubmit={submit} className="card p-4">
      <ul className="flex flex-col divide-y">
        {payable.map((p) => (
          <li key={p.calculationId} className="flex items-center gap-3 py-2.5 text-sm">
            <input type="checkbox" checked={sel.has(p.calculationId)} onChange={() => toggle(p.calculationId)} aria-label="Include in request" />
            <span className="grow">Commission calculated {new Date(p.calculatedAt).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", year: "numeric" })}</span>
            <span className="font-medium">{money(p.amount, p.currency)}</span>{Number(p.vat) > 0 && <span className="muted text-xs">+ VAT {money(p.vat, p.currency)}</span>}
          </li>
        ))}
      </ul>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {external && <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Your tax invoice number</span><input className="input" value={invoice} onChange={(e) => setInvoice(e.target.value)} required /></label>}
        <label className="flex flex-col gap-1.5 text-sm sm:col-span-2"><span className="muted text-xs font-medium">Note for finance (optional)</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      <div className="mt-3 flex items-center gap-3"><button className="btn" disabled={!sel.size}>Request {sel.size ? money(total, payable[0]?.currency) : "payout"}</button>{msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "muted" : "err"}`}>{msg.text}</p>}</div>
    </form>
  );
}

export function PayoutActions({ id, status, mine, canDecide }: { id: string; status: string; mine: boolean; canDecide: boolean }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  async function go(body: Record<string, unknown>) {
    setMsg(null);
    const r = await postJson(`/api/v1/payouts/${id}`, body);
    if (!r.ok) return setMsg(r.status === 403 ? "Confirm your second factor first, then retry." : errMsg(r));
    router.refresh();
  }
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="flex gap-2">
        {status === "pending" && mine && <button className="btn-ghost text-xs" onClick={() => go({ action: "cancel" })}>Cancel</button>}
        {status === "pending" && canDecide && !mine && (<>
          <button className="btn text-xs" onClick={() => go({ action: "decide", outcome: "approved" })}>Approve</button>
          <button className="btn-ghost text-xs" onClick={() => { const reason = prompt("Why is this request rejected?")?.trim(); if (reason) void go({ action: "decide", outcome: "rejected", reason }); }}>Reject</button>
        </>)}
        {status === "approved" && canDecide && <button className="btn text-xs" onClick={() => { const reference = prompt("Payment reference (bank transfer / cheque no.)")?.trim(); if (reference) void go({ action: "pay", reference }); }}>Mark paid</button>}
      </span>
      {msg && <span role="alert" className="err text-xs">{msg}</span>}
    </span>
  );
}

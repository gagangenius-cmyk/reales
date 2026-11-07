"use client";

import { useState } from "react";
import { Select } from "@/components/select";
import { useRouter } from "next/navigation";
import { useStepUp } from "@/components/step-up";
import { errMsg, postJson } from "@/lib/client";

const lab = "flex flex-col gap-1.5 text-sm";
const cap = "muted text-xs font-medium";

export function NewBatch({ candidates }: { candidates: any[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const currency = candidates.find((c) => picked.includes(c.id))?.currency;
  async function create(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const r = await postJson("/api/v1/commission-claims", { title: title || undefined, calculationIds: picked });
    if (!r.ok) return setMsg(errMsg(r));
    router.push(`/claims/${r.data.id}`);
  }
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>+ New claim batch</button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="New claim batch">
          <button className="absolute inset-0 bg-black/50" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} />
          <form onSubmit={create} className="relative flex h-full w-full max-w-2xl flex-col shadow-2xl" style={{ background: "var(--bg)" }}>
            <header className="border-b px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}><h2 className="text-xl font-semibold">New claim batch</h2><p className="muted text-sm">Approved commissions that are unpaid and not already requested or claimed. One currency per batch.</p></header>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
              <label className={lab}><span className={cap}>Title (optional)</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} /></label>
              <table className="t w-full text-sm"><thead><tr><th /><th>Agent</th><th>Amount</th><th>VAT</th><th>Approved</th></tr></thead>
                <tbody>{candidates.map((c) => {
                  const blocked = !!currency && c.currency !== currency;
                  return <tr key={c.id} className={blocked ? "opacity-40" : ""}><td><input type="checkbox" disabled={blocked} checked={picked.includes(c.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} /></td>
                    <td>{c.agentEmail ?? "-"}</td><td>{c.currency} {Number(c.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td><td>{Number(c.vatAmount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td><td>{c.approvedAt ? new Date(c.approvedAt).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short" }) : "-"}</td></tr>;
                })}{candidates.length === 0 && <tr><td colSpan={5} className="muted py-3">No approved, unpaid commissions are available.</td></tr>}</tbody></table>
            </div>
            <footer className="flex items-center justify-between gap-3 border-t px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <p role="alert" className="err min-w-0 flex-1 text-sm">{msg}</p><div className="flex gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn" disabled={!picked.length}>Create batch ({picked.length})</button></div>
            </footer>
          </form>
        </div>
      )}
    </>
  );
}

interface Props { batch: { id: string; status: string; mine: boolean; itemCount: number }; can: Record<"create" | "verify" | "approve" | "release" | "reverse", boolean>; items: any[] }

export function BatchActions({ batch, can, items }: Props) {
  const router = useRouter();
  const { guard, form } = useStepUp();
  const [msg, setMsg] = useState<string | null>(null);
  const [ask, setAsk] = useState<null | { action: "schedule" | "release" | "reverse" | "reject" | "cancel" | "evidence" | "flag"; itemId?: string }>(null);
  const [v, setV] = useState({ text: "", date: "", kind: "bank_statement" });
  const s = batch.status;

  async function act(body: object, sensitive = false) {
    setMsg(null);
    const call = () => postJson(`/api/v1/commission-claims/${batch.id}`, body);
    const r = sensitive ? await guard(call) : await call();
    if (r.data?.error?.code === "step_up_required") return;
    if (!r.ok) return setMsg(errMsg(r));
    setAsk(null); setV({ ...v, text: "" }); router.refresh();
  }
  const btn = (label: string, onClick: () => void, primary = false) => <button key={label} className={primary ? "btn" : "btn-ghost"} onClick={onClick}>{label}</button>;
  const live = items.filter((i) => i.live);

  return (
    <div className="card flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {can.create && ["draft", "submitted", "verified"].includes(s) && btn("Add evidence", () => setAsk({ action: "evidence" }))}
        {can.create && s === "draft" && batch.mine && btn("Submit for verification", () => act({ action: "submit" }), true)}
        {can.create && ["draft", "submitted"].includes(s) && batch.mine && btn("Cancel batch", () => setAsk({ action: "cancel" }))}
        {can.verify && s === "submitted" && btn("Mark batch verified", () => act({ action: "verify" }), true)}
        {((can.verify && s === "submitted") || (can.approve && s === "verified")) && btn("Reject", () => setAsk({ action: "reject" }))}
        {can.approve && s === "verified" && btn("Approve", () => act({ action: "approve" }, true), true)}
        {can.approve && ["approved", "scheduled"].includes(s) && btn(s === "approved" ? "Schedule release" : "Change release date", () => setAsk({ action: "schedule" }), s === "approved")}
        {can.release && s === "scheduled" && btn("Release payment", () => setAsk({ action: "release" }), true)}
        {can.reverse && s === "released" && btn("Reverse release", () => setAsk({ action: "reverse" }))}
      </div>
      {can.verify && s === "submitted" && (
        <ul className="flex flex-col gap-1 text-sm">{live.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-2"><span className="min-w-48">{i.payeeEmail ?? "Company"} - {i.currency} {Number(i.amount).toLocaleString("en-US")}</span>
            <span className="badge">{i.verification}</span>
            <button className="btn-ghost text-xs" onClick={() => act({ action: "verify_item", itemId: i.id, outcome: "verified" })}>Verified</button>
            <button className="btn-ghost text-xs" onClick={() => { setAsk({ action: "flag", itemId: i.id }); }}>Flag</button></li>))}</ul>)}
      {can.create && s === "draft" && live.length > 1 && (
        <ul className="flex flex-col gap-1 text-sm">{live.map((i) => <li key={i.id} className="flex items-center gap-2"><span>{i.payeeEmail ?? "Company"} - {i.currency} {Number(i.amount).toLocaleString("en-US")}</span><button className="btn-ghost text-xs" onClick={() => act({ action: "remove_item", itemId: i.id })}>Remove</button></li>)}</ul>)}
      {ask && (
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => {
          e.preventDefault();
          if (ask.action === "schedule") return act({ action: "schedule", date: v.date });
          if (ask.action === "release") return act({ action: "release", reference: v.text }, true);
          if (ask.action === "reverse") return act({ action: "reverse", reason: v.text }, true);
          if (ask.action === "reject") return act({ action: "reject", reason: v.text });
          if (ask.action === "cancel") return act({ action: "cancel", reason: v.text });
          if (ask.action === "flag") return act({ action: "verify_item", itemId: ask.itemId, outcome: "flagged", note: v.text });
          return act({ action: "evidence", kind: v.kind, description: v.text });
        }}>
          {ask.action === "schedule" && <label className={lab}><span className={cap}>Release date (Dubai)</span><input className="input" type="date" required value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></label>}
          {ask.action === "evidence" && <label className={lab}><span className={cap}>Type</span><Select className="input" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>{["bank_statement", "invoice", "contract", "email", "other"].map((k) => <option key={k} value={k}>{k.replace("_", " ")}</option>)}</Select></label>}
          {ask.action !== "schedule" && <label className={lab}><span className={cap}>{{ release: "Bank payment reference", reverse: "Why is the release being reversed?", reject: "Reason", cancel: "Reason", flag: "What is wrong?", evidence: "Describe the evidence" }[ask.action]}</span><input className="input w-80" required value={v.text} onChange={(e) => setV({ ...v, text: e.target.value })} maxLength={ask.action === "evidence" ? 300 : 255} /></label>}
          <button className="btn">Confirm</button><button type="button" className="btn-ghost" onClick={() => setAsk(null)}>Cancel</button>
        </form>)}
      {form}
      {msg && <p role="alert" className="err text-sm">{msg}</p>}
    </div>
  );
}

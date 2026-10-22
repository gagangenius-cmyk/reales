"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export interface LeadRow {
  id: string; contactName: string; createdAt: string; purpose: string; isHot: boolean; stageId: string; stageKey: string; stageName: string; stageKind: string; status: string;
  campaign: string | null; assignedUserId: string | null; assignedTo: string | null; followUp: string | null; budgetMax: number | null; currency: string; tags: string[];
}
export interface StageOpt { id: string; key: string; name: string; kind: string }
export interface UserOpt { id: string; email: string }

const dt = (s: string) => new Date(s).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" });
const overdue = (l: LeadRow) => !!l.followUp && l.status === "open" && new Date(l.followUp) < new Date();
const money = (v: number | null, c: string) => (v ? `${c} ${Number(v).toLocaleString("en-US")}` : "-");

function Th({ label, cur, asc, desc, hrefs }: { label: string; cur: string; asc: string; desc: string; hrefs: [string, string] }) {
  const on = cur === asc || cur === desc;
  return <th aria-sort={on ? "ascending" : "none"}><Link href={on && cur === asc && asc !== desc ? hrefs[1] : hrefs[0]} className="whitespace-nowrap">{label}{on ? (cur === desc && asc !== desc ? " ▼" : " ▲") : ""}</Link></th>;
}

/* ------------------------------------------------------------------ list with bulk actions */

export function LeadsTable({ rows, stages, users, canAssign, canUpdate, sortLinks }: { rows: LeadRow[]; stages: StageOpt[]; users: UserOpt[]; canAssign: boolean; canUpdate: boolean; sortLinks?: { sort: string; received: [string, string]; followUp: [string, string]; budget: [string, string]; contacted: [string, string] } }) {
  const router = useRouter();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tag, setTag] = useState("");
  const all = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function run(action: Record<string, unknown>, label: string) {
    setBusy(true); setMsg(null);
    const r = await postJson("/api/v1/leads/bulk", { ids: [...sel], action });
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    const { done, failed } = r.data as { done: number; failed: { id: string; reason: string }[] };
    setMsg({ ok: failed.length === 0, text: `${label}: ${done} updated${failed.length ? `, ${failed.length} failed (${[...new Set(failed.map((f) => f.reason))].slice(0, 2).join("; ")})` : ""}.` });
    setSel(new Set()); setTag("");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      {sel.size > 0 && (canAssign || canUpdate) && (
        <div className="card sticky top-16 z-10 flex flex-wrap items-center gap-2 p-3 text-sm" role="toolbar" aria-label="Bulk actions">
          <b>{sel.size} selected</b>
          {canAssign && (
            <select className="input w-auto py-1" disabled={busy} defaultValue="" aria-label="Assign selected to" onChange={(e) => { if (e.target.value) { void run({ type: "assign", userId: e.target.value === "none" ? null : e.target.value }, "Reassigned"); e.target.value = ""; } }}>
              <option value="">Assign to...</option><option value="none">Unassign</option>{users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
            </select>
          )}
          {canUpdate && (
            <>
              <select className="input w-auto py-1" disabled={busy} defaultValue="" aria-label="Move selected to stage" onChange={(e) => {
                const st = stages.find((s) => s.key === e.target.value); if (!st) return;
                const reason = st.kind === "lost" ? prompt("Why were these leads lost?")?.trim() : undefined;
                if (st.kind === "lost" && !reason) { e.target.value = ""; return; }
                void run({ type: "stage", stageKey: st.key, ...(reason ? { reason } : {}) }, `Moved to ${st.name}`); e.target.value = "";
              }}><option value="">Move to stage...</option>{stages.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</select>
              <button className="btn-ghost" disabled={busy} onClick={() => run({ type: "hot", value: true }, "Marked hot")}>&#9650; Mark hot</button>
              <button className="btn-ghost" disabled={busy} onClick={() => run({ type: "hot", value: false }, "Hot removed")}>Remove hot</button>
              <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); if (tag.trim()) void run({ type: "tag", tag: tag.trim() }, "Tagged"); }}>
                <input className="input w-32 py-1" placeholder="Add tag" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag" /><button className="btn-ghost" disabled={busy || !tag.trim()}>Tag</button>
              </form>
            </>
          )}
          <button className="btn-ghost ml-auto" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}
      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "muted" : "err"}`}>{msg.text}</p>}
      <div className="card overflow-x-auto">
        <table className="t">
          <thead><tr>
            <th className="w-8"><input type="checkbox" aria-label="Select all" checked={all} onChange={() => setSel(all ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
            <th>Contact</th>{sortLinks ? <Th label="Received" cur={sortLinks.sort} asc="oldest" desc="newest" hrefs={sortLinks.received} /> : <th>Received</th>}<th>Purpose</th><th>Stage</th><th>Status</th><th>Campaign</th><th>Assigned to</th>{sortLinks ? <><Th label="Follow-up" cur={sortLinks.sort} asc="followup" desc="followup" hrefs={sortLinks.followUp} /><Th label="Budget (max)" cur={sortLinks.sort} asc="budget" desc="budget" hrefs={sortLinks.budget} /></> : <><th>Follow-up</th><th>Budget (max)</th></>}<th />
          </tr></thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id} className={sel.has(l.id) ? "bg-[var(--accent-soft)]" : ""}>
                <td><input type="checkbox" aria-label={`Select ${l.contactName}`} checked={sel.has(l.id)} onChange={() => toggle(l.id)} /></td>
                <td className="font-medium"><Link href={`/leads/${l.id}`}>{l.contactName}</Link>{l.tags.slice(0, 2).map((t) => <span key={t} className="badge ml-1">{t}</span>)}</td>
                <td>{dt(l.createdAt)}</td><td>{l.isHot && <span className="err" title="Hot lead">&#9650; </span>}{l.purpose}</td><td>{l.stageName}</td>
                <td><span className={`badge ${l.status === "won" ? "badge-ok" : l.status === "lost" ? "badge-gray" : ""}`}>{l.status}</span></td>
                <td>{l.campaign ?? "-"}</td><td>{l.assignedTo ?? (l.assignedUserId ? "Assigned" : "Unassigned")}</td>
                <td className={overdue(l) ? "err" : ""}>{l.followUp ? dt(l.followUp) : "-"}</td><td>{money(l.budgetMax, l.currency)}</td>
                <td className="text-right"><Link className="btn-ghost text-xs" href={`/leads/${l.id}`}>Open</Link></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={11} className="muted">No leads visible to you.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ kanban board */

export function LeadBoard({ rows, stages, canMove }: { rows: LeadRow[]; stages: StageOpt[]; canMove: boolean }) {
  const router = useRouter();
  const [cards, setCards] = useState(rows);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [lost, setLost] = useState<{ id: string; stage: StageOpt } | null>(null);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [hotOnly, setHotOnly] = useState(false);

  const shown = useMemo(() => cards.filter((c) => (!hotOnly || c.isHot) && (!q || `${c.contactName} ${c.campaign ?? ""} ${c.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase()))), [cards, q, hotOnly]);

  async function move(id: string, stage: StageOpt, why?: string) {
    const prev = cards;
    setCards(cards.map((c) => (c.id === id ? { ...c, stageId: stage.id, stageKey: stage.key, stageName: stage.name, stageKind: stage.kind, status: stage.kind === "open" ? "open" : stage.kind } : c)));
    setMsg(null);
    const r = await postJson(`/api/v1/leads/${id}/stage`, { stageKey: stage.key, ...(why ? { reason: why } : {}) });
    if (!r.ok) { setCards(prev); setMsg(r.status === 403 ? "You cannot move that lead (re-opening a closed lead is a manager action)." : errMsg(r)); return; }
    router.refresh();
  }
  function drop(stage: StageOpt) {
    const id = drag; setDrag(null); setOver(null);
    const card = cards.find((c) => c.id === id);
    if (!id || !card || card.stageId === stage.id || !canMove) return;
    if (stage.kind === "lost") { setLost({ id, stage }); setReason(""); return; }
    void move(id, stage);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <input className="input max-w-xs" placeholder="Filter cards: name, campaign, tag" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter cards" />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={hotOnly} onChange={(e) => setHotOnly(e.target.checked)} /> Hot only</label>
        <span className="muted text-xs">{canMove ? "Drag a card to change its stage." : "You can view but not move leads."}</span>
      </div>
      {msg && <p role="alert" className="err text-sm">{msg}</p>}
      <div className="flex gap-3 overflow-x-auto pb-3" style={{ minHeight: "60vh" }}>
        {stages.map((s) => {
          const col = shown.filter((c) => c.stageId === s.id);
          const total = col.reduce((a, c) => a + (c.budgetMax ?? 0), 0);
          return (
            <section key={s.id} aria-label={`${s.name} column`} onDragOver={(e) => { if (canMove) { e.preventDefault(); setOver(s.id); } }} onDragLeave={() => setOver((o) => (o === s.id ? null : o))} onDrop={() => drop(s)}
              className="flex w-72 shrink-0 flex-col rounded-xl border" style={{ borderColor: over === s.id ? "var(--accent)" : "var(--border)", background: "var(--card-2)", boxShadow: over === s.id ? "0 0 0 2px var(--accent-soft)" : undefined }}>
              <header className="flex items-center justify-between border-b px-3 py-2.5" style={{ borderColor: "var(--border)" }}>
                <h3 className="font-semibold">{s.name}</h3><span className={`badge ${s.kind === "won" ? "badge-ok" : s.kind === "lost" ? "badge-gray" : ""}`}>{col.length}</span>
              </header>
              {total > 0 && <p className="muted px-3 pt-1.5 text-xs">Up to AED {Math.round(total).toLocaleString("en-US")}</p>}
              <ul className="flex flex-1 flex-col gap-2 p-2">
                {col.map((c) => (
                  <li key={c.id} draggable={canMove} onDragStart={() => setDrag(c.id)} onDragEnd={() => { setDrag(null); setOver(null); }}
                    className="card cursor-grab p-3 text-sm active:cursor-grabbing" style={{ opacity: drag === c.id ? 0.4 : 1, borderLeft: c.isHot ? "3px solid var(--danger)" : undefined }}>
                    <div className="flex items-start justify-between gap-2"><Link className="font-semibold" href={`/leads/${c.id}`}>{c.contactName}</Link>{c.isHot && <span className="err" title="Hot lead">&#9650;</span>}</div>
                    <p className="muted text-xs">{c.purpose}{c.budgetMax ? ` · ${money(c.budgetMax, c.currency)}` : ""}</p>
                    {c.campaign && <p className="mt-1 text-xs">{c.campaign}</p>}
                    {c.tags.length > 0 && <p className="mt-1">{c.tags.slice(0, 3).map((t) => <span key={t} className="badge mr-1">{t}</span>)}</p>}
                    <div className="mt-2 flex items-center justify-between text-xs">
                      <span className="muted truncate">{c.assignedTo ?? "Unassigned"}</span>
                      {c.followUp && <span className={overdue(c) ? "err font-semibold" : "muted"}>{overdue(c) ? "Overdue " : ""}{new Date(c.followUp).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short" })}</span>}
                    </div>
                  </li>
                ))}
                {col.length === 0 && <li className="muted p-3 text-center text-xs">{canMove ? "Drop a lead here" : "Empty"}</li>}
              </ul>
            </section>
          );
        })}
      </div>
      {lost && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Lost reason">
          <form className="card w-full max-w-md p-5" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) { void move(lost.id, lost.stage, reason.trim()); setLost(null); } }}>
            <h2 className="font-semibold">Mark as lost</h2><p className="muted mb-3 text-sm">A reason is required so you can learn why deals are lost.</p>
            <textarea className="input min-h-24" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Bought elsewhere, budget too low, not responding..." autoFocus />
            <div className="mt-3 flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={() => setLost(null)}>Cancel</button><button className="btn" disabled={!reason.trim()}>Mark lost</button></div>
          </form>
        </div>
      )}
    </div>
  );
}

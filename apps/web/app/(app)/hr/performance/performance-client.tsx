"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Lbl, useAction } from "@/components/hr-ui";

interface Cycle { id: string; name: string; periodStart: string; periodEnd: string; status: string; ratingScale: number; total?: number; done?: number }
interface Goal { title: string; weight?: number | null; target?: string | null; progress?: number }
interface Review { id: string; employeeName: string; employeeNo: string; designation: string | null; status: string; goals: Goal[]; selfRating: number | null; selfComments: string | null; managerRating: number | null; managerComments: string | null; finalRating: number | null; outcome: string | null; canSelf: boolean; canManager: boolean; canFinalise: boolean; canGoals: boolean }
const STATUS: Record<string, string> = { pending: "Waiting for self-assessment", self_submitted: "Waiting for manager", manager_submitted: "Waiting for HR", finalised: "Final" };

export function PerformanceClient({ cycles, detail, canManage }: { cycles: Cycle[]; detail: { cycle: Cycle; reviews: Review[] } | null; canManage: boolean }) {
  const router = useRouter();
  const { busy, run, Msg, post } = useAction();
  const [nc, setNc] = useState({ name: "", periodStart: "", periodEnd: "", ratingScale: "5" });
  const [open, setOpen] = useState<string | null>(null);
  const [rate, setRate] = useState({ rating: "", comments: "", final: "", outcome: "" });
  const [goals, setGoals] = useState<Goal[]>([]);
  const c = detail?.cycle;
  const edit = (r: Review) => { setOpen(open === r.id ? null : r.id); setGoals(r.goals.map((g) => ({ ...g }))); setRate({ rating: "", comments: "", final: "", outcome: "" }); };
  return (
    <div className="flex flex-col gap-5">
      <Msg />
      {canManage && (
        <form className="card grid gap-3 p-4 text-sm sm:grid-cols-5" onSubmit={(e) => { e.preventDefault(); void run(() => post("/api/v1/hr/performance/cycles", { name: nc.name, periodStart: nc.periodStart, periodEnd: nc.periodEnd, ratingScale: Number(nc.ratingScale) }), "Review cycle opened for every active employee.", (d) => router.push(`/hr/performance?cycle=${d.id}`)); }}>
          <h2 className="font-semibold sm:col-span-5">Open a review cycle</h2>
          <Lbl label="Name" wide><input className="input" required value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} placeholder="H1 2026 review" /></Lbl>
          <Lbl label="Period from"><input className="input" type="date" required value={nc.periodStart} onChange={(e) => setNc({ ...nc, periodStart: e.target.value })} /></Lbl>
          <Lbl label="Period to"><input className="input" type="date" required value={nc.periodEnd} onChange={(e) => setNc({ ...nc, periodEnd: e.target.value })} /></Lbl>
          <Lbl label="Rating scale"><select className="input" value={nc.ratingScale} onChange={(e) => setNc({ ...nc, ratingScale: e.target.value })}>{[3, 4, 5, 10].map((n) => <option key={n} value={n}>1 to {n}</option>)}</select></Lbl>
          <div className="sm:col-span-5"><button className="btn" disabled={busy}>Open cycle</button></div>
        </form>
      )}
      <div className="flex flex-wrap gap-2 text-sm">{cycles.map((x) => <button key={x.id} className={c?.id === x.id ? "btn" : "btn-ghost"} onClick={() => router.push(`/hr/performance?cycle=${x.id}`)}>{x.name} <span className="opacity-70">({x.status}{x.total !== undefined ? `, ${x.done}/${x.total} final` : ""})</span></button>)}{cycles.length === 0 && <span className="muted">No review cycles yet.</span>}</div>
      {c && detail && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">{c.name} <span className="muted text-sm font-normal">{c.periodStart.slice(0, 10)} to {c.periodEnd.slice(0, 10)}, rating 1 to {c.ratingScale}</span></h2>
            {canManage && c.status === "open" && <button className="btn-ghost" disabled={busy} onClick={() => run(() => post(`/api/v1/hr/performance/cycles/${c.id}/close`, {}), "Cycle closed.")}>Close cycle</button>}</div>
          <div className="card overflow-x-auto" data-server-table>
            <table className="t"><thead><tr><th>Employee</th><th>Status</th><th>Self</th><th>Manager</th><th>Final</th><th /></tr></thead>
              <tbody>
                {detail.reviews.map((r) => (
                  <>
                    <tr key={r.id}><td className="font-medium">{r.employeeName}<div className="muted text-xs font-normal">{r.employeeNo}{r.designation ? ` - ${r.designation}` : ""}</div></td><td><span className={`badge ${r.status === "finalised" ? "badge-ok" : "badge-warn"}`}>{STATUS[r.status]}</span></td><td>{r.selfRating ?? "-"}</td><td>{r.managerRating ?? "-"}</td><td className="font-semibold">{r.finalRating ?? "-"}{r.outcome && <div className="muted text-xs font-normal">{r.outcome}</div>}</td><td className="text-right"><button className="btn-ghost text-xs" onClick={() => edit(r)}>{open === r.id ? "Close" : "Open"}</button></td></tr>
                    {open === r.id && (
                      <tr key={`${r.id}-d`}><td colSpan={6}>
                        <div className="grid gap-4 p-2 text-sm lg:grid-cols-2">
                          <div className="flex flex-col gap-2"><b>Goals</b>
                            {goals.map((g, i) => (
                              <div key={i} className="grid grid-cols-[1fr_4rem_4rem_auto] gap-2"><input className="input" placeholder="Goal" value={g.title} disabled={!r.canGoals} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} /><input className="input" type="number" min="0" max="100" placeholder="Wt %" value={g.weight ?? ""} disabled={!r.canGoals} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, weight: e.target.value === "" ? null : Number(e.target.value) } : x)))} /><input className="input" type="number" min="0" max="100" placeholder="Done %" value={g.progress ?? 0} disabled={!r.canGoals} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, progress: Number(e.target.value) } : x)))} />{r.canGoals && <button type="button" className="btn-ghost text-xs" onClick={() => setGoals(goals.filter((_, j) => j !== i))}>x</button>}</div>
                            ))}
                            {r.canGoals && <div className="flex gap-2"><button type="button" className="btn-ghost text-xs" onClick={() => setGoals([...goals, { title: "", weight: null, progress: 0 }])}>+ Goal</button><button type="button" className="btn text-xs" disabled={busy} onClick={() => run(() => post(`/api/v1/hr/performance/reviews/${r.id}/goals`, { goals: goals.filter((g) => g.title.trim()).map((g) => ({ title: g.title, ...(g.weight != null ? { weight: g.weight } : {}), progress: g.progress ?? 0 })) }, "PUT"), "Goals saved.")}>Save goals</button></div>}
                          </div>
                          <div className="flex flex-col gap-3">
                            {r.selfComments && <div><b>Self-assessment ({r.selfRating}/{c.ratingScale})</b><p className="muted whitespace-pre-wrap">{r.selfComments}</p></div>}
                            {r.managerComments && <div><b>Manager ({r.managerRating}/{c.ratingScale})</b><p className="muted whitespace-pre-wrap">{r.managerComments}</p></div>}
                            {(r.canSelf || r.canManager) && (
                              <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => post(`/api/v1/hr/performance/reviews/${r.id}/${r.canSelf ? "self" : "manager"}`, { rating: Number(rate.rating), comments: rate.comments }), "Submitted."); }}>
                                <b>{r.canSelf ? "Your self-assessment" : "Your rating and feedback"}</b>
                                <div className="flex gap-2"><Lbl label={`Rating 1-${c.ratingScale}`}><input className="input w-24" type="number" min="1" max={c.ratingScale} required value={rate.rating} onChange={(e) => setRate({ ...rate, rating: e.target.value })} /></Lbl><div className="grow"><Lbl label="Comments"><textarea className="input" rows={3} required value={rate.comments} onChange={(e) => setRate({ ...rate, comments: e.target.value })} /></Lbl></div></div>
                                <button className="btn self-start" disabled={busy}>Submit</button>
                              </form>
                            )}
                            {r.canFinalise && r.status === "manager_submitted" && (
                              <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => post(`/api/v1/hr/performance/reviews/${r.id}/finalise`, { finalRating: Number(rate.final), ...(rate.outcome.trim() ? { outcome: rate.outcome.trim() } : {}) }), "Review finalised."); }}>
                                <Lbl label={`Final rating 1-${c.ratingScale}`}><input className="input w-24" type="number" min="1" max={c.ratingScale} required value={rate.final} onChange={(e) => setRate({ ...rate, final: e.target.value })} /></Lbl>
                                <Lbl label="Outcome"><input className="input" value={rate.outcome} onChange={(e) => setRate({ ...rate, outcome: e.target.value })} placeholder="Salary review, promotion, plan..." /></Lbl>
                                <button className="btn" disabled={busy}>Finalise</button>
                              </form>
                            )}
                          </div>
                        </div>
                      </td></tr>
                    )}
                  </>
                ))}
                {detail.reviews.length === 0 && <tr><td colSpan={6} className="muted">There is no review for you in this cycle.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

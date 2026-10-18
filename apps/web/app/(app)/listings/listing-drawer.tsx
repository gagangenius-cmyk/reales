"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export interface UnitOpt { id: string; label: string; listPrice: number | null; currency: string }
export interface AgentOpt { id: string; email: string }
export interface EditTarget { id: string; title: string; description: string; price: number | null; agentUserId: string | null }

const cap = "muted text-xs font-medium";

/** One drawer for both flows: create (pick a unit) and edit (title, description, price, agent). */
export function ListingDrawer({ mode, units = [], agents, target, canReassign = false }: { mode: "create" | "edit"; units?: UnitOpt[]; agents: AgentOpt[]; target?: EditTarget; canReassign?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [unitQ, setUnitQ] = useState("");
  const [f, setF] = useState({ unitId: "", purpose: "sale", title: target?.title ?? "", description: target?.description ?? "", price: target?.price != null ? String(target.price) : "", agentUserId: target?.agentUserId ?? "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const unit = units.find((u) => u.id === f.unitId);
  const shown = units.filter((u) => !unitQ || u.label.toLowerCase().includes(unitQ.toLowerCase())).slice(0, 8);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (f.price && !(Number(f.price) > 0)) return setMsg("Price must be above zero.");
    setBusy(true);
    let r;
    if (mode === "create") {
      if (!f.unitId) { setBusy(false); return setMsg("Choose the unit to list."); }
      r = await postJson("/api/v1/listings", { unitId: f.unitId, purpose: f.purpose, ...(f.title.trim() && { title: f.title.trim() }), ...(f.description.trim() && { description: f.description.trim() }), ...(f.price && { price: Number(f.price) }), ...(f.agentUserId && { agentUserId: f.agentUserId }) });
    } else {
      r = await postJson(`/api/v1/listings/${target!.id}`, { title: f.title.trim() || undefined, description: f.description.trim() || undefined, ...(f.price && { price: Number(f.price) }), ...(canReassign && f.agentUserId && f.agentUserId !== target?.agentUserId && { agentUserId: f.agentUserId }) }, "PATCH");
    }
    setBusy(false);
    if (!r.ok) return setMsg(errMsg(r));
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button className={mode === "create" ? "btn" : "btn-ghost text-xs"} onClick={() => { setOpen(true); setMsg(null); }}>{mode === "create" ? "+ Add listing" : "Edit"}</button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={mode === "create" ? "Add listing" : "Edit listing"}>
          <button className="absolute inset-0 bg-black/50" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} />
          <form onSubmit={submit} className="relative flex h-full w-full max-w-2xl flex-col shadow-2xl" style={{ background: "var(--bg)" }}>
            <header className="border-b px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <h2 className="text-xl font-semibold">{mode === "create" ? "Add listing" : "Edit listing"}</h2>
              <p className="muted text-sm">{mode === "create" ? "A listing starts as a draft. Add the permit and licence, then publish." : "Price changes are kept in the price history."}</p>
            </header>
            <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-6">
              {mode === "create" && (
                <section className="card p-4">
                  <h3 className="mb-3 font-semibold">1. Unit</h3>
                  {unit ? (
                    <div className="flex items-center justify-between rounded-lg border p-3" style={{ borderColor: "var(--border)" }}>
                      <span className="text-sm">{unit.label}</span><button type="button" className="btn-ghost text-xs" onClick={() => setF({ ...f, unitId: "" })}>Change</button>
                    </div>
                  ) : (
                    <>
                      <input className="input" placeholder="Search available units by number, building or community" value={unitQ} onChange={(e) => setUnitQ(e.target.value)} aria-label="Search units" autoFocus />
                      <ul className="mt-2 flex flex-col gap-1 text-sm">
                        {shown.map((u) => <li key={u.id}><button type="button" className="w-full rounded-lg border p-2.5 text-left hover:opacity-80" style={{ borderColor: "var(--border)" }} onClick={() => setF({ ...f, unitId: u.id, price: f.price || (u.listPrice ? String(u.listPrice) : "") })}>{u.label}</button></li>)}
                        {shown.length === 0 && <li className="muted p-2">No available units match. Add units under Inventory first.</li>}
                      </ul>
                    </>
                  )}
                </section>
              )}
              <section className="card grid gap-4 p-4 sm:grid-cols-2">
                <h3 className="font-semibold sm:col-span-2">{mode === "create" ? "2. Details" : "Details"}</h3>
                {mode === "create" && <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Purpose</span><select className="input" value={f.purpose} onChange={set("purpose")}><option value="sale">For sale</option><option value="rent">For rent</option></select></label>}
                <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Price {unit ? `(${unit.currency})` : ""}</span><input className="input" type="number" min="1" step="any" value={f.price} onChange={set("price")} placeholder={unit?.listPrice ? `Unit list price ${unit.listPrice.toLocaleString("en-US")}` : ""} /></label>
                <label className="flex flex-col gap-1.5 text-sm sm:col-span-2"><span className={cap}>Title (shown on portals)</span><input className="input" maxLength={255} value={f.title} onChange={set("title")} placeholder="Marina view 2BR, Tower A" /><span className="muted text-xs">{f.title.length}/255</span></label>
                <label className="flex flex-col gap-1.5 text-sm sm:col-span-2"><span className={cap}>Description</span><textarea className="input min-h-32" maxLength={10000} value={f.description} onChange={set("description")} /></label>
                {(mode === "create" || canReassign) && (
                  <label className="flex flex-col gap-1.5 text-sm sm:col-span-2"><span className={cap}>Listing agent</span>
                    <select className="input" value={f.agentUserId} onChange={set("agentUserId")} disabled={agents.length <= 1 && mode === "create"}>
                      {mode === "create" && agents.length !== 1 && <option value="">Me</option>}
                      {agents.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
                    </select>
                  </label>
                )}
              </section>
            </div>
            <footer className="flex items-center justify-between gap-3 border-t px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <p role="alert" className="err min-w-0 flex-1 text-sm">{msg}</p>
              <div className="flex gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn" disabled={busy}>{busy ? "Saving..." : mode === "create" ? "Create draft" : "Save"}</button></div>
            </footer>
          </form>
        </div>
      )}
    </>
  );
}

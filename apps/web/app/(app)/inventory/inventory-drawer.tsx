"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

type Kind = "unit" | "building" | "project" | "developer";
type Opt = { id: string; name: string };
const JURISDICTIONS: [string, string][] = [["DUBAI_MAINLAND", "Dubai (mainland)"], ["ABU_DHABI_MAINLAND", "Abu Dhabi (mainland)"], ["ADGM", "Abu Dhabi Global Market"]];
const TYPES = ["apartment", "villa", "townhouse", "penthouse", "office", "retail", "land"];
const TITLES: Record<Kind, string> = { unit: "Unit", building: "Building", project: "Project", developer: "Developer" };

const Lab = ({ t, children, span }: { t: string; children: React.ReactNode; span?: boolean }) => <label className={`flex flex-col gap-1.5 text-sm ${span ? "sm:col-span-2" : ""}`}><span className="muted text-xs font-medium">{t}</span>{children}</label>;

export function InventoryDrawer({ developers, projects, buildings }: { developers: Opt[]; projects: Opt[]; buildings: (Opt & { projectName: string })[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>(buildings.length ? "unit" : projects.length ? "building" : "project");
  const [f, setF] = useState<Record<string, string>>({ jurisdictionCode: "DUBAI_MAINLAND", currency: "AED", type: "apartment", projectKind: "ready" });
  const [escrow, setEscrow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const v = (k: string) => f[k] ?? "";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const num = (k: string) => (v(k) ? Number(v(k)) : undefined);
  const str = (k: string) => v(k).trim() || undefined;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    let url = "", body: Record<string, unknown> = {};
    if (kind === "developer") { url = "/api/v1/developers"; body = { name: v("name").trim(), jurisdictionCode: v("jurisdictionCode"), registrationNo: str("registrationNo"), escrowRegistered: escrow }; }
    if (kind === "project") { url = "/api/v1/real-estate-projects"; body = { name: v("name").trim(), jurisdictionCode: v("jurisdictionCode"), kind: v("projectKind"), developerId: str("developerId"), registrationNo: str("registrationNo"), escrowAccountRef: str("escrowAccountRef"), handoverDate: str("handoverDate") }; }
    if (kind === "building") { url = "/api/v1/buildings"; body = { reProjectId: v("reProjectId"), name: v("name").trim(), community: str("community"), city: str("city"), floorsCount: num("floorsCount") }; }
    if (kind === "unit") { url = "/api/v1/units"; body = { buildingId: v("buildingId"), unitNumber: v("unitNumber").trim(), type: v("type"), floor: num("floor"), bedrooms: num("bedrooms"), bathrooms: num("bathrooms"), areaSqft: num("areaSqft"), view: str("view"), listPrice: num("listPrice"), currency: v("currency") }; }
    if (!String(body.name ?? body.unitNumber ?? "").trim()) return setMsg({ ok: false, text: kind === "unit" ? "Enter the unit number." : "Enter a name." });
    if (kind === "building" && !body.reProjectId) return setMsg({ ok: false, text: "Choose the project this building belongs to." });
    if (kind === "unit" && !body.buildingId) return setMsg({ ok: false, text: "Choose the building." });
    body = Object.fromEntries(Object.entries(body).filter(([, x]) => x !== undefined && x !== ""));
    setBusy(true);
    const r = await postJson(url, body);
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    setMsg({ ok: true, text: `${TITLES[kind]} added.` });
    setF({ ...f, name: "", unitNumber: "", registrationNo: "" });
    router.refresh();
  }

  return (
    <>
      <button className="btn" onClick={() => { setOpen(true); setMsg(null); }}>+ Add to inventory</button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Add to inventory">
          <button className="absolute inset-0 bg-black/50" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} />
          <form onSubmit={submit} className="relative flex h-full w-full max-w-2xl flex-col shadow-2xl" style={{ background: "var(--bg)" }}>
            <header className="border-b px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <h2 className="text-xl font-semibold">Add to inventory</h2>
              <div className="mt-3 inline-flex rounded-lg border p-0.5 text-sm" style={{ borderColor: "var(--border)" }} role="tablist">
                {(["developer", "project", "building", "unit"] as Kind[]).map((k) => <button key={k} type="button" role="tab" aria-selected={kind === k} className={`rounded-md px-3 py-1.5 ${kind === k ? "btn" : ""}`} onClick={() => { setKind(k); setMsg(null); }}>{TITLES[k]}</button>)}
              </div>
            </header>
            <div className="flex-1 overflow-y-auto p-6">
              <section className="card grid gap-4 p-4 sm:grid-cols-2">
                {kind === "developer" && <>
                  <Lab t="Developer name" span><input className="input" value={v("name")} onChange={set("name")} autoFocus /></Lab>
                  <Lab t="Registration no."><input className="input" value={v("registrationNo")} onChange={set("registrationNo")} /></Lab>
                  <Lab t="Jurisdiction"><select className="input" value={v("jurisdictionCode")} onChange={set("jurisdictionCode")}>{JURISDICTIONS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></Lab>
                  <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={escrow} onChange={(e) => setEscrow(e.target.checked)} /> Escrow registered</label>
                </>}
                {kind === "project" && <>
                  <Lab t="Project name" span><input className="input" value={v("name")} onChange={set("name")} autoFocus /></Lab>
                  <Lab t="Type"><select className="input" value={v("projectKind")} onChange={set("projectKind")}><option value="ready">Ready (completed)</option><option value="off_plan">Off-plan</option></select></Lab>
                  <Lab t="Jurisdiction"><select className="input" value={v("jurisdictionCode")} onChange={set("jurisdictionCode")}>{JURISDICTIONS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></Lab>
                  <Lab t="Developer"><select className="input" value={v("developerId")} onChange={set("developerId")}><option value="">None</option>{developers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Lab>
                  <Lab t="Project registration no."><input className="input" value={v("registrationNo")} onChange={set("registrationNo")} /></Lab>
                  {v("projectKind") === "off_plan" && <>
                    <Lab t="Escrow account reference"><input className="input" value={v("escrowAccountRef")} onChange={set("escrowAccountRef")} /></Lab>
                    <Lab t="Handover date"><input className="input" type="date" value={v("handoverDate")} onChange={set("handoverDate")} /></Lab>
                  </>}
                </>}
                {kind === "building" && <>
                  <Lab t="Project" span><select className="input" value={v("reProjectId")} onChange={set("reProjectId")}><option value="">Choose...</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Lab>
                  <Lab t="Building name" span><input className="input" value={v("name")} onChange={set("name")} autoFocus /></Lab>
                  <Lab t="Community / area"><input className="input" value={v("community")} onChange={set("community")} placeholder="Dubai Marina" /></Lab>
                  <Lab t="City"><input className="input" value={v("city")} onChange={set("city")} placeholder="Dubai" /></Lab>
                  <Lab t="Floors"><input className="input" type="number" min="1" max="300" value={v("floorsCount")} onChange={set("floorsCount")} /></Lab>
                </>}
                {kind === "unit" && <>
                  <Lab t="Building" span><select className="input" value={v("buildingId")} onChange={set("buildingId")}><option value="">Choose...</option>{buildings.map((b) => <option key={b.id} value={b.id}>{b.name} - {b.projectName}</option>)}</select></Lab>
                  <Lab t="Unit number"><input className="input" value={v("unitNumber")} onChange={set("unitNumber")} autoFocus /></Lab>
                  <Lab t="Type"><select className="input" value={v("type")} onChange={set("type")}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></Lab>
                  <Lab t="Floor"><input className="input" type="number" value={v("floor")} onChange={set("floor")} /></Lab>
                  <Lab t="View"><input className="input" value={v("view")} onChange={set("view")} placeholder="Marina, Sea, Burj" /></Lab>
                  <Lab t="Bedrooms"><input className="input" type="number" min="0" max="20" value={v("bedrooms")} onChange={set("bedrooms")} /></Lab>
                  <Lab t="Bathrooms"><input className="input" type="number" min="0" max="20" value={v("bathrooms")} onChange={set("bathrooms")} /></Lab>
                  <Lab t="Area (sqft)"><input className="input" type="number" min="1" step="any" value={v("areaSqft")} onChange={set("areaSqft")} /></Lab>
                  <Lab t="List price"><input className="input" type="number" min="1" step="any" value={v("listPrice")} onChange={set("listPrice")} /></Lab>
                  <Lab t="Currency"><select className="input" value={v("currency")} onChange={set("currency")}><option>AED</option><option>USD</option><option>EUR</option><option>GBP</option></select></Lab>
                </>}
              </section>
            </div>
            <footer className="flex items-center justify-between gap-3 border-t px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <p role={msg?.ok ? "status" : "alert"} className={`min-w-0 flex-1 text-sm ${msg?.ok ? "muted" : "err"}`}>{msg?.text}</p>
              <div className="flex gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Close</button><button className="btn" disabled={busy}>{busy ? "Saving..." : `Add ${TITLES[kind].toLowerCase()}`}</button></div>
            </footer>
          </form>
        </div>
      )}
    </>
  );
}

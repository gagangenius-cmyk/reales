"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LazyMap } from "@/components/map-lazy";
import { errMsg, postJson } from "@/lib/client";

export interface UnitOpt { id: string; label: string; listPrice: number | null; currency: string }
export interface AgentOpt { id: string; email: string }
export interface AmenityOpt { code: string; label: string; group: string }
export interface AmenityGroup { key: string; label: string }
export interface LocOpt { emirate: string; community: string; subCommunity: string | null; latitude: number | null; longitude: number | null }
export interface TypeOpt { value: string; label: string; category: string }
export interface EditTarget { id: string; title: string; description: string; price: number | null; agentUserId: string | null }

const cap = "muted text-xs font-medium";

/** One drawer for both flows: create (pick a unit) and edit (title, description, price, agent). */
export function ListingDrawer({ mode, units = [], agents, target, canReassign = false, amenities = [], groups = [], locations = [], emirates = [], types = [] }: { mode: "create" | "edit"; units?: UnitOpt[]; agents: AgentOpt[]; target?: EditTarget; canReassign?: boolean; amenities?: AmenityOpt[]; groups?: AmenityGroup[]; locations?: LocOpt[]; emirates?: string[]; types?: TypeOpt[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [unitQ, setUnitQ] = useState("");
  const [f, setF] = useState({ unitId: "", purpose: "sale", title: target?.title ?? "", description: target?.description ?? "", price: target?.price != null ? String(target.price) : "", agentUserId: target?.agentUserId ?? "" });
  const [x, setX] = useState({ titleAr: "", descriptionAr: "", furnishing: "", parkingSpaces: "", rentFrequency: "yearly", cheques: "", securityDeposit: "", serviceCharge: "", ownerPrice: "", commissionPct: "", exclusivity: "none", agreementStartsOn: "", agreementExpiresOn: "", videoUrl: "", virtualTourUrl: "", featured: false });
  const [src, setSrc] = useState<"new" | "existing">("new");
  const [p, setP] = useState({ emirate: "Dubai", community: "", communityOther: "", subCommunity: "", subOther: "", buildingName: "", unitNumber: "", type: "apartment", bedrooms: "", bathrooms: "", bua: "", plot: "", floor: "", view: "", completion: "ready", ownership: "", yearBuilt: "", lat: "", lng: "" });
  const setp = (k: keyof typeof p) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setP({ ...p, [k]: e.target.value });
  const OTHER = "__other";
  const communities = [...new Set(locations.filter((l) => l.emirate === p.emirate).map((l) => l.community))].sort();
  const subs = [...new Set(locations.filter((l) => l.emirate === p.emirate && l.community === p.community && l.subCommunity).map((l) => l.subCommunity!))].sort();
  const communityName = p.community === OTHER ? p.communityOther.trim() : p.community, subName = p.subCommunity === OTHER ? p.subOther.trim() : p.subCommunity;
  const centre = locations.find((l) => l.emirate === p.emirate && l.community === communityName && !l.subCommunity && l.latitude != null);
  const typeInfo = types.find((t) => t.value === p.type);
  const noBeds = ["office", "retail", "showroom", "warehouse", "factory", "labour_camp", "land", "farm", "whole_building", "bulk_units", "compound"].includes(p.type);
  const pps = Number(f.price) > 0 && Number(p.bua) > 0 ? Math.round(Number(f.price) / Number(p.bua)) : null;
  const [features, setFeatures] = useState<Set<string>>(new Set());
  const [photos, setPhotos] = useState<File[]>([]);
  const [plans, setPlans] = useState<File[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const setx = (k: keyof typeof x) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setX({ ...x, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value });
  const toggleFeature = (c: string) => setFeatures((cur) => { const n = new Set(cur); if (n.has(c)) n.delete(c); else n.add(c); return n; });
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
      if (src === "existing" && !f.unitId) { setBusy(false); return setMsg("Choose the unit to list."); }
      if (src === "new") {
        if (!communityName || !p.buildingName.trim() || !p.unitNumber.trim()) { setBusy(false); return setMsg("Choose the community and enter the building and unit number."); }
        if (!(Number(f.price) > 0) || !(Number(p.bua) > 0)) { setBusy(false); return setMsg("Enter the price and the built-up area (BUA)."); }
        if (!noBeds && p.type !== "studio" && p.bedrooms === "") { setBusy(false); return setMsg("Enter the number of bedrooms."); }
        if ((p.lat === "") !== (p.lng === "")) { setBusy(false); return setMsg("Give both latitude and longitude, or leave both empty."); }
      }
      if (x.agreementStartsOn && x.agreementExpiresOn && x.agreementExpiresOn < x.agreementStartsOn) { setBusy(false); return setMsg("The agreement cannot end before it starts."); }
      const num = (v: string) => (v === "" ? null : Number(v));
      r = src === "new"
        ? await postJson("/api/v1/listings/property", { emirate: p.emirate, community: communityName, ...(subName ? { subCommunity: subName } : {}), buildingName: p.buildingName.trim(), unitNumber: p.unitNumber.trim(), type: p.type, purpose: f.purpose, price: Number(f.price), bedrooms: p.type === "studio" ? 0 : noBeds ? null : num(p.bedrooms), bathrooms: num(p.bathrooms), builtUpAreaSqft: Number(p.bua), plotAreaSqft: num(p.plot), floor: num(p.floor), view: p.view.trim() || null, completionStatus: p.completion, ownership: p.ownership || null, yearBuilt: num(p.yearBuilt), latitude: num(p.lat), longitude: num(p.lng), ...(f.title.trim() && { title: f.title.trim() }), ...(f.description.trim() && { description: f.description.trim() }), ...(f.agentUserId && { agentUserId: f.agentUserId }) })
        : await postJson("/api/v1/listings", { unitId: f.unitId, purpose: f.purpose, ...(f.title.trim() && { title: f.title.trim() }), ...(f.description.trim() && { description: f.description.trim() }), ...(f.price && { price: Number(f.price) }), ...(f.agentUserId && { agentUserId: f.agentUserId }) });
      if (r.ok) {
        const id = r.data.id as string, n = (v: string) => (v === "" ? undefined : Number(v));
        const rent = f.purpose === "rent";
        const details = {
          ...(x.titleAr.trim() && { titleAr: x.titleAr.trim() }), ...(x.descriptionAr.trim() && { descriptionAr: x.descriptionAr.trim() }), ...(features.size && { features: [...features] }),
          ...(x.furnishing && { furnishing: x.furnishing }), ...(n(x.parkingSpaces) !== undefined && { parkingSpaces: n(x.parkingSpaces) }),
          ...(rent && { rentFrequency: x.rentFrequency, ...(n(x.cheques) !== undefined && { cheques: n(x.cheques) }), ...(n(x.securityDeposit) !== undefined && { securityDeposit: n(x.securityDeposit) }) }),
          ...(n(x.serviceCharge) !== undefined && { serviceCharge: n(x.serviceCharge) }), ...(n(x.ownerPrice) && { ownerPrice: n(x.ownerPrice) }), ...(n(x.commissionPct) !== undefined && { commissionPct: n(x.commissionPct) }),
          ...(x.exclusivity !== "none" && { exclusivity: x.exclusivity }), ...(x.agreementStartsOn && { agreementStartsOn: x.agreementStartsOn }), ...(x.agreementExpiresOn && { agreementExpiresOn: x.agreementExpiresOn }),
          ...(x.videoUrl.trim() && { videoUrl: x.videoUrl.trim() }), ...(x.virtualTourUrl.trim() && { virtualTourUrl: x.virtualTourUrl.trim() }), ...(x.featured && { featured: true }),
        };
        const problems: string[] = [];
        if (Object.keys(details).length) { const d = await postJson(`/api/v1/listings/${id}/details`, details, "PUT"); if (!d.ok) problems.push(`Details: ${errMsg(d)}`); }
        const files = [...photos.map((file) => ({ file, kind: "image" })), ...plans.map((file) => ({ file, kind: "floorplan" }))];
        for (let i = 0; i < files.length; i++) {
          setProgress(`Uploading ${i + 1} of ${files.length}...`);
          const fd = new FormData(); fd.append("file", files[i]!.file); fd.append("kind", files[i]!.kind);
          const up = await fetch(`/api/v1/listings/${id}/media/upload`, { method: "POST", body: fd, headers: { "idempotency-key": crypto.randomUUID() } });
          if (!up.ok) { let m = "upload failed"; try { m = (await up.json()).error?.message ?? m; } catch { /* not json */ } problems.push(`${files[i]!.file.name}: ${m}`); }
        }
        setProgress(null); setBusy(false);
        if (problems.length) return setMsg(`Listing created, but: ${problems.slice(0, 3).join(" | ")}. Finish it on the listing page.`);
        setOpen(false); router.push(`/listings/${id}`); return;
      }
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
          <form onSubmit={submit} className="relative flex h-full w-full max-w-3xl flex-col shadow-2xl" style={{ background: "var(--bg)" }}>
            <header className="border-b px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <h2 className="text-xl font-semibold">{mode === "create" ? "Add listing" : "Edit listing"}</h2>
              <p className="muted text-sm">{mode === "create" ? "Everything here can be changed later. A listing starts as a draft; add the permit and licence on its page, then publish." : "Price changes are kept in the price history."}</p>
            </header>
            <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-6">
              {mode === "create" && (
                <section className="card flex flex-col gap-4 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">1. Property</h3>
                    {units.length > 0 && <div className="inline-flex rounded-lg border p-0.5 text-sm" style={{ borderColor: "var(--border)" }}><button type="button" className={`rounded-md px-3 py-1 ${src === "new" ? "btn" : ""}`} onClick={() => setSrc("new")}>New property</button><button type="button" className={`rounded-md px-3 py-1 ${src === "existing" ? "btn" : ""}`} onClick={() => setSrc("existing")}>Existing unit</button></div>}
                  </div>
                  {src === "existing" ? (
                    <div>
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
                    </div>
                  ) : (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Country</span><select className="input" disabled><option>United Arab Emirates</option></select></label>
                      <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Emirate (city)</span><select className="input" value={p.emirate} onChange={(e) => setP({ ...p, emirate: e.target.value, community: "", subCommunity: "" })}>{emirates.map((x) => <option key={x}>{x}</option>)}</select></label>
                      <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Location (community)</span>
                        <select className="input" value={p.community} onChange={(e) => setP({ ...p, community: e.target.value, subCommunity: "" })}><option value="">Select a location</option>{communities.map((c) => <option key={c}>{c}</option>)}<option value={OTHER}>Other (type it)...</option></select>
                        {p.community === OTHER && <input className="input" placeholder="Community name" value={p.communityOther} onChange={setp("communityOther")} />}</label>
                      <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Sub location</span>
                        <select className="input" value={p.subCommunity} onChange={setp("subCommunity")}><option value="">None</option>{subs.map((c) => <option key={c}>{c}</option>)}<option value={OTHER}>Other (type it)...</option></select>
                        {p.subCommunity === OTHER && <input className="input" placeholder="Sub-community name" value={p.subOther} onChange={setp("subOther")} />}</label>
                      <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Building / tower / project name</span><input className="input" maxLength={180} value={p.buildingName} onChange={setp("buildingName")} placeholder="Marina Gate 1" /></label>
                      <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Unit number</span><input className="input" maxLength={40} value={p.unitNumber} onChange={setp("unitNumber")} placeholder="2304" /></label>
                      <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Property type</span>
                        <select className="input" value={p.type} onChange={setp("type")}>{["residential", "commercial", "land"].map((c) => <optgroup key={c} label={c[0]!.toUpperCase() + c.slice(1)}>{types.filter((t) => t.category === c).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</optgroup>)}</select></label>
                      <div className="flex flex-col justify-end gap-1 text-sm"><span className={cap}>Category</span><b className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--border)" }}>{typeInfo ? typeInfo.category[0]!.toUpperCase() + typeInfo.category.slice(1) : "-"}</b></div>
                      {!noBeds && p.type !== "studio" && <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Bedrooms</span><input className="input" type="number" min="0" max="30" value={p.bedrooms} onChange={setp("bedrooms")} /></label>}
                      {!["land", "farm"].includes(p.type) && <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Bathrooms</span><input className="input" type="number" min="0" max="30" value={p.bathrooms} onChange={setp("bathrooms")} /></label>}
                      <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>BUA: built-up area (sqft)</span><input className="input" type="number" min="1" step="any" value={p.bua} onChange={setp("bua")} /></label>
                      <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Plot area (sqft)</span><input className="input" type="number" min="1" step="any" value={p.plot} onChange={setp("plot")} /></label>
                      <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Floor</span><input className="input" type="number" min="-5" max="200" value={p.floor} onChange={setp("floor")} /></label>
                      <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>View</span><input className="input" maxLength={80} value={p.view} onChange={setp("view")} placeholder="Sea view, Burj Khalifa view..." /></label>
                      <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Completion status</span><select className="input" value={p.completion} onChange={setp("completion")}><option value="ready">Ready</option><option value="off_plan">Off-plan</option></select></label>
                      <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Ownership</span><select className="input" value={p.ownership} onChange={setp("ownership")}><option value="">Not stated</option><option value="freehold">Freehold</option><option value="leasehold">Leasehold</option><option value="usufruct">Usufruct</option><option value="musataha">Musataha</option></select></label>
                      <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Year built</span><input className="input" type="number" min="1900" max="2100" value={p.yearBuilt} onChange={setp("yearBuilt")} /></label>
                      <div className="flex flex-col gap-2 sm:col-span-2">
                        <span className={cap}>Map pin (optional): click the map or drag the pin. Without one, the community centre is used.</span>
                        <div className="grid gap-3 sm:grid-cols-2"><input className="input" type="number" step="any" placeholder="Latitude" value={p.lat} onChange={setp("lat")} /><input className="input" type="number" step="any" placeholder="Longitude" value={p.lng} onChange={setp("lng")} /></div>
                        <LazyMap pins={centre && p.lat === "" ? [{ id: "c", lat: centre.latitude!, lng: centre.longitude!, title: communityName, label: "", precise: false }] : []} height={260} zoomOnSingle={13} picked={p.lat !== "" && p.lng !== "" ? { lat: Number(p.lat), lng: Number(p.lng) } : null} onPick={(lat, lng) => setP((cur) => ({ ...cur, lat: String(lat), lng: String(lng) }))} />
                      </div>
                    </div>
                  )}
                </section>
              )}
              <section className="card grid gap-4 p-4 sm:grid-cols-2">
                <h3 className="font-semibold sm:col-span-2">{mode === "create" ? "2. Details" : "Details"}</h3>
                {mode === "create" && <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Purpose</span><select className="input" value={f.purpose} onChange={set("purpose")}><option value="sale">For sale</option><option value="rent">For rent</option></select></label>}
                <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Price {unit ? `(${unit.currency})` : "(AED)"}</span><input className="input" type="number" min="1" step="any" value={f.price} onChange={set("price")} placeholder={unit?.listPrice ? `Unit list price ${unit.listPrice.toLocaleString("en-US")}` : ""} />{mode === "create" && src === "new" && <span className="muted text-xs">{pps ? `AED ${pps.toLocaleString("en-US")} per sqft${f.purpose === "rent" ? " per year" : ""}` : "Price per sqft is worked out from the price and the BUA"}</span>}</label>
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
              {mode === "create" && (
                <>
                  <section className="card grid gap-4 p-4 sm:grid-cols-2">
                    <h3 className="font-semibold sm:col-span-2">3. Terms and ownership</h3>
                    {f.purpose === "rent" && (
                      <>
                        <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Rent is paid</span><select className="input" value={x.rentFrequency} onChange={setx("rentFrequency")}><option value="yearly">Per year</option><option value="quarterly">Per quarter</option><option value="monthly">Per month</option></select></label>
                        <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Number of cheques</span><input className="input" type="number" min="1" max="12" value={x.cheques} onChange={setx("cheques")} /></label>
                        <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Security deposit</span><input className="input" type="number" min="0" step="any" value={x.securityDeposit} onChange={setx("securityDeposit")} /></label>
                      </>
                    )}
                    <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Service charge (per sqft per year)</span><input className="input" type="number" min="0" step="any" value={x.serviceCharge} onChange={setx("serviceCharge")} /></label>
                    <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Furnishing</span><select className="input" value={x.furnishing} onChange={setx("furnishing")}><option value="">Not stated</option><option value="unfurnished">Unfurnished</option><option value="semi_furnished">Semi-furnished</option><option value="furnished">Furnished</option></select></label>
                    <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Parking spaces</span><input className="input" type="number" min="0" max="50" value={x.parkingSpaces} onChange={setx("parkingSpaces")} /></label>
                    <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Owner asking price (internal)</span><input className="input" type="number" min="0" step="any" value={x.ownerPrice} onChange={setx("ownerPrice")} /></label>
                    <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Commission %</span><input className="input" type="number" min="0" max="100" step="any" value={x.commissionPct} onChange={setx("commissionPct")} /></label>
                    <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Exclusivity</span><select className="input" value={x.exclusivity} onChange={setx("exclusivity")}><option value="none">None</option><option value="exclusive">Exclusive</option><option value="non_exclusive">Non-exclusive</option></select></label>
                    <span />
                    {x.exclusivity !== "none" && (
                      <>
                        <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Agreement starts</span><input className="input" type="date" value={x.agreementStartsOn} onChange={setx("agreementStartsOn")} /></label>
                        <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Agreement ends</span><input className="input" type="date" value={x.agreementExpiresOn} onChange={setx("agreementExpiresOn")} /></label>
                      </>
                    )}
                    <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={x.featured} onChange={setx("featured")} />Feature this listing</label>
                  </section>
                  <section className="card grid gap-4 p-4 sm:grid-cols-2">
                    <h3 className="font-semibold sm:col-span-2">4. Arabic copy and media links</h3>
                    <label className="flex flex-col gap-1.5 text-sm sm:col-span-2"><span className={cap}>Title in Arabic</span><input className="input" dir="rtl" maxLength={255} value={x.titleAr} onChange={setx("titleAr")} /></label>
                    <label className="flex flex-col gap-1.5 text-sm sm:col-span-2"><span className={cap}>Description in Arabic</span><textarea className="input min-h-24" dir="rtl" maxLength={10000} value={x.descriptionAr} onChange={setx("descriptionAr")} /></label>
                    <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Video link</span><input className="input" type="url" maxLength={300} value={x.videoUrl} onChange={setx("videoUrl")} placeholder="https://youtube.com/..." /></label>
                    <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Virtual tour link</span><input className="input" type="url" maxLength={300} value={x.virtualTourUrl} onChange={setx("virtualTourUrl")} /></label>
                  </section>
                  {amenities.length > 0 && (
                    <section className="card p-4">
                      <h3 className="mb-3 font-semibold">5. Features and amenities <span className="muted text-xs font-normal">({features.size} selected)</span></h3>
                      {groups.map((g) => (
                        <fieldset key={g.key} className="mb-3"><legend className="muted mb-1 text-xs font-medium">{g.label}</legend>
                          <div className="flex flex-wrap gap-2">{amenities.filter((a) => a.group === g.key).map((a) => <label key={a.code} className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${features.has(a.code) ? "btn" : ""}`} style={{ borderColor: "var(--border)" }}><input type="checkbox" className="sr-only" checked={features.has(a.code)} onChange={() => toggleFeature(a.code)} />{a.label}</label>)}</div>
                        </fieldset>
                      ))}
                    </section>
                  )}
                  <section className="card grid gap-4 p-4 sm:grid-cols-2">
                    <h3 className="font-semibold sm:col-span-2">6. Photos and floor plans</h3>
                    <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Photos (JPEG, PNG or WEBP; the first is the cover)</span><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => setPhotos(Array.from(e.target.files ?? []))} /><span className="muted text-xs">{photos.length ? `${photos.length} selected` : "Optional now, can be added later"}</span></label>
                    <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Floor plans</span><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => setPlans(Array.from(e.target.files ?? []))} /><span className="muted text-xs">{plans.length ? `${plans.length} selected` : "Optional"}</span></label>
                  </section>
                </>
              )}
            </div>
            <footer className="flex items-center justify-between gap-3 border-t px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
              <p role="alert" className="err min-w-0 flex-1 text-sm">{msg}</p>
              <div className="flex gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn" disabled={busy}>{busy ? (progress ?? "Saving...") : mode === "create" ? "Create and open" : "Save"}</button></div>
            </footer>
          </form>
        </div>
      )}
    </>
  );
}

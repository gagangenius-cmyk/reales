"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LazyMap } from "@/components/map-lazy";
import { errMsg, postJson } from "@/lib/client";

const cap = "muted text-xs font-medium";

/** Where the property is, on a map, and the facts portals ask for. A pin set here overrides the building and community positions everywhere (website, portals, map view). */
export function LocationTab({ l, canManage }: { l: any; canManage: boolean }) {
  const router = useRouter();
  const b = l.building ?? {}, u = l.unit ?? {};
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [v, setV] = useState({
    lat: l.latitude != null ? String(Number(l.latitude)) : "", lng: l.longitude != null ? String(Number(l.longitude)) : "", completionStatus: l.completionStatus ?? "", ownership: l.ownership ?? "", yearBuilt: l.yearBuilt != null ? String(l.yearBuilt) : "",
    availableFrom: l.availableFrom ? String(l.availableFrom).slice(0, 10) : "", utilities: l.utilitiesIncluded == null ? "" : l.utilitiesIncluded ? "yes" : "no",
  });
  const fallback = b.latitude != null && b.longitude != null ? { lat: Number(b.latitude), lng: Number(b.longitude), precise: true } : b.locationLat != null ? { lat: Number(b.locationLat), lng: Number(b.locationLng), precise: false } : null;
  const has = v.lat !== "" && v.lng !== "";
  const pin = has ? { lat: Number(v.lat), lng: Number(v.lng) } : null;
  const area = u.areaSqft ? Number(u.areaSqft) : null, price = l.price ? Number(l.price) : null;
  const n = (s: string) => (s === "" ? null : Number(s));
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    if ((v.lat === "") !== (v.lng === "")) { setBusy(false); return setMsg({ ok: false, text: "Give both latitude and longitude, or clear both." }); }
    const r = await postJson(`/api/v1/listings/${l.id}/details`, { latitude: n(v.lat), longitude: n(v.lng), completionStatus: v.completionStatus || null, ownership: v.ownership || null, yearBuilt: n(v.yearBuilt), availableFrom: v.availableFrom || null, utilitiesIncluded: v.utilities === "" ? null : v.utilities === "yes" }, "PUT");
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    setMsg({ ok: true, text: "Saved." }); router.refresh();
  }
  return (
    <form onSubmit={save} className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <div className="flex flex-col gap-3">
        <LazyMap height={420} zoomOnSingle={15}
          pins={!pin && fallback ? [{ id: "f", lat: fallback.lat, lng: fallback.lng, title: b.name ?? "Property", label: "", precise: fallback.precise }] : []}
          picked={pin} onPick={canManage ? (lat, lng) => setV((c) => ({ ...c, lat: String(lat), lng: String(lng) })) : undefined} />
        <p className="muted text-xs">{canManage ? "Click the map or drag the pin to set the exact position." : "Exact position of the property."} {!pin && fallback && !fallback.precise && "No exact pin yet: the website and portals use the community centre."}</p>
        {canManage && (
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Latitude</span><input className="input" inputMode="decimal" value={v.lat} onChange={(e) => setV({ ...v, lat: e.target.value })} /></label>
            <label className="flex flex-col gap-1.5 text-sm"><span className={cap}>Longitude</span><input className="input" inputMode="decimal" value={v.lng} onChange={(e) => setV({ ...v, lng: e.target.value })} /></label>
            <div className="flex items-end gap-2"><button type="button" className="btn-ghost" onClick={() => setV({ ...v, lat: "", lng: "" })} disabled={!has}>Clear pin</button>{pin && <a className="btn-ghost" target="_blank" rel="noopener noreferrer" href={`https://www.google.com/maps?q=${pin.lat},${pin.lng}`}>Open in Google Maps</a>}</div>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-4">
        <section className="card p-4 text-sm"><h2 className="mb-2 font-semibold">Location</h2>
          <dl className="grid grid-cols-2 gap-2">
            <div><dt className="muted text-xs">Country</dt><dd>{b.country === "AE" || !b.country ? "United Arab Emirates" : b.country}</dd></div><div><dt className="muted text-xs">Emirate</dt><dd>{b.city ?? "-"}</dd></div>
            <div><dt className="muted text-xs">Location</dt><dd>{b.community ?? "-"}</dd></div><div><dt className="muted text-xs">Sub location</dt><dd>{b.subCommunity ?? "-"}</dd></div>
            <div><dt className="muted text-xs">Building</dt><dd>{b.name ?? "-"}</dd></div><div><dt className="muted text-xs">Unit</dt><dd>{u.unitNumber ?? "-"}{u.floor != null ? `, floor ${u.floor}` : ""}</dd></div>
            <div><dt className="muted text-xs">Type</dt><dd>{String(u.type ?? "-").replace(/_/g, " ")}</dd></div><div><dt className="muted text-xs">BUA</dt><dd>{area ? `${area.toLocaleString("en-US")} sqft` : "-"}</dd></div>
            <div><dt className="muted text-xs">Plot</dt><dd>{u.plotAreaSqft ? `${Number(u.plotAreaSqft).toLocaleString("en-US")} sqft` : "-"}</dd></div><div><dt className="muted text-xs">Price per sqft</dt><dd>{area && price ? `${l.currency} ${Math.round(price / area).toLocaleString("en-US")}` : "-"}</dd></div>
          </dl>
        </section>
        <section className="card grid gap-3 p-4 text-sm"><h2 className="font-semibold">Property facts for portals</h2>
          <label className="flex flex-col gap-1.5"><span className={cap}>Completion status</span><select className="input" value={v.completionStatus} onChange={(e) => setV({ ...v, completionStatus: e.target.value })} disabled={!canManage}><option value="">From the project</option><option value="ready">Ready</option><option value="off_plan">Off-plan</option></select></label>
          <label className="flex flex-col gap-1.5"><span className={cap}>Ownership</span><select className="input" value={v.ownership} onChange={(e) => setV({ ...v, ownership: e.target.value })} disabled={!canManage}><option value="">Not stated</option><option value="freehold">Freehold</option><option value="leasehold">Leasehold</option><option value="usufruct">Usufruct</option><option value="musataha">Musataha</option></select></label>
          <label className="flex flex-col gap-1.5"><span className={cap}>Year built</span><input className="input" type="number" min="1900" max="2100" value={v.yearBuilt} onChange={(e) => setV({ ...v, yearBuilt: e.target.value })} disabled={!canManage} /></label>
          <label className="flex flex-col gap-1.5"><span className={cap}>Available from</span><input className="input" type="date" value={v.availableFrom} onChange={(e) => setV({ ...v, availableFrom: e.target.value })} disabled={!canManage} /></label>
          <label className="flex flex-col gap-1.5"><span className={cap}>Utilities included</span><select className="input" value={v.utilities} onChange={(e) => setV({ ...v, utilities: e.target.value })} disabled={!canManage}><option value="">Not stated</option><option value="yes">Yes</option><option value="no">No</option></select></label>
        </section>
        {canManage && <div className="flex items-center gap-3"><button className="btn" disabled={busy}>{busy ? "Saving..." : "Save location and facts"}</button>{msg && <span role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "muted" : "err"}`}>{msg.text}</span>}</div>}
      </div>
    </form>
  );
}

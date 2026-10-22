"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LocationTab } from "./location-tab";
import { DeleteButton } from "@/components/delete-button";
import { errMsg, postJson } from "@/lib/client";

type L = any;
interface Props { l: L; channels: any[]; amenities: { code: string; label: string; group: string }[]; groups: { key: string; label: string }[]; canManage: boolean; canPublish: boolean; site: { slug: string; enabled: boolean } | null }
const TABS = ["Overview", "Location and map", "Photos and plans", "Amenities", "Distribution", "Price and compliance", "Activity"] as const;
const money = (v: unknown, c = "AED") => (v == null || v === "" ? "-" : `${c} ${Number(v).toLocaleString("en-US")}`);
const dt = (v: unknown) => (v ? new Date(v as string).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" }) : "-");
const lab = "flex flex-col gap-1.5 text-sm";
const cap = "muted text-xs font-medium";
const tone: Record<string, string> = { live: "badge-ok", "in feed": "badge-ok", queued: "badge-warn", retry: "badge-warn", failed: "badge-danger", removed: "badge-gray", pending: "badge-gray", off: "badge-gray" };

export function ListingWorkspace({ l, channels, amenities, groups, canManage, canPublish, site }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ok = (text: string) => setMsg({ ok: true, text });
  const bad = (text: string) => setMsg({ ok: false, text });
  async function act(p: Promise<{ ok: boolean; data: any; status: number }>, done: string, then?: (d: any) => void) {
    setBusy(true); setMsg(null);
    const r = await p;
    setBusy(false);
    if (!r.ok) { if (r.status === 422 && r.data?.error?.evaluation) return bad(r.data.error.evaluation.issues.map((i: any) => i.message).join(" ")); return bad(errMsg(r as any)); }
    ok(done); then?.(r.data); router.refresh();
  }
  const u = l.unit ?? {}, b = l.building ?? {};
  const q = l.quality;
  const images = l.media.filter((m: any) => m.kind === "image"), plans = l.media.filter((m: any) => m.kind === "floorplan");
  const publicUrl = site && l.shareToken && l.reference ? `/p/${site.slug}/${l.reference}` : null;

  // ---- overview form
  const [f, setF] = useState({
    title: l.title ?? "", description: l.description ?? "", titleAr: l.titleAr ?? "", descriptionAr: l.descriptionAr ?? "", price: l.price ? String(Number(l.price)) : "", ownerPrice: l.ownerPrice ? String(Number(l.ownerPrice)) : "", commissionPct: l.commissionPct ? String(Number(l.commissionPct)) : "",
    furnishing: l.furnishing ?? "", parkingSpaces: l.parkingSpaces != null ? String(l.parkingSpaces) : "", rentFrequency: l.rentFrequency ?? "", cheques: l.cheques != null ? String(l.cheques) : "", securityDeposit: l.securityDeposit ? String(Number(l.securityDeposit)) : "", serviceCharge: l.serviceCharge ? String(Number(l.serviceCharge)) : "",
    exclusivity: l.exclusivity ?? "none", agreementStartsOn: l.agreementStartsOn ?? "", agreementExpiresOn: l.agreementExpiresOn ?? "", expiresOn: l.expiresOn ?? "", latitude: l.latitude != null ? String(Number(l.latitude)) : "", longitude: l.longitude != null ? String(Number(l.longitude)) : "",
    videoUrl: l.videoUrl ?? "", virtualTourUrl: l.virtualTourUrl ?? "", featured: !!l.featured,
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const n = (v: string) => (v === "" ? null : Number(v));
  const saveOverview = (e: React.FormEvent) => {
    e.preventDefault();
    return act(postJson(`/api/v1/listings/${l.id}/details`, {
      title: f.title || null, description: f.description || null, titleAr: f.titleAr || null, descriptionAr: f.descriptionAr || null, price: n(f.price), ownerPrice: n(f.ownerPrice), commissionPct: n(f.commissionPct),
      furnishing: f.furnishing || null, parkingSpaces: n(f.parkingSpaces), rentFrequency: l.purpose === "rent" ? f.rentFrequency || null : null, cheques: l.purpose === "rent" ? n(f.cheques) : null, securityDeposit: l.purpose === "rent" ? n(f.securityDeposit) : null, serviceCharge: n(f.serviceCharge),
      exclusivity: f.exclusivity, agreementStartsOn: f.agreementStartsOn || null, agreementExpiresOn: f.agreementExpiresOn || null, expiresOn: f.expiresOn || null, latitude: n(f.latitude), longitude: n(f.longitude),
      videoUrl: f.videoUrl || null, virtualTourUrl: f.virtualTourUrl || null, featured: f.featured,
    }, "PUT"), "Saved.");
  };

  // ---- amenities
  const [feat, setFeat] = useState<string[]>(l.features ?? []);
  // ---- uploads
  const fileRef = useRef<HTMLInputElement>(null), planRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  async function upload(files: FileList | null, kind: "image" | "floorplan") {
    if (!files?.length) return;
    setMsg(null);
    let done = 0; const errors: string[] = [];
    for (const file of Array.from(files)) {
      setUploading(`${file.name} (${done + 1}/${files.length})`);
      const fd = new FormData(); fd.set("file", file); fd.set("kind", kind);
      const r = await fetch(`/api/v1/listings/${l.id}/media/upload`, { method: "POST", body: fd, headers: { "idempotency-key": crypto.randomUUID() } });
      if (r.ok) done++; else errors.push(`${file.name}: ${(await r.json().catch(() => null))?.error?.message ?? "failed"}`);
    }
    setUploading(null);
    if (errors.length) bad(errors.slice(0, 3).join(" | ")); else ok(`${done} file(s) uploaded.`);
    router.refresh();
  }
  const move = (list: any[], i: number, d: number) => { const ids = list.map((m) => m.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j]!, ids[i]!]; return act(postJson(`/api/v1/listings/${l.id}/media/order`, { ids: [...ids, ...l.media.filter((m: any) => !ids.includes(m.id)).map((m: any) => m.id)] }, "PUT"), "Order saved."); };

  // ---- permit form
  const [permit, setPermit] = useState({ permitNo: "", authority: "DLD_TRAKHEESI", expiresAt: "" });

  return (
    <div className="flex flex-col gap-4">
      <header className="card flex flex-wrap items-start justify-between gap-4 p-5">
        <div className="min-w-0">
          <p className="muted text-xs">{l.reference} &middot; {l.purpose === "sale" ? "For sale" : "For rent"} &middot; {l.jurisdictionCode}</p>
          <h1 className="text-xl font-semibold">{l.title || "(untitled)"}</h1>
          <p className="muted text-sm">{[u.unitNumber && `Unit ${u.unitNumber}`, b.name, b.community, b.city].filter(Boolean).join(", ")}</p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm"><b>{money(l.price, l.currency)}</b><span className={`badge ${l.status === "published" ? "badge-ok" : l.status === "draft" || l.status === "expired" ? "badge-warn" : "badge-gray"}`}>{l.status}</span>{l.featured && <span className="badge">featured</span>}<span className="muted">{l.viewCount} views &middot; {l.enquiryCount} enquiries &middot; {l.daysOnMarket} days on market</span></p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-center" title="Listing quality: how complete and competitive this listing is"><div className="grid h-14 w-14 place-items-center rounded-full border-4 text-lg font-bold" style={{ borderColor: q.score >= 85 ? "var(--ok)" : q.score >= 65 ? "var(--accent)" : q.score >= 45 ? "var(--warn)" : "var(--danger)" }}>{q.score}</div><p className="muted text-xs">Quality {q.grade}</p></div>
          {canPublish && ["draft", "unpublished", "expired"].includes(l.status) && <button className="btn" disabled={busy} onClick={() => act(postJson(`/api/v1/listings/${l.id}/publish`), "Published.")}>Publish</button>}
          {canPublish && l.status === "published" && <button className="btn-ghost" disabled={busy} onClick={() => act(postJson(`/api/v1/listings/${l.id}/unpublish`, {}), "Unpublished.")}>Unpublish</button>}
          {canPublish && ["draft", "published", "unpublished", "expired"].includes(l.status) && (
            <select className="input w-auto py-1.5 text-sm" disabled={busy} defaultValue="" aria-label="Close this listing" onChange={(e) => { const v = e.target.value; e.target.value = ""; if (v) void act(postJson(`/api/v1/listings/${l.id}/close`, { outcome: v }), v === "withdrawn" ? "Closed: withdrawn." : `Closed: ${v}.`); }}>
              <option value="">Close...</option>{l.purpose === "sale" && <option value="sold">Sold</option>}{l.purpose === "rent" && <option value="rented">Rented</option>}<option value="withdrawn">Withdrawn by owner</option>
            </select>
          )}
          {canManage && ["closed", "expired", "archived"].includes(l.status) && <button className="btn-ghost" disabled={busy} onClick={() => act(postJson(`/api/v1/listings/${l.id}/reopen`), "Reopened as unpublished.")}>Reopen</button>}
          {canManage && ["draft", "unpublished", "expired", "closed"].includes(l.status) && <button className="btn-ghost" disabled={busy} onClick={() => act(postJson(`/api/v1/listings/${l.id}/archive`), "Archived.")}>Archive</button>}
          {canManage && !["closed", "archived"].includes(l.status) && <button className="btn-ghost" disabled={busy} onClick={() => act(postJson(`/api/v1/listings/${l.id}/refresh`), "Refreshed: expiry date pushed out.")}>Refresh</button>}
          <a className="btn-ghost" href={`/api/v1/listings/${l.id}/brochure`}>Brochure PDF</a>
          {canManage && l.status !== "published" && <DeleteButton entity="listing" id={l.id} name={l.title ?? l.reference ?? "this listing"} redirectTo="/listings" small={false} />}
          {canManage && <button className="btn-ghost" disabled={busy} onClick={() => act(postJson(`/api/v1/listings/${l.id}/duplicate`, {}), "Copied as a new draft.", (d) => router.push(`/listings/${d.id}`))}>Duplicate</button>}
        </div>
      </header>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "" : "err"}`}>{msg.text}</p>}
      <div className="flex gap-1 overflow-x-auto border-b" style={{ borderColor: "var(--border)" }} role="tablist">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} className={`whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium ${tab === t ? "" : "muted"}`} style={{ borderColor: tab === t ? "var(--accent)" : "transparent" }} onClick={() => setTab(t)}>{t}</button>)}
      </div>

      {tab === "Overview" && (
        <form onSubmit={saveOverview} className="grid gap-5 lg:grid-cols-[1fr_20rem]">
          <div className="flex flex-col gap-5">
            <section className="card grid gap-4 p-5 sm:grid-cols-2">
              <h2 className="font-semibold sm:col-span-2">Marketing copy</h2>
              <label className={`${lab} sm:col-span-2`}><span className={cap}>Title</span><input className="input" value={f.title} onChange={set("title")} maxLength={255} disabled={!canManage} /></label>
              <label className={`${lab} sm:col-span-2`}><span className={cap}>Description ({f.description.length} characters)</span><textarea className="input min-h-40" value={f.description} onChange={set("description")} maxLength={10000} disabled={!canManage} /></label>
              <label className={`${lab} sm:col-span-2`}><span className={cap}>Arabic title</span><input className="input" dir="rtl" value={f.titleAr} onChange={set("titleAr")} maxLength={255} disabled={!canManage} /></label>
              <label className={`${lab} sm:col-span-2`}><span className={cap}>Arabic description</span><textarea className="input min-h-32" dir="rtl" value={f.descriptionAr} onChange={set("descriptionAr")} maxLength={10000} disabled={!canManage} /></label>
              <label className={lab}><span className={cap}>Video link (YouTube, Vimeo)</span><input className="input" value={f.videoUrl} onChange={set("videoUrl")} placeholder="https://" disabled={!canManage} /></label>
              <label className={lab}><span className={cap}>Virtual tour link</span><input className="input" value={f.virtualTourUrl} onChange={set("virtualTourUrl")} placeholder="https://" disabled={!canManage} /></label>
            </section>
            <section className="card grid gap-4 p-5 sm:grid-cols-3">
              <h2 className="font-semibold sm:col-span-3">Price and terms</h2>
              <label className={lab}><span className={cap}>Asking price ({l.currency})</span><input className="input" type="number" min="1" step="any" value={f.price} onChange={set("price")} disabled={!canManage} /></label>
              <label className={lab}><span className={cap}>Owner instructed price</span><input className="input" type="number" min="1" step="any" value={f.ownerPrice} onChange={set("ownerPrice")} disabled={!canManage} /></label>
              <label className={lab}><span className={cap}>Commission %</span><input className="input" type="number" min="0" max="100" step="0.01" value={f.commissionPct} onChange={set("commissionPct")} disabled={!canManage} /></label>
              {l.purpose === "rent" && <>
                <label className={lab}><span className={cap}>Rent is paid</span><select className="input" value={f.rentFrequency} onChange={set("rentFrequency")} disabled={!canManage}><option value="">-</option><option value="yearly">Yearly</option><option value="quarterly">Quarterly</option><option value="monthly">Monthly</option></select></label>
                <label className={lab}><span className={cap}>Cheques</span><input className="input" type="number" min="1" max="12" value={f.cheques} onChange={set("cheques")} disabled={!canManage} /></label>
                <label className={lab}><span className={cap}>Security deposit</span><input className="input" type="number" min="0" step="any" value={f.securityDeposit} onChange={set("securityDeposit")} disabled={!canManage} /></label>
              </>}
              <label className={lab}><span className={cap}>Service charge (per year)</span><input className="input" type="number" min="0" step="any" value={f.serviceCharge} onChange={set("serviceCharge")} disabled={!canManage} /></label>
              <label className={lab}><span className={cap}>Furnishing</span><select className="input" value={f.furnishing} onChange={set("furnishing")} disabled={!canManage}><option value="">-</option><option value="unfurnished">Unfurnished</option><option value="semi_furnished">Semi-furnished</option><option value="furnished">Furnished</option></select></label>
              <label className={lab}><span className={cap}>Parking spaces</span><input className="input" type="number" min="0" max="50" value={f.parkingSpaces} onChange={set("parkingSpaces")} disabled={!canManage} /></label>
            </section>
            <section className="card grid gap-4 p-5 sm:grid-cols-3">
              <h2 className="font-semibold sm:col-span-3">Owner agreement and lifecycle</h2>
              <label className={lab}><span className={cap}>Agreement</span><select className="input" value={f.exclusivity} onChange={set("exclusivity")} disabled={!canManage}><option value="none">None recorded</option><option value="exclusive">Exclusive</option><option value="non_exclusive">Non-exclusive</option></select></label>
              <label className={lab}><span className={cap}>Starts</span><input className="input" type="date" value={f.agreementStartsOn} onChange={set("agreementStartsOn")} disabled={!canManage} /></label>
              <label className={lab}><span className={cap}>Ends {f.exclusivity !== "none" && "(required)"}</span><input className="input" type="date" value={f.agreementExpiresOn} onChange={set("agreementExpiresOn")} disabled={!canManage} /></label>
              <label className={lab}><span className={cap}>Listing expires</span><input className="input" type="date" value={f.expiresOn} onChange={set("expiresOn")} disabled={!canManage} /></label>
              <label className={lab}><span className={cap}>Latitude</span><input className="input" inputMode="decimal" value={f.latitude} onChange={set("latitude")} placeholder="25.0805" disabled={!canManage} /></label>
              <label className={lab}><span className={cap}>Longitude</span><input className="input" inputMode="decimal" value={f.longitude} onChange={set("longitude")} placeholder="55.1403" disabled={!canManage} /></label>
              <label className="flex items-center gap-2 text-sm sm:col-span-3"><input type="checkbox" checked={f.featured} onChange={(e) => setF({ ...f, featured: e.target.checked })} disabled={!canManage} /> Featured (shown first on the website)</label>
            </section>
            {canManage && <div><button className="btn" disabled={busy}>{busy ? "Saving..." : "Save changes"}</button></div>}
          </div>
          <aside className="flex flex-col gap-4">
            <section className="card p-4"><h2 className="mb-2 font-semibold">Improve this listing</h2>
              {q.tips.length === 0 ? <p className="muted text-sm">Nothing left to improve.</p> : <ul className="flex flex-col gap-2 text-sm">{q.tips.slice(0, 6).map((t: any) => <li key={t.tip} className="flex justify-between gap-3"><span>{t.tip}</span><span className="muted">+{t.max - t.points}</span></li>)}</ul>}</section>
            <section className="card p-4 text-sm"><h2 className="mb-2 font-semibold">The property</h2>
              <dl className="grid grid-cols-2 gap-2"><div><dt className="muted text-xs">Type</dt><dd>{u.type ?? "-"}</dd></div><div><dt className="muted text-xs">Bedrooms</dt><dd>{u.bedrooms ?? "-"}</dd></div><div><dt className="muted text-xs">Bathrooms</dt><dd>{u.bathrooms ?? "-"}</dd></div><div><dt className="muted text-xs">Area</dt><dd>{u.areaSqft ? `${Number(u.areaSqft).toLocaleString("en-US")} sqft` : "-"}</dd></div><div><dt className="muted text-xs">Floor</dt><dd>{u.floor ?? "-"}</dd></div><div><dt className="muted text-xs">View</dt><dd>{u.view ?? "-"}</dd></div></dl>
              <p className="muted mt-2 text-xs">Bedrooms, area and the rest come from the unit in Inventory.</p></section>
          </aside>
        </form>
      )}

      {tab === "Location and map" && <LocationTab l={l} canManage={canManage} />}
      {tab === "Photos and plans" && (
        <div className="flex flex-col gap-5">
          <section className="card p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Photos ({images.length}/40)</h2><p className="muted text-xs">JPEG, PNG or WEBP, up to 12 MB each. The first photo is the cover; drag order with the arrows.</p></div>
              {canManage && <><input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => { void upload(e.target.files, "image"); e.target.value = ""; }} /><button className="btn" disabled={!!uploading} onClick={() => fileRef.current?.click()}>{uploading ? `Uploading ${uploading}` : "+ Add photos"}</button></>}</div>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {images.map((m: any, i: number) => (
                <li key={m.id} className="card overflow-hidden">
                  <div className="relative aspect-[4/3]" style={{ background: "var(--card-2)" }}>
                    <img src={`/api/v1/listings/${l.id}/media/${m.id}`} alt={m.caption ?? m.fileName ?? "Photo"} loading="lazy" className="h-full w-full object-cover" />
                    {l.coverMediaId === m.id && <span className="badge badge-ok absolute left-2 top-2">cover</span>}
                  </div>
                  {canManage && (
                    <div className="flex items-center justify-between gap-1 p-2 text-xs">
                      <span className="flex gap-1"><button className="btn-ghost px-2" aria-label="Move earlier" onClick={() => move(images, i, -1)}>&larr;</button><button className="btn-ghost px-2" aria-label="Move later" onClick={() => move(images, i, 1)}>&rarr;</button></span>
                      <span className="flex gap-1">{l.coverMediaId !== m.id && <button className="btn-ghost px-2" onClick={() => act(postJson(`/api/v1/listings/${l.id}/media/${m.id}`, { cover: true }, "PATCH"), "Cover set.")}>Cover</button>}<button className="btn-ghost px-2" aria-label="Delete photo" onClick={() => confirm("Remove this photo?") && act(postJson(`/api/v1/listings/${l.id}/media/${m.id}`, undefined, "DELETE"), "Removed.")}>&times;</button></span>
                    </div>
                  )}
                </li>
              ))}
              {images.length === 0 && <li className="muted col-span-full text-sm">No photos yet. Listings with 10 or more photos get the most enquiries.</li>}
            </ul>
          </section>
          <section className="card p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">Floor plans ({plans.length})</h2><p className="muted text-xs">Upload the floor plan as an image.</p></div>
              {canManage && <><input ref={planRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => { void upload(e.target.files, "floorplan"); e.target.value = ""; }} /><button className="btn-ghost" disabled={!!uploading} onClick={() => planRef.current?.click()}>+ Add floor plan</button></>}</div>
            <ul className="grid gap-3 sm:grid-cols-2">{plans.map((m: any) => <li key={m.id} className="card p-2"><img src={`/api/v1/listings/${l.id}/media/${m.id}`} alt="Floor plan" loading="lazy" className="w-full" />{canManage && <button className="btn-ghost mt-2 text-xs" onClick={() => confirm("Remove this floor plan?") && act(postJson(`/api/v1/listings/${l.id}/media/${m.id}`, undefined, "DELETE"), "Removed.")}>Remove</button>}</li>)}{plans.length === 0 && <li className="muted text-sm">No floor plan yet.</li>}</ul>
          </section>
          <section className="card p-5 text-sm"><h2 className="mb-1 font-semibold">Video and tour</h2><p className="muted">Video: {l.videoUrl ? <a href={l.videoUrl} target="_blank" rel="noopener noreferrer" className="underline">{l.videoUrl}</a> : "not set"} &middot; Tour: {l.virtualTourUrl ? <a href={l.virtualTourUrl} target="_blank" rel="noopener noreferrer" className="underline">{l.virtualTourUrl}</a> : "not set"}. Edit the links on the Overview tab.</p></section>
        </div>
      )}

      {tab === "Amenities" && (
        <section className="card p-5">
          <div className="mb-4 flex items-center justify-between gap-3"><div><h2 className="font-semibold">Features and amenities ({feat.length})</h2><p className="muted text-xs">These appear on the website, the brochure and the portal feeds.</p></div>
            {canManage && <button className="btn" disabled={busy} onClick={() => act(postJson(`/api/v1/listings/${l.id}/details`, { features: feat }, "PUT"), "Saved.")}>Save amenities</button>}</div>
          <div className="grid gap-6 md:grid-cols-2">
            {groups.map((g) => (
              <fieldset key={g.key}><legend className="mb-2 text-sm font-semibold">{g.label}</legend>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">{amenities.filter((a) => a.group === g.key).map((a) => <label key={a.code} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!canManage} checked={feat.includes(a.code)} onChange={(e) => setFeat(e.target.checked ? [...feat, a.code] : feat.filter((x) => x !== a.code))} />{a.label}</label>)}</div>
              </fieldset>
            ))}
          </div>
        </section>
      )}

      {tab === "Distribution" && (
        <div className="flex flex-col gap-5">
          <section className="card p-5">
            <h2 className="font-semibold">Property website</h2>
            {!site ? <p className="muted mt-1 text-sm">Website settings need the &ldquo;site.manage&rdquo; permission.</p> : (
              <div className="mt-2 flex flex-col gap-3 text-sm">
                {!site.enabled && <p className="rounded-lg p-3" style={{ background: "var(--accent-soft)" }}>Your property website is switched off. Turn it on under <a className="underline" href="/website">Website</a>.</p>}
                <label className="flex items-center gap-2"><input type="checkbox" disabled={!canPublish || busy} checked={!!l.shareEnabled} onChange={(e) => act(postJson(`/api/v1/listings/${l.id}/share`, { enabled: e.target.checked }), e.target.checked ? "Public page is on (it shows once the listing is published)." : "Public page is off.")} /> Show this listing on the website</label>
                {publicUrl && l.shareEnabled && <p>Public address: <a className="underline" href={publicUrl} target="_blank" rel="noopener noreferrer">{publicUrl}</a> {l.status !== "published" && <span className="muted">(not visible until published)</span>}</p>}
                {l.shareEnabled && canPublish && <button className="btn-ghost w-fit text-xs" onClick={() => confirm("Create a new link? The old one stops working.") && act(postJson(`/api/v1/listings/${l.id}/share`, { regenerate: true }), "New link created.")}>Create a new link</button>}
              </div>
            )}
          </section>
          <section className="card overflow-x-auto p-5">
            <h2 className="mb-1 font-semibold">Portals</h2>
            <p className="muted mb-3 text-xs">Switch a portal off to keep this listing off it. Changes apply the next time the listing is published or updated.</p>
            <table className="t"><thead><tr><th>Channel</th><th>On</th><th>Status</th><th>Portal id</th><th>Last sync</th><th>Detail</th></tr></thead>
              <tbody>
                {channels.filter((c) => c.kind === "portal").map((c) => (
                  <tr key={c.portalAccountId}><td className="font-medium">{c.label}<span className="muted block text-xs">{c.provider} &middot; {c.mode === "api" ? "live API" : "XML feed"}</span></td>
                    <td><input type="checkbox" aria-label={`Send to ${c.label}`} checked={c.enabled} disabled={!canPublish || busy} onChange={(e) => act(postJson(`/api/v1/listings/${l.id}/channels`, { portalAccountId: c.portalAccountId, enabled: e.target.checked }, "PUT"), "Updated.")} /></td>
                    <td><span className={`badge ${tone[c.status] ?? ""}`}>{c.status}</span></td><td className="text-xs">{c.externalUrl ? <a className="underline" href={c.externalUrl} target="_blank" rel="noopener noreferrer">{c.externalId ?? "open"}</a> : c.externalId ?? "-"}</td><td className="text-xs">{dt(c.lastSyncedAt)}</td><td className="err max-w-xs text-xs">{c.error}</td></tr>
                ))}
                {channels.filter((c) => c.kind === "portal").length === 0 && <tr><td colSpan={6} className="muted">No portal accounts yet. Add Bayut or Property Finder under <a className="underline" href="/distribution">Distribution</a>.</td></tr>}
              </tbody></table>
            {l.publications.length > 0 && <details className="mt-4"><summary className="cursor-pointer text-sm font-medium">What was sent ({l.publications.length})</summary><ul className="mt-2 flex flex-col gap-1 text-xs">{l.publications.map((p: any) => <li key={p.id}>{dt(p.createdAt)} &middot; {p.action} &middot; {p.status}{p.error ? ` · ${p.error}` : ""}</li>)}</ul></details>}
          </section>
        </div>
      )}

      {tab === "Price and compliance" && (
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="card p-5"><h2 className="mb-3 font-semibold">Price history</h2>
            <ol className="flex flex-col gap-1.5 text-sm">{[...l.priceHistory].reverse().map((p: any, i: number, arr: any[]) => { const prev = arr[i + 1]; const d = prev ? Number(p.price) - Number(prev.price) : 0; return <li key={p.id} className="flex justify-between gap-3"><span>{dt(p.createdAt)}</span><span><b>{money(p.price, p.currency)}</b>{prev && d !== 0 && <span className={d < 0 ? "err ml-2" : "ml-2"} style={d > 0 ? { color: "var(--ok)" } : undefined}>{d > 0 ? "+" : ""}{d.toLocaleString("en-US")}</span>}</span></li>; })}{l.priceHistory.length === 0 && <li className="muted">No price set yet.</li>}</ol></section>
          <section className="card p-5"><h2 className="mb-3 font-semibold">Compliance</h2>
            <p className="text-sm">{l.evaluation.publishable ? <span className="badge badge-ok">Meets all publication requirements</span> : <span className="badge badge-danger">Cannot be published yet</span>} <span className="muted text-xs">Rule version {l.evaluation.ruleVersion ?? "-"}</span></p>
            {!l.evaluation.publishable && <ul className="err mt-2 list-disc pl-5 text-sm">{l.evaluation.issues.map((i: any) => <li key={i.code}>{i.message}</li>)}</ul>}
            <h3 className="mb-1 mt-4 text-sm font-semibold">Advertising permits</h3>
            <ul className="flex flex-col gap-1 text-sm">{l.permits.map((p: any) => <li key={p.id} className="flex flex-wrap items-center justify-between gap-2"><span>{p.authority} &middot; {p.permitNo} &middot; expires {p.expiresAt}</span><span className="flex items-center gap-2"><span className={`badge ${p.status === "valid" ? "badge-ok" : p.status === "pending" ? "badge-warn" : "badge-danger"}`}>{p.status}</span>{canPublish && p.status === "pending" && <><button className="btn-ghost text-xs" onClick={() => act(postJson(`/api/v1/listing-permits/${p.id}/verify`, { outcome: "valid" }), "Marked valid.")}>Mark valid</button></>}</span></li>)}{l.permits.length === 0 && <li className="muted">No permit recorded.</li>}</ul>
            {canManage && (
              <form className="mt-3 grid gap-2 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void act(postJson(`/api/v1/listings/${l.id}/permits`, permit), "Permit added.", () => setPermit({ ...permit, permitNo: "", expiresAt: "" })); }}>
                <input className="input sm:col-span-2" placeholder="Permit number (Trakheesi)" value={permit.permitNo} onChange={(e) => setPermit({ ...permit, permitNo: e.target.value })} required aria-label="Permit number" />
                <select className="input" value={permit.authority} onChange={(e) => setPermit({ ...permit, authority: e.target.value })} aria-label="Authority"><option value="DLD_TRAKHEESI">DLD Trakheesi</option><option value="ADREC">ADREC</option><option value="ADGM_RA">ADGM</option></select>
                <input className="input" type="date" value={permit.expiresAt} onChange={(e) => setPermit({ ...permit, expiresAt: e.target.value })} required aria-label="Expires" />
                <button className="btn sm:col-span-4 sm:w-fit">Add permit</button>
              </form>
            )}
            <p className="muted mt-3 text-xs">A permit counts only after someone verifies it. Checking it against the regulator is a manual step until an authorised integration exists.</p>
          </section>
        </div>
      )}

      {tab === "Activity" && (
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="card overflow-x-auto p-5"><h2 className="mb-3 font-semibold">Enquiries ({l.enquiryCount})</h2>
            <table className="t"><thead><tr><th>When</th><th>Who</th><th>Message</th><th /></tr></thead><tbody>{l.enquiries.map((e: any) => <tr key={e.id}><td>{dt(e.createdAt)}</td><td className="font-medium">{e.contactName}{e.duplicate && <span className="badge badge-gray ml-2">repeat</span>}</td><td className="max-w-xs truncate text-xs">{e.message ?? ""}</td><td className="text-right">{e.leadId && <a className="btn-ghost text-xs" href={`/leads/${e.leadId}`}>Lead</a>}</td></tr>)}{l.enquiries.length === 0 && <tr><td colSpan={4} className="muted">No enquiries yet.</td></tr>}</tbody></table></section>
          <section className="card overflow-x-auto p-5"><h2 className="mb-3 font-semibold">Viewings ({l.viewings.length})</h2>
            <table className="t"><thead><tr><th>When</th><th>Status</th></tr></thead><tbody>{l.viewings.map((v: any) => <tr key={v.id}><td>{dt(v.scheduledAt)}</td><td><span className="badge badge-gray">{v.status}</span></td></tr>)}{l.viewings.length === 0 && <tr><td colSpan={2} className="muted">No viewings booked.</td></tr>}</tbody></table></section>
        </div>
      )}
    </div>
  );
}

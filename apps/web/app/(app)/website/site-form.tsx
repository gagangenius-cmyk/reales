"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

const lab = "flex flex-col gap-1.5 text-sm";
const cap = "muted text-xs font-medium";

export function SiteForm({ slug, initial, tenantName }: { slug: string; initial: any; tenantName: string }) {
  const router = useRouter();
  const [f, setF] = useState({
    enabled: !!initial.enabled, title: initial.title ?? tenantName, tagline: initial.tagline ?? "", about: initial.about ?? "", phone: initial.phone ?? "", whatsapp: initial.whatsapp ?? "", email: initial.email ?? "", address: initial.address ?? "",
    logoUrl: initial.logoUrl ?? "", primaryColor: initial.primaryColor ?? "#4f46e5", defaultLanguage: initial.defaultLanguage ?? "en", showPrices: initial.showPrices !== false, areaUnit: initial.areaUnit ?? "sqft", seoDescription: initial.seoDescription ?? "",
    instagram: initial.social?.instagram ?? "", facebook: initial.social?.facebook ?? "", linkedin: initial.social?.linkedin ?? "", youtube: initial.social?.youtube ?? "",
  });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const url = typeof window !== "undefined" ? `${window.location.origin}/p/${slug}` : `/p/${slug}`;
  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(null);
    const { instagram, facebook, linkedin, youtube, ...rest } = f;
    const r = await postJson("/api/v1/site-settings", { ...rest, title: rest.title || null, tagline: rest.tagline || null, about: rest.about || null, phone: rest.phone || null, whatsapp: rest.whatsapp || null, email: rest.email || null, address: rest.address || null, logoUrl: rest.logoUrl || null, seoDescription: rest.seoDescription || null, social: Object.fromEntries(Object.entries({ instagram, facebook, linkedin, youtube }).filter(([, v]) => v)) }, "PUT");
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    setMsg({ ok: true, text: "Saved." }); router.refresh();
  }
  return (
    <form onSubmit={save} className="grid gap-5 lg:grid-cols-[1fr_20rem]">
      <div className="flex flex-col gap-5">
        <section className="card grid gap-4 p-5 sm:grid-cols-2">
          <h2 className="font-semibold sm:col-span-2">Branding</h2>
          <label className={lab}><span className={cap}>Site name</span><input className="input" value={f.title} onChange={set("title")} maxLength={120} /></label>
          <label className={lab}><span className={cap}>Brand colour</span><span className="flex gap-2"><input type="color" value={f.primaryColor} onChange={set("primaryColor")} aria-label="Brand colour" className="h-10 w-14 rounded" /><input className="input" value={f.primaryColor} onChange={set("primaryColor")} maxLength={7} /></span></label>
          <label className={`${lab} sm:col-span-2`}><span className={cap}>Headline</span><input className="input" value={f.tagline} onChange={set("tagline")} maxLength={200} placeholder="Find your home in Dubai" /></label>
          <label className={`${lab} sm:col-span-2`}><span className={cap}>Logo link (https://...)</span><input className="input" value={f.logoUrl} onChange={set("logoUrl")} placeholder="https://" /></label>
          <label className={`${lab} sm:col-span-2`}><span className={cap}>About us</span><textarea className="input min-h-28" value={f.about} onChange={set("about")} maxLength={8000} /></label>
        </section>
        <section className="card grid gap-4 p-5 sm:grid-cols-2">
          <h2 className="font-semibold sm:col-span-2">Contact</h2>
          <label className={lab}><span className={cap}>Phone</span><input className="input" value={f.phone} onChange={set("phone")} inputMode="tel" /></label>
          <label className={lab}><span className={cap}>WhatsApp (with country code)</span><input className="input" value={f.whatsapp} onChange={set("whatsapp")} inputMode="tel" placeholder="+971..." /></label>
          <label className={lab}><span className={cap}>Email</span><input className="input" type="email" value={f.email} onChange={set("email")} /></label>
          <label className={lab}><span className={cap}>Address</span><input className="input" value={f.address} onChange={set("address")} /></label>
          {(["instagram", "facebook", "linkedin", "youtube"] as const).map((k) => <label key={k} className={lab}><span className={`${cap} capitalize`}>{k} link</span><input className="input" value={f[k]} onChange={set(k)} placeholder="https://" /></label>)}
        </section>
        <section className="card grid gap-4 p-5 sm:grid-cols-2">
          <h2 className="font-semibold sm:col-span-2">Display and search engines</h2>
          <label className={lab}><span className={cap}>Default language</span><select className="input" value={f.defaultLanguage} onChange={set("defaultLanguage")}><option value="en">English</option><option value="ar">Arabic</option></select></label>
          <label className={lab}><span className={cap}>Show areas in</span><select className="input" value={f.areaUnit} onChange={set("areaUnit")}><option value="sqft">Square feet</option><option value="sqm">Square metres</option></select></label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.showPrices} onChange={(e) => setF({ ...f, showPrices: e.target.checked })} /> Show prices (otherwise &ldquo;Price on request&rdquo;)</label>
          <label className={`${lab} sm:col-span-2`}><span className={cap}>Search description ({f.seoDescription.length}/300)</span><textarea className="input min-h-20" value={f.seoDescription} onChange={set("seoDescription")} maxLength={300} /></label>
        </section>
        <div className="flex items-center gap-3"><button className="btn">Save website</button>{msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "muted" : "err"}`}>{msg.text}</p>}</div>
      </div>
      <aside className="card h-fit p-5 text-sm">
        <h2 className="mb-2 font-semibold">Website status</h2>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Website is live</label>
        <p className="muted mt-2 text-xs">When off, every address under it shows &ldquo;not found&rdquo;.</p>
        <p className="muted mt-4 text-xs">Public address</p><p className="break-all font-mono text-xs">{url}</p>
        <p className="mt-3"><a className="btn-ghost text-xs" href={`/p/${slug}`} target="_blank" rel="noopener noreferrer">Open the website</a></p>
        <p className="muted mt-4 text-xs">Search engines: <span className="font-mono">{url}/sitemap.xml</span></p>
        <p className="muted mt-3 text-xs">To use your own domain (for example properties.yourcompany.com), point it at this application and ask your administrator to route it to this address.</p>
      </aside>
    </form>
  );
}

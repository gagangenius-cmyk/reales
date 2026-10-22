import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getSequelize } from "@reales/database";
import { amenityLabel, getSiteListing, resolveSite } from "@reales/domain";
import { LazyMap } from "@/components/map-lazy";
import { Gallery } from "@/components/site/gallery";
import { Reveal } from "@/components/site/reveal";
import { SiteShell } from "@/components/site/site-shell";
import { area, pickLang, price, st, stDyn } from "@/lib/site-i18n";
import { EnquiryForm } from "../enquiry-form";

type SP = { lang?: string };

export async function generateMetadata({ params, searchParams }: { params: Promise<{ slug: string; reference: string }>; searchParams: Promise<SP> }): Promise<Metadata> {
  const { slug, reference } = await params;
  const sq = getSequelize();
  const site = await resolveSite(sq, slug);
  const l = site ? await getSiteListing(sq, site, reference, false) : null;
  if (!site || !l) return { title: "Not found", robots: { index: false } };
  const lang = pickLang((await searchParams).lang, site.settings.defaultLanguage);
  const title = lang === "ar" && l.titleAr ? l.titleAr : l.title;
  const desc = (lang === "ar" && l.descriptionAr ? l.descriptionAr : l.description ?? "").slice(0, 160);
  return { title: `${title} | ${site.settings.title}`, description: desc, alternates: { languages: { en: `/p/${slug}/${reference}?lang=en`, ar: `/p/${slug}/${reference}?lang=ar` } }, openGraph: { title, description: desc, images: l.cover ? [`/media/${l.token}/${l.cover}`] : undefined } };
}

export default async function SiteListing({ params, searchParams }: { params: Promise<{ slug: string; reference: string }>; searchParams: Promise<SP> }) {
  const { slug, reference } = await params;
  const sq = getSequelize();
  const site = await resolveSite(sq, slug);
  if (!site) notFound();
  const l = await getSiteListing(sq, site, reference);
  if (!l) notFound();
  const lang = pickLang((await searchParams).lang, site.settings.defaultLanguage);
  const title = lang === "ar" && l.titleAr ? l.titleAr : l.title;
  const description = lang === "ar" && l.descriptionAr ? l.descriptionAr : l.description;
  const images = l.photos.filter((p) => p.kind === "image"), plans = l.photos.filter((p) => p.kind === "floorplan");
  const hero = images.find((p) => p.id === l.cover) ?? images[0];
  const ordered = hero ? [hero, ...images.filter((p) => p !== hero)] : images;
  const base = `/p/${slug}`;
  const s = site.settings, wa = s.whatsapp?.replace(/[^\d]/g, "");
  const nf = (n: number | null | undefined) => (n == null ? "-" : n.toLocaleString(lang === "ar" ? "ar-AE" : "en-US"));
  const rows: [string, string][] = [[st(lang, "type"), stDyn(lang, l.type ?? "-")], [st(lang, "furnishing"), l.furnishing ? stDyn(lang, l.furnishing) : "-"], ...(l.subCommunity ? [[st(lang, "subLocation"), l.subCommunity] as [string, string]] : []), ...(l.floor != null ? [[st(lang, "floorNo"), String(l.floor)] as [string, string]] : []), ...(l.plotAreaSqft ? [[st(lang, "plot"), area(l.plotAreaSqft, s.areaUnit, lang)] as [string, string]] : []), ...(l.completionStatus ? [[st(lang, "completion"), l.completionStatus === "off_plan" ? st(lang, "offPlan") : st(lang, "ready")] as [string, string]] : []), ...(l.ownership ? [[st(lang, "ownership"), stDyn(lang, l.ownership)] as [string, string]] : []), ...(l.yearBuilt ? [[st(lang, "yearBuilt"), String(l.yearBuilt)] as [string, string]] : []), ...(l.availableFrom ? [[st(lang, "availableFrom"), l.availableFrom] as [string, string]] : []), ...(l.utilitiesIncluded != null ? [[st(lang, "utilities"), l.utilitiesIncluded ? st(lang, "included") : st(lang, "notIncluded")] as [string, string]] : []), ...(l.price && l.areaSqft ? [[st(lang, "pricePerSqft"), `${l.currency} ${Math.round(l.price / l.areaSqft).toLocaleString(lang === "ar" ? "ar-AE" : "en-US")}`] as [string, string]] : []), [st(lang, "parking"), l.parkingSpaces != null ? String(l.parkingSpaces) : "-"], [st(lang, "reference"), l.reference], ...(l.permitNo ? [[st(lang, "permit"), l.permitNo] as [string, string]] : [])];
  const jsonLd = { "@context": "https://schema.org", "@type": "RealEstateListing", name: title, description: description ?? undefined, url: `/p/${slug}/${l.reference}`, image: hero ? `/media/${l.token}/${hero.id}` : undefined,
    offers: l.price != null ? { "@type": "Offer", price: l.price, priceCurrency: l.currency, availability: "https://schema.org/InStock" } : undefined,
    about: { "@type": l.type === "villa" ? "House" : "Apartment", numberOfRooms: l.bedrooms ?? undefined, numberOfBathroomsTotal: l.bathrooms ?? undefined, floorSize: l.areaSqft ? { "@type": "QuantitativeValue", value: Math.round(l.areaSqft), unitCode: "FTK" } : undefined, address: { "@type": "PostalAddress", addressLocality: l.community ?? l.city ?? undefined, addressCountry: "AE" }, geo: l.latitude != null && l.longitude != null ? { "@type": "GeoCoordinates", latitude: l.latitude, longitude: l.longitude } : undefined } };
  return (
    <SiteShell site={site} lang={lang} path={`/${l.reference}`}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <div className="pf-wrap">
        <p className="pf-crumb"><Link href={`${base}?lang=${lang}`} className="pf-mute">&larr; {st(lang, "back")}</Link></p>
        <div className="pf-up"><Gallery images={ordered.map((p) => ({ src: `/media/${l.token}/${p.id}`, alt: p.caption ?? title }))} more={st(lang, "gallery")} empty={st(lang, "noPhotos")} /></div>
        <div className="pf-lay">
          <div>
            <Reveal>
              <div className="pf-panel">
                <p className="pf-bigprice">{price(l.price, l.currency, lang, l.rentFrequency, l.purpose)}</p>
                <h1 style={{ fontSize: "1.45rem", fontWeight: 700, marginTop: 4 }}>{title}</h1>
                <p className="pf-mute" style={{ marginTop: 2 }}>{[l.building, l.community, l.city].filter(Boolean).join(", ")}</p>
                <div className="pf-keys">
                  <div className="pf-key"><b>{l.bedrooms === 0 ? st(lang, "studio") : nf(l.bedrooms)}</b><span>{st(lang, "beds")}</span></div>
                  <div className="pf-key"><b>{nf(l.bathrooms)}</b><span>{st(lang, "baths")}</span></div>
                  <div className="pf-key"><b>{area(l.areaSqft, s.areaUnit, lang)}</b><span>{st(lang, "area")}</span></div>
                </div>
              </div>
            </Reveal>
            {description && <Reveal><div className="pf-panel"><h2>{st(lang, "description")}</h2><p style={{ whiteSpace: "pre-wrap", lineHeight: 1.8 }}>{description}</p></div></Reveal>}
            <Reveal><div className="pf-panel"><h2>{st(lang, "details")}</h2><dl className="pf-dl">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></div></Reveal>
            {l.features.length > 0 && <Reveal><div className="pf-panel"><h2>{st(lang, "amenities")}</h2><ul className="pf-am">{l.features.map((f) => <li key={f}>{amenityLabel(f, lang)}</li>)}</ul></div></Reveal>}
            {l.latitude != null && l.longitude != null && (
              <Reveal><div className="pf-panel"><h2>{st(lang, "locationTitle")}</h2>
                <LazyMap height={320} zoomOnSingle={l.exactLocation ? 15 : 13} pins={[{ id: l.reference, lat: l.latitude, lng: l.longitude, title: title, subtitle: [l.building, l.community, l.city].filter(Boolean).join(", "), precise: !!l.exactLocation, label: "" }]} />
                {!l.exactLocation && <p className="pf-mute" style={{ fontSize: ".8rem", marginTop: 6 }}>{st(lang, "approxLocation")}</p>}
              </div></Reveal>
            )}
            {plans.length > 0 && <Reveal><div className="pf-panel"><h2>{st(lang, "floorplan")}</h2><div className="pf-plans">{plans.map((p) => <a key={p.id} href={`/media/${l.token}/${p.id}`} target="_blank" rel="noopener noreferrer"><img src={`/media/${l.token}/${p.id}`} alt={st(lang, "floorplan")} loading="lazy" /></a>)}</div></div></Reveal>}
            <Reveal>
              <div className="pf-panel" style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                {l.videoUrl && <a className="pf-btn alt" href={l.videoUrl} target="_blank" rel="noopener noreferrer">{st(lang, "video")}</a>}
                {l.virtualTourUrl && <a className="pf-btn alt" href={l.virtualTourUrl} target="_blank" rel="noopener noreferrer">{st(lang, "tour")}</a>}
                {l.latitude != null && l.longitude != null && <a className="pf-btn alt" href={`https://www.google.com/maps?q=${l.latitude},${l.longitude}`} target="_blank" rel="noopener noreferrer">{st(lang, "map")}</a>}
                <a className="pf-btn alt" href={`${base}/${l.reference}/brochure`}>{st(lang, "brochure")}</a>
              </div>
            </Reveal>
          </div>
          <aside className="pf-side" id="enquire">
            <div className="pf-panel">
              <h2>{st(lang, "enquire")}</h2>
              <EnquiryForm token={l.token} lang={lang} />
              <div className="pf-agent">{s.phone && <a className="pf-btn alt" href={`tel:${s.phone}`}>{st(lang, "call")}</a>}{wa && <a className="pf-btn wa" href={`https://wa.me/${wa}?text=${encodeURIComponent(l.reference)}`} target="_blank" rel="noopener noreferrer">{st(lang, "whatsapp")}</a>}</div>
            </div>
          </aside>
        </div>
      </div>
      <div className="pf-sticky">
        {s.phone && <a className="pf-btn alt" href={`tel:${s.phone}`}>{st(lang, "call")}</a>}
        {wa && <a className="pf-btn wa" href={`https://wa.me/${wa}?text=${encodeURIComponent(l.reference)}`} target="_blank" rel="noopener noreferrer">{st(lang, "whatsapp")}</a>}
        <a className="pf-btn" href="#enquire">{st(lang, "enquire")}</a>
      </div>
    </SiteShell>
  );
}

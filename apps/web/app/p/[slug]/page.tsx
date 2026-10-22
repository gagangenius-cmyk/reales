import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getSequelize } from "@reales/database";
import { resolveSite, searchSiteListings, type SiteFilters } from "@reales/domain";
import { LazyMap } from "@/components/map-lazy";
import { Reveal } from "@/components/site/reveal";
import { SiteShell } from "@/components/site/site-shell";
import { area, pickLang, price, st, stDyn } from "@/lib/site-i18n";

type SP = { view?: string; category?: string; purpose?: string; type?: string; beds?: string; min?: string; max?: string; community?: string; q?: string; sort?: string; page?: string; lang?: string };

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const site = await resolveSite(getSequelize(), (await params).slug);
  if (!site) return { title: "Not found", robots: { index: false } };
  return { title: `${site.settings.title} | Properties`, description: site.settings.seoDescription ?? site.settings.tagline ?? undefined, openGraph: { title: site.settings.title, description: site.settings.seoDescription ?? undefined } };
}

export default async function SiteHome({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SP> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const sq = getSequelize();
  const site = await resolveSite(sq, slug);
  if (!site) notFound();
  const lang = pickLang(sp.lang, site.settings.defaultLanguage);
  const num = (v?: string) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const f: SiteFilters = { purpose: sp.purpose === "sale" || sp.purpose === "rent" ? sp.purpose : undefined, type: sp.type, beds: num(sp.beds), minPrice: num(sp.min), maxPrice: num(sp.max), community: sp.community, category: sp.category, mapAll: sp.view === "map", q: sp.q, sort: sp.sort === "price_asc" || sp.sort === "price_desc" ? sp.sort : "newest", page: num(sp.page) };
  const r = await searchSiteListings(sq, site, f);
  const base = `/p/${slug}`;
  const qs = (over: Record<string, string | undefined>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries({ ...sp, lang, ...over })) if (v) p.set(k, v); return `${base}?${p}`; };
  const purpose = f.purpose ?? "";
  return (
    <SiteShell site={site} lang={lang}>
      <section className="pf-hero">
        <div className="pf-wrap">
          <h1 className="pf-up">{site.settings.tagline ?? site.settings.title}</h1>
          {site.settings.seoDescription && <p className="sub pf-up d1">{site.settings.seoDescription}</p>}
          <form action={base} className="pf-search pf-up d2">
            <input type="hidden" name="lang" value={lang} />{sp.view === "map" && <input type="hidden" name="view" value="map" />}
            <div className="pf-tabs" role="radiogroup" aria-label={st(lang, "buy")}>
              {([["", `${st(lang, "buy")} / ${st(lang, "rent")}`], ["sale", st(lang, "buy")], ["rent", st(lang, "rent")]] as const).map(([v, label]) => (
                <label key={v}><input type="radio" name="purpose" value={v} defaultChecked={purpose === v} /><span>{label}</span></label>
              ))}
            </div>
            <div className="pf-grid">
              <input name="q" defaultValue={sp.q ?? ""} placeholder={st(lang, "searchPlaceholder")} className="pf-in full" aria-label={st(lang, "search")} />
              <select name="category" defaultValue={sp.category ?? ""} className="pf-in" aria-label={st(lang, "category")}><option value="">{st(lang, "allCategories")}</option>{(["residential", "commercial", "land"] as const).map((c) => <option key={c} value={c}>{st(lang, `cat_${c}` as never)}</option>)}</select>
              <select name="type" defaultValue={f.type ?? ""} className="pf-in" aria-label={st(lang, "type")}><option value="">{st(lang, "allTypes")}</option>{r.types.map((t) => <option key={t} value={t}>{stDyn(lang, t)}</option>)}</select>
              <select name="beds" defaultValue={sp.beds ?? ""} className="pf-in" aria-label={st(lang, "beds")}><option value="">{st(lang, "anyBeds")}</option><option value="0">{st(lang, "studio")}</option>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}<option value="5">5+</option></select>
              <select name="community" defaultValue={f.community ?? ""} className="pf-in" aria-label={st(lang, "location")}><option value="">{st(lang, "allAreas")}</option>{r.communities.map((c) => <option key={c} value={c}>{c}</option>)}</select>
              <button className="pf-btn">{st(lang, "search")}</button>
            </div>
            <details className="pf-more" open={!!(sp.min || sp.max || sp.sort)}>
              <summary>{st(lang, "moreFilters")}</summary>
              <div className="pf-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
                <input name="min" defaultValue={sp.min ?? ""} inputMode="numeric" placeholder={st(lang, "minPrice")} className="pf-in" aria-label={st(lang, "minPrice")} />
                <input name="max" defaultValue={sp.max ?? ""} inputMode="numeric" placeholder={st(lang, "maxPrice")} className="pf-in" aria-label={st(lang, "maxPrice")} />
                <select name="sort" defaultValue={f.sort} className="pf-in" aria-label={st(lang, "sort")}><option value="newest">{st(lang, "newest")}</option><option value="price_asc">{st(lang, "priceLow")}</option><option value="price_desc">{st(lang, "priceHigh")}</option></select>
              </div>
            </details>
          </form>
        </div>
      </section>
      <section className="pf-wrap">
        {r.types.length > 1 && (
          <div className="pf-chips" aria-label={st(lang, "type")}>
            <Link className={`pf-chip ${!f.type ? "on" : ""}`} href={qs({ type: undefined, page: undefined })}>{st(lang, "allTypes")}</Link>
            {r.types.map((t) => <Link key={t} className={`pf-chip ${f.type === t ? "on" : ""}`} href={qs({ type: t, page: undefined })}>{stDyn(lang, t)}</Link>)}
          </div>
        )}
        <div className="pf-bar"><h2>{r.total.toLocaleString(lang === "ar" ? "ar-AE" : "en-US")} {st(lang, "results")}</h2>
          <span className="pf-tabs" style={{ marginBottom: 0 }}><Link href={qs({ view: undefined, page: undefined })} className={sp.view !== "map" ? "pf-btn" : "pf-btn alt"} style={{ padding: "7px 16px" }}>{st(lang, "viewList")}</Link><Link href={qs({ view: "map", page: undefined })} className={sp.view === "map" ? "pf-btn" : "pf-btn alt"} style={{ padding: "7px 16px" }}>{st(lang, "viewMap")}</Link></span></div>
        {sp.view === "map" && (
          <div style={{ marginBottom: 22 }}>
            <LazyMap height={520} pins={r.cards.filter((c) => c.lat != null && c.lng != null).map((c) => ({ id: c.reference, lat: c.lat!, lng: c.lng!, title: c.title, subtitle: [c.building, c.community].filter(Boolean).join(", "), href: `${base}/${c.reference}?lang=${lang}`, image: c.cover ? `/media/${c.token}/${c.cover}` : null, precise: c.exact, label: c.price ? `${c.currency} ${c.price >= 1_000_000 ? `${(c.price / 1_000_000).toFixed(c.price % 1_000_000 ? 2 : 0)}M` : `${Math.round(c.price / 1000)}K`}` : "?" }))} />
            <p className="pf-mute" style={{ fontSize: ".8rem", marginTop: 6 }}>{st(lang, "approxLocation")}</p>
          </div>
        )}
        <div className="pf-cards">
          {r.cards.map((c, i) => (
            <Reveal key={c.reference} delay={(i % 6) * 60}>
              <Link href={`${base}/${c.reference}?lang=${lang}`} className="pf-card" style={{ height: "100%" }}>
                <div className="pf-ph">
                  {c.cover && <img src={`/media/${c.token}/${c.cover}`} alt={c.title} loading="lazy" />}
                  <span className="pf-tags">{c.featured && <span className="pf-tag hot">{st(lang, "featured")}</span>}{c.offPlan && <span className="pf-tag brand">{st(lang, "offPlan")}</span>}<span className="pf-tag">{c.purpose === "rent" ? st(lang, "rent") : st(lang, "buy")}</span></span>
                  <span className="pf-price">{price(c.price, c.currency, lang, c.rentFrequency, c.purpose)}</span>
                </div>
                <div className="pf-body">
                  <h3>{c.title}</h3>
                  <p className="pf-mute" style={{ fontSize: ".88rem" }}>{[c.building, c.community].filter(Boolean).join(", ")}</p>
                  <p className="pf-facts"><span><b>{c.bedrooms ?? "-"}</b> {st(lang, "beds")}</span><span><b>{c.bathrooms ?? "-"}</b> {st(lang, "baths")}</span><span><b>{area(c.areaSqft, site.settings.areaUnit, lang)}</b></span></p>
                  {c.pricePerSqft && <p className="pf-mute" style={{ fontSize: ".78rem" }}>{c.currency} {c.pricePerSqft.toLocaleString(lang === "ar" ? "ar-AE" : "en-US")} / sqft</p>}
                </div>
              </Link>
            </Reveal>
          ))}
        </div>
        {r.cards.length === 0 && <p className="pf-empty">{st(lang, "noResults")}</p>}
        {r.pages > 1 && (
          <nav className="pf-pager" aria-label="Pagination">
            {r.page > 1 && <Link className="pf-btn alt" href={qs({ page: String(r.page - 1) })}>{st(lang, "prev")}</Link>}
            <span className="pf-mute">{r.page} / {r.pages}</span>
            {r.page < r.pages && <Link className="pf-btn alt" href={qs({ page: String(r.page + 1) })}>{st(lang, "next")}</Link>}
          </nav>
        )}
      </section>
    </SiteShell>
  );
}

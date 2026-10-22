import Link from "next/link";
import type { PublicSite } from "@reales/domain";
import { st, type SiteLang } from "@/lib/site-i18n";

/** Header, footer and branding of the public property website. Server-rendered; the tenant colour drives every accent through --pf. */
export function SiteShell({ site, lang, children, path = "" }: { site: PublicSite; lang: SiteLang; children: React.ReactNode; path?: string }) {
  const s = site.settings, base = `/p/${site.slug}`, other: SiteLang = lang === "ar" ? "en" : "ar";
  const wa = s.whatsapp?.replace(/[^\d]/g, "");
  return (
    <div className="pf" dir={lang === "ar" ? "rtl" : "ltr"} lang={lang} style={{ ["--pf" as string]: s.primaryColor }}>
      <header className="pf-head">
        <div className="pf-wrap">
          <Link href={`${base}?lang=${lang}`} className="pf-logo">
            {s.logoUrl ? <img src={s.logoUrl} alt="" style={{ height: 36, width: "auto" }} /> : <i>{s.title[0]}</i>}
            <span>{s.title}</span>
          </Link>
          <nav className="pf-nav" aria-label="Main">
            <Link href={`${base}?purpose=sale&lang=${lang}`}>{st(lang, "buy")}</Link>
            <Link href={`${base}?purpose=rent&lang=${lang}`}>{st(lang, "rent")}</Link>
            <Link href={`${base}${path}?lang=${other}`} hrefLang={other}>{other === "ar" ? "العربية" : "English"}</Link>
            {s.phone && <a className="pf-cta" href={`tel:${s.phone}`}>{st(lang, "call")}</a>}
          </nav>
        </div>
      </header>
      <main>{children}</main>
      <footer className="pf-foot">
        <div className="pf-wrap">
          <div className="cols">
            <div><h4>{s.title}</h4>{s.tagline && <p>{s.tagline}</p>}{s.about && <p style={{ marginTop: 8, fontSize: ".9rem" }}>{s.about}</p>}</div>
            <div style={{ fontSize: ".92rem", display: "grid", gap: 6, alignContent: "start" }}><h4>{st(lang, "contactUs")}</h4>
              {s.phone && <a href={`tel:${s.phone}`}>{s.phone}</a>}{wa && <a href={`https://wa.me/${wa}`} rel="noopener noreferrer" target="_blank">{st(lang, "whatsapp")}</a>}
              {s.email && <a href={`mailto:${s.email}`}>{s.email}</a>}{s.address && <span>{s.address}</span>}</div>
            <div style={{ fontSize: ".92rem", display: "grid", gap: 6, alignContent: "start" }}>{Object.entries(s.social).length > 0 && <h4>&nbsp;</h4>}{Object.entries(s.social).map(([k, v]) => <a key={k} href={v} rel="noopener noreferrer" target="_blank" style={{ textTransform: "capitalize" }}>{k}</a>)}</div>
          </div>
          <small>&copy; {new Date().getFullYear()} {s.title}</small>
        </div>
      </footer>
    </div>
  );
}

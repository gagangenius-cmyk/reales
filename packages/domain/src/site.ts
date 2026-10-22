import { QueryTypes, Sequelize } from "sequelize";
import { systemContext, type RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { getPublicListing, type PublicListing } from "./listing-details";
import { plain } from "./scope";
import { ConflictError, withUow } from "./uow";

export interface SiteSettingsInput {
  enabled?: boolean; title?: string | null; tagline?: string | null; about?: string | null; phone?: string | null; whatsapp?: string | null; email?: string | null; address?: string | null;
  logoUrl?: string | null; primaryColor?: string | null; defaultLanguage?: "en" | "ar"; showPrices?: boolean; areaUnit?: "sqft" | "sqm"; seoDescription?: string | null; social?: Record<string, string>;
}
const COLOR = /^#[0-9a-fA-F]{6}$/;
const httpUrl = (v: string, label: string) => { try { const u = new URL(v); if (!["http:", "https:"].includes(u.protocol)) throw new Error(); return u.toString().slice(0, 400); } catch { throw new ConflictError(`${label} must be a full http(s) link`); } };

export async function getSiteSettings(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "site.manage");
  return withUow(sq, ctx, async (u) => {
    const s: any = await u.repo("SiteSetting").findOne({ transaction: u.tx });
    const [t] = await u.sq.query<{ slug: string; name: string }>("SELECT slug, name FROM tenants WHERE id=:t", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT });
    return { slug: t!.slug, tenantName: t!.name, settings: s ? plain(s) : null };
  });
}

export async function saveSiteSettings(sq: Sequelize, ctx: RequestContext, i: SiteSettingsInput) {
  authorize(ctx, "site.manage");
  const v: Record<string, unknown> = {};
  const text = (k: keyof SiteSettingsInput, col: string, max: number) => { if (i[k] !== undefined) v[col] = typeof i[k] === "string" ? (i[k] as string).trim().slice(0, max) || null : null; };
  text("title", "title", 120); text("tagline", "tagline", 200); text("about", "about", 8000); text("phone", "phone", 40); text("whatsapp", "whatsapp", 40); text("address", "address", 255); text("seoDescription", "seoDescription", 300);
  if (i.email !== undefined) { if (i.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(i.email)) throw new ConflictError("Invalid email address"); v.email = i.email?.trim() || null; }
  if (i.logoUrl !== undefined) v.logoUrl = i.logoUrl ? httpUrl(i.logoUrl, "Logo link") : null;
  if (i.primaryColor !== undefined) { if (i.primaryColor && !COLOR.test(i.primaryColor)) throw new ConflictError("Colour must look like #4f46e5"); v.primaryColor = i.primaryColor || null; }
  if (i.defaultLanguage !== undefined) v.defaultLanguage = i.defaultLanguage === "ar" ? "ar" : "en";
  if (i.areaUnit !== undefined) v.areaUnit = i.areaUnit === "sqm" ? "sqm" : "sqft";
  if (i.showPrices !== undefined) v.showPrices = !!i.showPrices;
  if (i.enabled !== undefined) v.enabled = !!i.enabled;
  if (i.social !== undefined) v.social = Object.fromEntries(Object.entries(i.social).filter(([, x]) => x).slice(0, 8).map(([k, x]) => [k.slice(0, 20), httpUrl(x, `${k} link`)]));
  return withUow(sq, ctx, async (u) => {
    const cur: any = await u.repo("SiteSetting").findOne({ transaction: u.tx });
    if (cur) await u.repo("SiteSetting").updateById(cur.get("id"), v, { transaction: u.tx });
    else await u.repo("SiteSetting").create({ id: (await import("node:crypto")).randomUUID(), enabled: false, defaultLanguage: "en", showPrices: true, areaUnit: "sqft", ...v }, { transaction: u.tx });
    await u.audit({ action: "site.settings_saved", entityType: "site", entityId: ctx.tenantId, after: Object.keys(v) });
    return plain(await u.repo("SiteSetting").findOne({ transaction: u.tx }));
  });
}

// ------------------------------------------------------------------ public reads (no session)
export interface PublicSite { tenantId: string; slug: string; name: string; settings: { title: string; tagline: string | null; about: string | null; phone: string | null; whatsapp: string | null; email: string | null; address: string | null; logoUrl: string | null; primaryColor: string; defaultLanguage: "en" | "ar"; showPrices: boolean; areaUnit: "sqft" | "sqm"; seoDescription: string | null; social: Record<string, string> } }

/** The website of a tenant, or null when it does not exist or has not been switched on. Same answer for both, so the slug does not reveal who is a customer. */
export async function resolveSite(sq: Sequelize, slug: string): Promise<PublicSite | null> {
  if (!/^[a-z0-9-]{2,100}$/.test(slug)) return null;
  const [t] = await sq.query<{ id: string; slug: string; name: string }>("SELECT id, slug, name FROM tenants WHERE slug=:s AND status='active'", { replacements: { s: slug }, type: QueryTypes.SELECT });
  if (!t) return null;
  const s: any = await withUow(sq, systemContext(t.id, "corr_site"), (u) => u.repo("SiteSetting").findOne({ where: { enabled: true }, transaction: u.tx }));
  if (!s) return null;
  return {
    tenantId: t.id, slug: t.slug, name: t.name,
    settings: { title: s.get("title") ?? t.name, tagline: s.get("tagline"), about: s.get("about"), phone: s.get("phone"), whatsapp: s.get("whatsapp"), email: s.get("email"), address: s.get("address"), logoUrl: s.get("logoUrl"), primaryColor: s.get("primaryColor") ?? "#4f46e5", defaultLanguage: s.get("defaultLanguage") ?? "en", showPrices: s.get("showPrices") !== false, areaUnit: s.get("areaUnit") ?? "sqft", seoDescription: s.get("seoDescription"), social: s.get("social") ?? {} },
  };
}

export interface SiteFilters { purpose?: "sale" | "rent"; type?: string; beds?: number; minPrice?: number; maxPrice?: number; community?: string; q?: string; sort?: "newest" | "price_asc" | "price_desc"; page?: number }
export interface SiteCard { reference: string; token: string; title: string; purpose: string; price: number | null; currency: string; rentFrequency: string | null; bedrooms: number | null; bathrooms: number | null; areaSqft: number | null; type: string | null; community: string | null; building: string | null; cover: string | null; featured: boolean; offPlan: boolean; furnishing: string | null }
const PER_PAGE = 12;

/** Browse the site: only published listings whose public page is on. Filters are applied in SQL with bound parameters; sorting puts featured listings first. */
export async function searchSiteListings(sq: Sequelize, site: PublicSite, f: SiteFilters) {
  const page = Math.max(1, Math.floor(f.page ?? 1));
  const where: string[] = ["l.tenant_id = :t", "l.status = 'published'", "l.share_enabled = 1", "l.share_token IS NOT NULL"];
  const rep: Record<string, unknown> = { t: site.tenantId, limit: PER_PAGE, offset: (page - 1) * PER_PAGE };
  if (f.purpose === "sale" || f.purpose === "rent") { where.push("l.purpose = :purpose"); rep.purpose = f.purpose; }
  if (f.type && /^[a-z_]{2,20}$/.test(f.type)) { where.push("un.type = :type"); rep.type = f.type; }
  if (f.beds !== undefined && Number.isInteger(f.beds) && f.beds >= 0) { where.push(f.beds >= 5 ? "un.bedrooms >= 5" : "un.bedrooms = :beds"); rep.beds = f.beds; }
  if (f.minPrice !== undefined && f.minPrice >= 0) { where.push("l.price >= :minp"); rep.minp = f.minPrice; }
  if (f.maxPrice !== undefined && f.maxPrice > 0) { where.push("l.price <= :maxp"); rep.maxp = f.maxPrice; }
  if (f.community?.trim()) { where.push("b.community = :community"); rep.community = f.community.trim().slice(0, 120); }
  if (f.q?.trim()) { where.push("(l.title LIKE :q OR l.reference LIKE :q OR b.name LIKE :q OR b.community LIKE :q)"); rep.q = `%${f.q.trim().replace(/[\\%_]/g, (m) => "\\" + m).slice(0, 80)}%`; }
  const order = f.sort === "price_asc" ? "l.price ASC" : f.sort === "price_desc" ? "l.price DESC" : "l.published_at DESC";
  const from = `FROM listings l JOIN units un ON un.id = l.unit_id AND un.tenant_id = l.tenant_id JOIN buildings b ON b.id = un.building_id AND b.tenant_id = l.tenant_id JOIN real_estate_projects p ON p.id = b.re_project_id AND p.tenant_id = l.tenant_id WHERE l.deleted_at IS NULL AND un.deleted_at IS NULL AND ${where.join(" AND ")}`;
  const [rows, [count], communities, types] = await Promise.all([
    sq.query<any>(`SELECT l.reference, l.share_token AS token, l.title, l.purpose, l.price, l.currency, l.rent_frequency, l.featured, l.cover_media_id, l.furnishing, un.bedrooms, un.bathrooms, un.area_sqft, un.type, b.community, b.name AS building, p.kind AS project_kind ${from} ORDER BY l.featured DESC, ${order} LIMIT :limit OFFSET :offset`, { replacements: rep, type: QueryTypes.SELECT }),
    sq.query<{ n: number }>(`SELECT COUNT(*) AS n ${from}`, { replacements: rep, type: QueryTypes.SELECT }),
    sq.query<{ community: string }>("SELECT DISTINCT b.community FROM listings l JOIN units un ON un.id=l.unit_id AND un.tenant_id=l.tenant_id JOIN buildings b ON b.id=un.building_id AND b.tenant_id=l.tenant_id WHERE l.tenant_id=:t AND l.deleted_at IS NULL AND l.status='published' AND l.share_enabled=1 AND b.community IS NOT NULL ORDER BY b.community LIMIT 100", { replacements: { t: site.tenantId }, type: QueryTypes.SELECT }),
    sq.query<{ type: string }>("SELECT DISTINCT un.type FROM listings l JOIN units un ON un.id=l.unit_id AND un.tenant_id=l.tenant_id WHERE l.tenant_id=:t AND l.deleted_at IS NULL AND l.status='published' AND l.share_enabled=1", { replacements: { t: site.tenantId }, type: QueryTypes.SELECT }),
  ]);
  const total = Number(count?.n ?? 0);
  const cards: SiteCard[] = rows.map((r) => ({
    reference: r.reference ?? "", token: r.token, title: r.title ?? `${r.type ?? "Property"} for ${r.purpose}`, purpose: r.purpose, price: site.settings.showPrices && r.price != null ? Number(r.price) : null, currency: r.currency, rentFrequency: r.rent_frequency,
    bedrooms: r.bedrooms, bathrooms: r.bathrooms, areaSqft: r.area_sqft != null ? Number(r.area_sqft) : null, type: r.type, community: r.community, building: r.building, cover: r.cover_media_id, featured: !!r.featured, offPlan: r.project_kind === "off_plan", furnishing: r.furnishing,
  }));
  return { cards, total, page, pages: Math.max(1, Math.ceil(total / PER_PAGE)), communities: communities.map((c) => c.community), types: types.map((t) => t.type) };
}

/** One listing on the site, found by its reference (RLS-000123). Hides the price when the site is set not to show prices. */
export async function getSiteListing(sq: Sequelize, site: PublicSite, reference: string, countView = true): Promise<PublicListing | null> {
  if (!/^[A-Za-z0-9-]{3,30}$/.test(reference)) return null;
  const [row] = await sq.query<{ share_token: string }>("SELECT share_token FROM listings WHERE tenant_id=:t AND deleted_at IS NULL AND reference=:r AND status='published' AND share_enabled=1 AND share_token IS NOT NULL", { replacements: { t: site.tenantId, r: reference }, type: QueryTypes.SELECT });
  if (!row) return null;
  const l = await getPublicListing(sq, row.share_token, countView);
  return l && !site.settings.showPrices ? { ...l, price: null } : l;
}

/** All public listing references with their last change, for sitemap.xml. */
export async function siteSitemap(sq: Sequelize, site: PublicSite) {
  return sq.query<{ reference: string; updated_at: Date }>("SELECT reference, updated_at FROM listings WHERE tenant_id=:t AND deleted_at IS NULL AND status='published' AND share_enabled=1 AND reference IS NOT NULL ORDER BY published_at DESC LIMIT 5000", { replacements: { t: site.tenantId }, type: QueryTypes.SELECT });
}

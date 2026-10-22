import PDFDocument from "pdfkit";
import { QueryTypes, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { amenityLabel } from "./amenities";
import { getListingDetail, getPublicListing, type PublicListing } from "./listing-details";
import { getStorage } from "./storage";
import { Uow, withUow } from "./uow";
import { Op } from "sequelize";

export interface BrochureData {
  reference: string; title: string; purpose: string; priceLine: string | null; description: string | null; facts: [string, string][]; features: string[]; location: string;
  agency: string | null; permitNo: string | null; contactLines: string[]; heroImage?: Buffer | null; galleryImages: Buffer[]; floorPlanImages: Buffer[]; accent?: string;
}

const latin = (s: string) => String(s ?? "").replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ]/g, "?");

/**
 * A printable brochure: hero photo, price and key facts, description, amenities, a gallery and the floor plan(s), with the advertising permit number.
 * Built-in Helvetica means Latin text only (the Arabic copy lives on the website and in the portal feeds). PNG and JPEG photos are embedded; any
 * other format is skipped rather than failing the whole document.
 */
export function renderBrochure(d: BrochureData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0, info: { Title: latin(d.title), Producer: "Reales CRM" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const W = doc.page.width, H = doc.page.height, M = 40, accent = d.accent ?? "#4f46e5";
    const img = (buf: Buffer | null | undefined, x: number, y: number, w: number, h: number) => {
      if (!buf) return false;
      try { doc.save().rect(x, y, w, h).clip().image(buf, x, y, { cover: [w, h], align: "center", valign: "center" }).restore(); return true; } catch { doc.restore(); return false; }
    };

    // page 1: hero
    doc.rect(0, 0, W, 330).fill("#e5e7eb");
    img(d.heroImage, 0, 0, W, 330);
    doc.rect(0, 330, W, 6).fill(accent);
    doc.fillColor("#111111").font("Helvetica-Bold").fontSize(22).text(latin(d.title), M, 352, { width: W - 2 * M });
    doc.font("Helvetica").fontSize(11).fillColor("#555555").text(latin(d.location), M, doc.y + 2, { width: W - 2 * M });
    if (d.priceLine) doc.moveDown(0.5).font("Helvetica-Bold").fontSize(20).fillColor(accent).text(latin(d.priceLine), M, doc.y, { width: W - 2 * M });
    // key facts as a row of boxes
    const y0 = doc.y + 14, n = Math.min(d.facts.length, 5) || 1, bw = (W - 2 * M - (n - 1) * 8) / n;
    d.facts.slice(0, 5).forEach(([k, v], i) => {
      const x = M + i * (bw + 8);
      doc.roundedRect(x, y0, bw, 46, 6).fill("#f3f4f6");
      doc.fillColor("#6b7280").font("Helvetica").fontSize(8).text(latin(k).toUpperCase(), x + 8, y0 + 9, { width: bw - 16 });
      doc.fillColor("#111111").font("Helvetica-Bold").fontSize(13).text(latin(v), x + 8, y0 + 23, { width: bw - 16 });
    });
    doc.y = y0 + 64;
    if (d.description) doc.fillColor("#111111").font("Helvetica-Bold").fontSize(12).text("About this property", M, doc.y).moveDown(0.3).font("Helvetica").fontSize(10).fillColor("#333333").text(latin(d.description), M, doc.y, { width: W - 2 * M, height: H - doc.y - 190, ellipsis: true });
    // features
    if (d.features.length) {
      const fy = Math.max(doc.y + 12, H - 190);
      doc.fillColor("#111111").font("Helvetica-Bold").fontSize(12).text("Features and amenities", M, fy);
      const cols = 3, cw = (W - 2 * M) / cols;
      d.features.slice(0, 18).forEach((f, i) => doc.fillColor(accent).font("Helvetica-Bold").fontSize(9).text("+", M + (i % cols) * cw, fy + 20 + Math.floor(i / cols) * 14, { continued: true }).fillColor("#333333").font("Helvetica").text(`  ${latin(f)}`, { width: cw - 8 }));
    }
    // footer on each page
    const footer = () => {
      doc.rect(0, H - 54, W, 54).fill("#111827");
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9).text(latin([d.agency, ...d.contactLines].filter(Boolean).join("   |   ")), M, H - 40, { width: W - 2 * M });
      doc.font("Helvetica").fontSize(7).fillColor("#9ca3af").text(latin(`Ref ${d.reference}${d.permitNo ? `   |   Permit ${d.permitNo}` : ""}   |   Information is believed accurate but not guaranteed. Subject to availability.`), M, H - 24, { width: W - 2 * M });
    };
    footer();

    // gallery page
    if (d.galleryImages.length) {
      doc.addPage(); footer();
      doc.fillColor("#111111").font("Helvetica-Bold").fontSize(14).text("Gallery", M, M);
      const gw = (W - 2 * M - 10) / 2, gh = 170;
      d.galleryImages.slice(0, 8).forEach((b, i) => { const x = M + (i % 2) * (gw + 10), y = M + 30 + Math.floor(i / 2) * (gh + 10); doc.rect(x, y, gw, gh).fill("#e5e7eb"); img(b, x, y, gw, gh); });
    }
    // floor plans
    for (const fp of d.floorPlanImages.slice(0, 3)) {
      doc.addPage(); footer();
      doc.fillColor("#111111").font("Helvetica-Bold").fontSize(14).text("Floor plan", M, M);
      doc.rect(M, M + 30, W - 2 * M, H - 2 * M - 90).fill("#ffffff").strokeColor("#e5e7eb").stroke();
      try { doc.image(fp, M + 8, M + 38, { fit: [W - 2 * M - 16, H - 2 * M - 106], align: "center", valign: "center" }); } catch { /* unsupported image: skip */ }
    }
    doc.end();
  });
}

const money = (n: number | null, c: string, per?: string | null) => (n == null ? null : `${c} ${n.toLocaleString("en-US")}${per ? ` / ${per === "yearly" ? "year" : per === "monthly" ? "month" : "quarter"}` : ""}`);
async function fetchImages(keys: string[]): Promise<Buffer[]> { const out: Buffer[] = []; for (const k of keys) { try { out.push(await getStorage().get(k)); } catch { /* missing object: skip */ } } return out; }

/** Brochure for a signed-in user who can see the listing (includes unpublished drafts). */
export async function listingBrochure(sq: Sequelize, ctx: RequestContext, id: string, accent?: string) {
  const d: any = await getListingDetail(sq, ctx, id);
  const images = d.media.filter((m: any) => m.kind === "image" && /image\/(jpeg|png)/.test(m.mime ?? ""));
  const cover = images.find((m: any) => m.id === d.coverMediaId) ?? images[0];
  const [hero, gallery, plans] = await Promise.all([
    cover ? fetchImages([cover.storageKey]) : [], fetchImages(images.filter((m: any) => m !== cover).slice(0, 8).map((m: any) => m.storageKey)),
    fetchImages(d.media.filter((m: any) => m.kind === "floorplan" && /image\/(jpeg|png)/.test(m.mime ?? "")).slice(0, 3).map((m: any) => m.storageKey)),
  ]);
  const [tenant] = (await withUow(sq, ctx, async (u) => u.sq.query<{ name: string }>("SELECT name FROM tenants WHERE id=:t", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT }))) as { name: string }[];
  const u = d.unit ?? {}, b = d.building ?? {};
  const bytes = await renderBrochure({
    reference: d.reference, title: d.title ?? `${u.type ?? "Property"} for ${d.purpose}`, purpose: d.purpose, priceLine: money(d.price != null ? Number(d.price) : null, d.currency, d.purpose === "rent" ? d.rentFrequency ?? "yearly" : null), description: d.description,
    facts: [["Bedrooms", String(u.bedrooms ?? "-")], ["Bathrooms", String(u.bathrooms ?? "-")], ["Area", u.areaSqft ? `${Number(u.areaSqft).toLocaleString("en-US")} sqft` : "-"], ["Type", String(u.type ?? "-")], ["Furnishing", d.furnishing ? String(d.furnishing).replace("_", " ") : "-"]],
    features: (d.features ?? []).map((f: string) => amenityLabel(f)), location: [b.name, b.community, b.city].filter(Boolean).join(", "), agency: tenant?.name ?? null,
    permitNo: (d.permits ?? []).find((p: any) => p.status === "valid")?.permitNo ?? null, contactLines: [d.agentEmail].filter(Boolean), heroImage: hero[0] ?? null, galleryImages: gallery, floorPlanImages: plans, accent,
  });
  return bytes;
}

/** The same brochure for the public link: only a published listing with its public page on. */
export async function publicBrochure(sq: Sequelize, token: string, o: { accent?: string; phone?: string | null; email?: string | null } = {}) {
  const l: PublicListing | null = await getPublicListing(sq, token, false);
  if (!l) return null;
  const keyOf = async (id: string) => {
    const [row] = await sq.query<{ storage_key: string }>("SELECT m.storage_key FROM listing_media m JOIN listings l ON l.id=m.listing_id AND l.tenant_id=m.tenant_id WHERE l.share_token=:t AND l.deleted_at IS NULL AND m.id=:m", { replacements: { t: token, m: id }, type: QueryTypes.SELECT }) as { storage_key: string }[];
    return row?.storage_key;
  };
  const imgs = l.photos.filter((p) => p.kind === "image"), plans = l.photos.filter((p) => p.kind === "floorplan");
  const cover = imgs.find((p) => p.id === l.cover) ?? imgs[0];
  const pick = async (ps: { id: string }[]) => (await Promise.all(ps.map((p) => keyOf(p.id)))).filter((k): k is string => !!k);
  const [hero, gallery, fplans] = await Promise.all([cover ? pick([cover]).then(fetchImages) : [], pick(imgs.filter((p) => p !== cover).slice(0, 8)).then(fetchImages), pick(plans.slice(0, 3)).then(fetchImages)]);
  return renderBrochure({
    reference: l.reference, title: l.title, purpose: l.purpose, priceLine: money(l.price, l.currency, l.purpose === "rent" ? l.rentFrequency ?? "yearly" : null), description: l.description,
    facts: [["Bedrooms", String(l.bedrooms ?? "-")], ["Bathrooms", String(l.bathrooms ?? "-")], ["Area", l.areaSqft ? `${l.areaSqft.toLocaleString("en-US")} sqft` : "-"], ["Type", String(l.type ?? "-")], ["Furnishing", l.furnishing ? l.furnishing.replace("_", " ") : "-"]],
    features: l.features.map((f) => amenityLabel(f)), location: [l.building, l.community, l.city].filter(Boolean).join(", "), agency: l.agency, permitNo: l.permitNo, contactLines: [o.phone, o.email].filter((x): x is string => !!x),
    heroImage: hero[0] ?? null, galleryImages: gallery, floorPlanImages: fplans, accent: o.accent,
  });
}
void Op; void (null as unknown as Uow);

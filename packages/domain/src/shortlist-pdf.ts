import PDFDocument from "pdfkit";
import { QueryTypes, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { amenityLabel } from "./amenities";
import { getListingDetail } from "./listing-details";
import { getStorage } from "./storage";
import { ConflictError, withUow } from "./uow";
import { mysqlDate } from "@reales/database";
import { randomUUID } from "node:crypto";

export interface ShortlistOptions {
  listingIds: string[]; clientName?: string; title?: string; notes?: string; leadId?: string;
  layout?: "table" | "detailed" | "both"; showPrice?: boolean; includePhotos?: boolean; includeFloorPlans?: boolean; accent?: string; validityDays?: number;
}

export interface ShortlistItem {
  reference: string; title: string; purpose: string; location: string; type: string; bedrooms: string; bathrooms: string; area: string; price: string; availability: string; furnishing: string;
  description: string | null; features: string[]; permitNo: string | null; hero: Buffer | null; gallery: Buffer[]; floorPlans: Buffer[];
}
export interface ShortlistData { title: string; clientName: string | null; agency: string; agentLine: string | null; notes: string | null; generatedOn: string; validUntil: string | null; layout: "table" | "detailed" | "both"; showPrice: boolean; accent: string; items: ShortlistItem[] }

const latin = (s: unknown) => String(s ?? "").replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ]/g, "?");
export const AVAILABILITY_LABEL: Record<string, string> = { available: "Available", reserved: "Reserved", sold: "Sold", rented: "Rented", blocked: "Not available" };

/**
 * A client-ready PDF built from the listings an agent picked for a requirement: a cover with the client's name, an availability table (one row per
 * property with its current availability) and, optionally, one page per property with photos, facts, amenities and floor plan. Built-in Helvetica
 * means Latin text only; unsupported image formats are skipped rather than failing the document.
 */
export function renderShortlist(d: ShortlistData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 0, info: { Title: latin(d.title), Producer: "Reales CRM" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const W = doc.page.width, H = doc.page.height, M = 40, a = d.accent;
    const img = (buf: Buffer | null | undefined, x: number, y: number, w: number, h: number) => {
      if (!buf) return false;
      try { doc.save().rect(x, y, w, h).clip().image(buf, x, y, { cover: [w, h], align: "center", valign: "center" }).restore(); return true; } catch { doc.restore(); return false; }
    };
    let page = 1;
    const footer = () => {
      doc.rect(0, H - 40, W, 40).fill("#111827");
      doc.fillColor("#ffffff").font("Helvetica").fontSize(8).text(latin(`${d.agency}${d.agentLine ? `   |   ${d.agentLine}` : ""}`), M, H - 28, { width: W - 2 * M - 60, lineBreak: false });
      doc.fillColor("#9ca3af").text(`Page ${page}`, W - M - 50, H - 28, { width: 50, align: "right", lineBreak: false });
    };
    const newPage = () => { doc.addPage(); page++; footer(); };

    // cover
    doc.rect(0, 0, W, 250).fill(a);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(30).text(latin(d.title), M, 90, { width: W - 2 * M });
    if (d.clientName) doc.font("Helvetica").fontSize(15).text(latin(`Prepared for ${d.clientName}`), M, doc.y + 8, { width: W - 2 * M });
    doc.fillColor("#111111").font("Helvetica-Bold").fontSize(13).text(latin(d.agency), M, 285);
    doc.font("Helvetica").fontSize(10).fillColor("#555555").text(latin(`${d.items.length} ${d.items.length === 1 ? "property" : "properties"} selected   |   ${d.generatedOn}${d.validUntil ? `   |   Availability and prices confirmed until ${d.validUntil}` : ""}`), M, doc.y + 4, { width: W - 2 * M });
    if (d.agentLine) doc.moveDown(0.6).fillColor("#111111").text(latin(`Your contact: ${d.agentLine}`), M, doc.y, { width: W - 2 * M });
    if (d.notes) { doc.moveDown(1).font("Helvetica-Bold").fontSize(11).fillColor("#111111").text("Notes", M, doc.y); doc.font("Helvetica").fontSize(10).fillColor("#333333").text(latin(d.notes), M, doc.y + 2, { width: W - 2 * M }); }
    footer();

    // availability table
    if (d.layout !== "detailed") {
      newPage();
      doc.fillColor("#111111").font("Helvetica-Bold").fontSize(16).text("Availability", M, M);
      const cols: [string, number, "left" | "right"][] = [["#", 22, "left"], ["Property", 150, "left"], ["Type", 62, "left"], ["Beds", 30, "right"], ["Baths", 32, "right"], ["Area", 62, "right"], ...(d.showPrice ? [["Price", 86, "right"] as [string, number, "right"]] : []), ["Status", 62, "left"]];
      const total = cols.reduce((x, c) => x + c[1], 0), scale = (W - 2 * M) / total;
      const widths = cols.map((c) => c[1] * scale);
      const xs = widths.reduce<number[]>((acc, w, i) => (acc.push(i === 0 ? M : acc[i - 1]! + widths[i - 1]!), acc), []);
      const head = (y: number) => { doc.rect(M, y, W - 2 * M, 20).fill("#f3f4f6"); doc.fillColor("#374151").font("Helvetica-Bold").fontSize(8); cols.forEach((c, i) => doc.text(c[0].toUpperCase(), xs[i]! + 3, y + 6, { width: widths[i]! - 6, align: c[2], lineBreak: false })); };
      let y = M + 30; head(y); y += 22;
      d.items.forEach((it, n) => {
        const cells = [String(n + 1), `${it.location || it.title}\n${it.reference}`, it.type, it.bedrooms, it.bathrooms, it.area, ...(d.showPrice ? [it.price] : []), it.availability];
        doc.font("Helvetica").fontSize(9);
        const h = Math.max(26, ...cells.map((c, i) => doc.heightOfString(latin(c), { width: widths[i]! - 6 }) + 10));
        if (y + h > H - 60) { newPage(); y = M; head(y); y += 22; }
        if (n % 2) doc.rect(M, y - 2, W - 2 * M, h).fill("#fafafa");
        cells.forEach((c, i) => {
          const isStatus = i === cells.length - 1;
          doc.fillColor(isStatus ? (c === "Available" ? "#047857" : "#b45309") : "#111111").font(isStatus || i === 1 ? "Helvetica-Bold" : "Helvetica").fontSize(9).text(latin(c), xs[i]! + 3, y + 3, { width: widths[i]! - 6, align: cols[i]![2] });
        });
        y += h; doc.moveTo(M, y - 2).lineTo(W - M, y - 2).strokeColor("#e5e7eb").stroke();
      });
      doc.fillColor("#6b7280").font("Helvetica-Oblique").fontSize(8).text("Availability and prices change without notice and are confirmed by the agent at the time of viewing or reservation.", M, y + 10, { width: W - 2 * M });
    }

    // one page per property
    if (d.layout !== "table") {
      for (const it of d.items) {
        newPage();
        doc.rect(0, 0, W, 300).fill("#e5e7eb");
        img(it.hero, 0, 0, W, 300);
        doc.rect(0, 300, W, 5).fill(a);
        doc.fillColor("#111111").font("Helvetica-Bold").fontSize(18).text(latin(it.title), M, 318, { width: W - 2 * M });
        doc.font("Helvetica").fontSize(10).fillColor("#555555").text(latin(it.location), M, doc.y + 2, { width: W - 2 * M });
        if (d.showPrice) doc.font("Helvetica-Bold").fontSize(17).fillColor(a).text(latin(it.price), M, doc.y + 6, { width: W - 2 * M });
        const facts: [string, string][] = [["Type", it.type], ["Beds", it.bedrooms], ["Baths", it.bathrooms], ["Area", it.area], ["Status", it.availability]];
        const fy = doc.y + 10, bw = (W - 2 * M - 4 * 8) / 5;
        facts.forEach(([k, v], i) => { const x = M + i * (bw + 8); doc.roundedRect(x, fy, bw, 38, 5).fill("#f3f4f6"); doc.fillColor("#6b7280").font("Helvetica").fontSize(7).text(k.toUpperCase(), x + 7, fy + 7, { width: bw - 14, lineBreak: false }); doc.fillColor("#111111").font("Helvetica-Bold").fontSize(11).text(latin(v), x + 7, fy + 19, { width: bw - 14, lineBreak: false }); });
        doc.y = fy + 50;
        if (it.description) doc.font("Helvetica").fontSize(9.5).fillColor("#333333").text(latin(it.description), M, doc.y, { width: W - 2 * M, height: 92, ellipsis: true });
        if (it.features.length) {
          const ay = Math.max(doc.y + 8, 560);
          doc.font("Helvetica-Bold").fontSize(10).fillColor("#111111").text("Features", M, ay);
          doc.font("Helvetica").fontSize(8.5).fillColor("#333333").text(latin(it.features.slice(0, 12).join("  |  ")), M, ay + 14, { width: W - 2 * M, height: 40, ellipsis: true });
        }
        if (it.gallery.length) {
          const gy = H - 40 - 74, gw = (W - 2 * M - 16) / 3;
          it.gallery.slice(0, 3).forEach((b, i) => { const x = M + i * (gw + 8); doc.rect(x, gy, gw, 66).fill("#e5e7eb"); img(b, x, gy, gw, 66); });
        }
        doc.fillColor("#6b7280").font("Helvetica").fontSize(7).text(latin(`Ref ${it.reference}${it.permitNo ? `   |   Permit ${it.permitNo}` : ""}`), M, H - 54, { width: W - 2 * M, lineBreak: false });
        for (const fp of it.floorPlans) {
          newPage();
          doc.fillColor("#111111").font("Helvetica-Bold").fontSize(14).text(latin(`Floor plan: ${it.title}`), M, M, { width: W - 2 * M });
          try { doc.image(fp, M, M + 30, { fit: [W - 2 * M, H - 2 * M - 80], align: "center", valign: "center" }); } catch { /* unsupported image: skip */ }
        }
      }
    }
    doc.end();
  });
}

async function fetchImage(key: string | undefined): Promise<Buffer | null> { if (!key) return null; try { return await getStorage().get(key); } catch { return null; } }
const jpegOrPng = (m: any) => /image\/(jpeg|png)/.test(m.mime ?? "");

/** Load the chosen listings (each through the normal visibility rules), build the PDF data and render it. At most 30 properties per document. */
export async function clientListingsPdf(sq: Sequelize, ctx: RequestContext, o: ShortlistOptions) {
  const ids = [...new Set(o.listingIds)];
  if (!ids.length) throw new ConflictError("Choose at least one listing");
  if (ids.length > 30) throw new ConflictError("A shortlist can have at most 30 properties");
  const layout = o.layout ?? "both", showPrice = o.showPrice !== false, withPhotos = o.includePhotos !== false;
  const items: ShortlistItem[] = [];
  for (const id of ids) {
    const l: any = await getListingDetail(sq, ctx, id);
    const u = l.unit ?? {}, b = l.building ?? {};
    const images = (l.media as any[]).filter((m) => m.kind === "image" && jpegOrPng(m)), cover = images.find((m) => m.id === l.coverMediaId) ?? images[0];
    const money = l.price != null ? `${l.currency} ${Number(l.price).toLocaleString("en-US")}${l.purpose === "rent" ? ` / ${l.rentFrequency === "monthly" ? "month" : l.rentFrequency === "quarterly" ? "quarter" : "year"}` : ""}` : "On request";
    items.push({
      reference: l.reference, title: l.title ?? `${u.type ?? "Property"} for ${l.purpose}`, purpose: l.purpose, location: [b.name, b.community, b.city].filter(Boolean).join(", "), type: String(u.type ?? "-"),
      bedrooms: u.bedrooms != null ? (u.bedrooms === 0 ? "Studio" : String(u.bedrooms)) : "-", bathrooms: String(u.bathrooms ?? "-"), area: u.areaSqft ? `${Math.round(Number(u.areaSqft)).toLocaleString("en-US")} sqft` : "-", price: money,
      availability: l.status === "published" || l.status === "draft" ? AVAILABILITY_LABEL[u.status] ?? "Check availability" : "Not available", furnishing: l.furnishing ?? "",
      description: l.description, features: (l.features ?? []).map((f: string) => amenityLabel(f)), permitNo: (l.permits ?? []).find((p: any) => p.status === "valid")?.permitNo ?? null,
      hero: withPhotos ? await fetchImage(cover?.storageKey) : null,
      gallery: withPhotos ? (await Promise.all(images.filter((m) => m !== cover).slice(0, 3).map((m) => fetchImage(m.storageKey)))).filter((x): x is Buffer => !!x) : [],
      floorPlans: o.includeFloorPlans ? (await Promise.all((l.media as any[]).filter((m) => m.kind === "floorplan" && jpegOrPng(m)).slice(0, 2).map((m) => fetchImage(m.storageKey)))).filter((x): x is Buffer => !!x) : [],
    });
  }
  const { agency, me } = await withUow(sq, ctx, async (u) => {
    const [t] = await u.sq.query<{ name: string }>("SELECT name FROM tenants WHERE id=:t", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT });
    const usr: any = await u.repo("User").findById(ctx.userId, { transaction: u.tx });
    return { agency: t?.name ?? "", me: usr?.get("email") ?? null };
  });
  const validUntil = o.validityDays ? new Date(Date.now() + o.validityDays * 86_400_000).toISOString().slice(0, 10) : null;
  const bytes = await renderShortlist({
    title: o.title?.trim() || "Property shortlist", clientName: o.clientName?.trim() || null, agency, agentLine: me, notes: o.notes?.trim() || null,
    generatedOn: new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "long", year: "numeric" }), validUntil, layout, showPrice, accent: /^#[0-9a-fA-F]{6}$/.test(o.accent ?? "") ? o.accent! : "#4f46e5", items,
  });
  if (o.leadId) {
    await withUow(sq, ctx, async (u) => {
      const lead: any = await u.repo("Lead").findById(o.leadId!, { transaction: u.tx });
      if (!lead) return;
      await u.repo("Activity").create({ id: randomUUID(), entityType: "lead", entityId: o.leadId, kind: "note", summary: `Shortlist PDF generated: ${items.length} propert${items.length === 1 ? "y" : "ies"} (${items.map((i) => i.reference).join(", ")})`.slice(0, 4000), actorId: ctx.userId, occurredAt: mysqlDate(new Date()), createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
    });
  }
  return bytes;
}

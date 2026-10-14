import PDFDocument from "pdfkit";
import { Sequelize } from "sequelize";
import { RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { createDocument } from "./documents";
import { getPayment } from "./finance";
import { getLease } from "./leases";
import { getOffer } from "./offers";
import { getOwnerStatement } from "./statements";
import { withUow } from "./uow";

export interface PdfSpec {
  title: string; subtitle?: string; watermark?: string;
  meta?: Array<[string, string]>;
  sections: Array<{ heading: string; paragraphs?: string[]; table?: { columns: string[]; rows: string[][]; align?: Array<"left" | "right"> } }>;
  footer?: string;
}

/**
 * Plain, dependency-light PDF. Uses the built-in Helvetica font: Latin text only. Arabic/RTL documents need an embedded shaping-capable font and are not
 * produced by this renderer (non-Latin characters are replaced with "?" rather than printed as garbage).
 */
export function renderPdf(spec: PdfSpec): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: spec.title, Producer: "Reales CRM" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const latin = (s: string) => String(s ?? "").replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ]/g, "?");
    const W = doc.page.width - 100;

    const watermark = () => {
      if (!spec.watermark) return;
      doc.save().rotate(-35, { origin: [300, 420] }).fontSize(64).fillColor("#e6e6e6").text(latin(spec.watermark), 60, 380, { width: 480, align: "center" }).restore();
      doc.fillColor("#000000");
    };
    watermark();
    doc.on("pageAdded", watermark);

    doc.font("Helvetica-Bold").fontSize(20).text(latin(spec.title));
    if (spec.subtitle) doc.font("Helvetica").fontSize(11).fillColor("#555555").text(latin(spec.subtitle)).fillColor("#000000");
    doc.moveDown(0.8);
    for (const [k, v] of spec.meta ?? []) doc.font("Helvetica-Bold").fontSize(10).text(`${latin(k)}: `, { continued: true }).font("Helvetica").text(latin(v));
    for (const s of spec.sections) {
      doc.moveDown(1).font("Helvetica-Bold").fontSize(13).text(latin(s.heading));
      doc.moveDown(0.3);
      for (const p of s.paragraphs ?? []) doc.font("Helvetica").fontSize(10).text(latin(p), { align: "left" }).moveDown(0.4);
      if (s.table) {
        const cols = s.table.columns.length, cw = W / cols;
        const row = (cells: string[], bold: boolean) => {
          if (doc.y > doc.page.height - 90) doc.addPage();
          const y = doc.y;
          doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
          let h = 12;
          cells.forEach((c, i) => { h = Math.max(h, doc.heightOfString(latin(c), { width: cw - 6 })); });
          cells.forEach((c, i) => doc.text(latin(c), 50 + i * cw, y, { width: cw - 6, align: s.table!.align?.[i] ?? "left" }));
          doc.y = y + h + 4;
          doc.moveTo(50, doc.y - 2).lineTo(50 + W, doc.y - 2).strokeColor("#dddddd").stroke().strokeColor("#000000");
        };
        row(s.table.columns, true);
        for (const r of s.table.rows) row(r, false);
      }
    }
    if (spec.footer) doc.moveDown(1.5).font("Helvetica-Oblique").fontSize(8).fillColor("#555555").text(latin(spec.footer), { align: "left" });
    doc.end();
  });
}

const money = (v: unknown, c = "AED") => `${c} ${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : "-");
const nameOf = (c: any) => [c?.firstName, c?.lastName].filter(Boolean).join(" ") || c?.companyName || "Unnamed";

async function tenantName(sq: Sequelize, ctx: RequestContext) {
  return withUow(sq, ctx, async (u) => ((await u.sq.query<any>("SELECT name FROM tenants WHERE id=:t", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: "SELECT" as any })) as any[])[0]?.name ?? "");
}
async function contactName(sq: Sequelize, ctx: RequestContext, id: string | null | undefined) {
  if (!id) return "-";
  return withUow(sq, ctx, async (u) => nameOf((await u.repo("Contact").findById(id, { transaction: u.tx }))?.get({ plain: true })));
}

// ---------------------------------------------------------------- documents
export async function receiptPdf(sq: Sequelize, ctx: RequestContext, paymentId: string) {
  const p: any = await getPayment(sq, ctx, paymentId); // enforces finance.read (tenant-wide)
  const org = await tenantName(sq, ctx);
  const payer = await contactName(sq, ctx, p.contactId);
  return renderPdf({
    title: "Payment receipt", subtitle: org,
    meta: [["Receipt no.", p.receipt?.number ?? "(not issued)"], ["Date", date(p.receivedAt ?? p.createdAt)], ["Received from", payer], ["Method", String(p.method).replace("_", " ")], ["Status", p.status]],
    sections: [
      { heading: "Amount", paragraphs: [money(p.amount, p.currency)] },
      { heading: "Applied to", table: { columns: ["Invoice / item", "Amount"], rows: p.allocations.map((a: any) => [String(a.invoiceId ?? a.id).slice(0, 8), money(a.amount, p.currency)]), align: ["left", "right"] } },
    ],
    footer: "This receipt acknowledges payment received. It is generated by Reales CRM; VAT treatment follows the related tax invoice.",
  });
}

export async function leaseContractDraftPdf(sq: Sequelize, ctx: RequestContext, leaseId: string) {
  const l: any = await getLease(sq, ctx, leaseId);
  const org = await tenantName(sq, ctx);
  const names = new Map<string, string>();
  for (const p of l.parties) names.set(p.contactId, await contactName(sq, ctx, p.contactId));
  const by = (role: string) => l.parties.filter((p: any) => p.role === role).map((p: any) => names.get(p.contactId)).join(", ") || "-";
  return renderPdf({
    title: "Tenancy agreement (DRAFT)", subtitle: `Prepared by ${org}`, watermark: "DRAFT",
    meta: [["Term", `${l.startsOn} to ${l.endsOn}`], ["Annual rent", money(l.annualRent, l.currency)], ["Instalments", String(l.installments)], ["Registration ref.", l.registrationRef ?? "to be registered"]],
    sections: [
      { heading: "Parties", paragraphs: [`Landlord: ${by("landlord")}`, `Tenant: ${by("tenant")}`, ...(by("guarantor") !== "-" ? [`Guarantor: ${by("guarantor")}`] : [])] },
      { heading: "Rent schedule", table: { columns: ["#", "Due", "Amount"], rows: l.schedule.map((r: any) => [String(r.seq), String(r.dueDate), money(r.amount, l.currency)]), align: ["left", "left", "right"] } },
      { heading: "Security deposit", paragraphs: [l.deposit ? `${money(l.deposit.amount, l.currency)} (${l.deposit.status})` : "None recorded."] },
      { heading: "Addenda", paragraphs: l.addenda.length ? l.addenda.map((a: any) => `${a.title} (effective ${a.effectiveOn})`) : ["None."] },
    ],
    footer: "DRAFT SUMMARY of commercial terms generated from CRM data. It is NOT a legal tenancy contract: use the approved contract form for the jurisdiction, have it reviewed by counsel, and register it with the competent authority (e.g. Ejari/Tawtheeq) before activation.",
  });
}

export async function ownerStatementPdf(sq: Sequelize, ctx: RequestContext, statementId: string) {
  return statementPdfFromRow(await getOwnerStatement(sq, ctx, statementId), await tenantName(sq, ctx));
}

/** Also used by the owner portal, which has already proven the owner may see this statement. */
export function statementPdfFromRow(s: any, org: string) {
  return renderPdf({
    title: `Owner statement ${s.period}`, subtitle: `${org} - portfolio ${s.portfolioName ?? ""}`.trim(), watermark: s.status === "draft" ? "DRAFT" : undefined,
    meta: [["Period", s.period], ["Status", s.status], ["Issued", date(s.issuedAt)]],
    sections: [{
      heading: "Summary",
      table: { columns: ["Item", "Amount"], align: ["left", "right"], rows: [["Rent collected", money(s.rentCollected, s.currency)], [`Management fee (${s.detail?.feePct ?? 0}%)`, `- ${money(s.managementFee, s.currency)}`], ["Maintenance costs", `- ${money(s.maintenanceCost, s.currency)}`], ["Net payable to owner", money(s.netPayable, s.currency)]] },
    }],
    footer: "Figures are calculated from recorded rent allocations and completed work orders for the period. A draft statement is provisional.",
  });
}

export async function offerLetterPdf(sq: Sequelize, ctx: RequestContext, offerId: string) {
  const o: any = await getOffer(sq, ctx, offerId);
  const org = await tenantName(sq, ctx);
  const buyer = await contactName(sq, ctx, o.contactId);
  return renderPdf({
    title: "Offer to purchase", subtitle: org, watermark: o.status === "accepted" ? undefined : "NOT BINDING",
    meta: [["Offer date", date(o.createdAt)], ["Buyer", buyer], ["Status", o.status], ["Valid until", date(o.validUntil)]],
    sections: [
      { heading: "Terms", paragraphs: [`Current offered amount: ${money(o.currentAmount, o.currency ?? "AED")}`, ...(o.depositAmount ? [`Holding deposit: ${money(o.depositAmount, o.currency ?? "AED")}`] : [])] },
      { heading: "Negotiation history", table: { columns: ["Rev.", "Amount", "Party", "Date"], rows: (o.revisions ?? []).map((r: any) => [String(r.revision), money(r.amount, o.currency ?? "AED"), String(r.byParty ?? "-"), date(r.createdAt)]), align: ["left", "right", "left", "left"] } },
    ],
    footer: "This letter records commercial terms only. A binding sale requires the signed sale agreement and the registration steps required by the competent authority.",
  });
}

/** Save a rendered PDF into the document store (immutable versions, content hash, document permissions apply). */
export async function savePdfAsDocument(sq: Sequelize, ctx: RequestContext, title: string, bytes: Buffer, links: Array<{ entityType: any; entityId: string }> = [], kind: "contract" | "receipt" | "invoice" | "other" = "other") {
  authorize(ctx, "document.manage");
  return createDocument(sq, ctx, { title, kind, links, file: { filename: `${title.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80)}.pdf`, mime: "application/pdf", bytes } });
}

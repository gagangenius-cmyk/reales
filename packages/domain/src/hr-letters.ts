import { randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import { Op, QueryTypes, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { logger } from "@reales/observability";
import { authorize, hasPermission } from "@reales/rbac";
import { nextCounter } from "./finance";
import { currentSalaryFor, dubaiDate } from "./hr";
import { getMailer } from "./mailer";
import { plain } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

/**
 * HR letters: offer, appointment, confirmation, warning, NOC, salary certificate, experience and relieving letters. Each company edits its own templates;
 * a letter is rendered from a template and an employee's record, can be adjusted while it is a draft, is numbered when issued, and can be downloaded as a
 * PDF or e-mailed to the employee (or any address) with the PDF attached.
 */
export const LETTER_KINDS = [
  { kind: "offer", label: "Offer letter" }, { kind: "appointment", label: "Appointment letter" }, { kind: "confirmation", label: "Confirmation letter" }, { kind: "warning", label: "Warning letter" },
  { kind: "noc", label: "No objection certificate (NOC)" }, { kind: "salary_certificate", label: "Salary certificate" }, { kind: "experience", label: "Experience certificate" }, { kind: "relieving", label: "Relieving letter" },
] as const;

const FOOTER = "\n\nYours sincerely,\n\n\n{{signatory}}\n{{company.name}}";
const DEFAULTS: Record<string, { name: string; subject: string; body: string }> = {
  offer: { name: "Standard offer letter", subject: "Offer of employment: {{employee.designation}}", body: "Date: {{date}}\n\nDear {{employee.name}},\n\nWe are pleased to offer you the position of {{employee.designation}} in the {{employee.department}} department at {{company.name}}, starting on {{employee.joined_on}}.\n\nYour monthly compensation will be:\nBasic salary: {{salary.currency}} {{salary.basic}}\nHousing allowance: {{salary.currency}} {{salary.housing}}\nTransport allowance: {{salary.currency}} {{salary.transport}}\nOther allowances: {{salary.currency}} {{salary.other}}\nTotal monthly package: {{salary.currency}} {{salary.gross}}\n\nThe employment is subject to a probationary period ending on {{employee.probation_ends_on}}, to the terms of the UAE Labour Law, and to the satisfactory completion of visa and medical formalities.\n\nPlease sign and return a copy of this letter to confirm your acceptance." + FOOTER },
  appointment: { name: "Standard appointment letter", subject: "Appointment letter: {{employee.designation}}", body: "Date: {{date}}\n\nDear {{employee.name}},\n\nFurther to your acceptance of our offer, we confirm your appointment as {{employee.designation}} ({{employee.department}}) with effect from {{employee.joined_on}}. Your employee number is {{employee.no}} and you will report to {{employee.manager}}.\n\nYour total monthly package is {{salary.currency}} {{salary.gross}}. Your work location is {{employee.work_location}}.\n\nWe look forward to a long and successful association." + FOOTER },
  confirmation: { name: "Standard confirmation letter", subject: "Confirmation of employment", body: "Date: {{date}}\n\nDear {{employee.name}},\n\nWe are pleased to confirm that you have successfully completed your probation and your employment as {{employee.designation}} is confirmed with effect from {{effective_date}}.\n\nThank you for your contribution so far." + FOOTER },
  warning: { name: "Standard warning letter", subject: "Warning letter", body: "Date: {{date}}\n\nDear {{employee.name}},\n\nThis letter is a formal warning regarding the following matter:\n\n{{reason}}\n\nThis conduct is not in line with company policy. You are required to correct it with immediate effect. Any repetition may lead to further disciplinary action in accordance with the UAE Labour Law and company policy.\n\nPlease acknowledge receipt by signing a copy of this letter." + FOOTER },
  noc: { name: "Standard NOC", subject: "No objection certificate", body: "Date: {{date}}\n\nTo whom it may concern,\n\nThis is to certify that {{employee.name}} is employed with {{company.name}} as {{employee.designation}} since {{employee.joined_on}}.\n\nThe company has no objection to {{purpose}}.\n\nThis certificate is issued at the request of the employee and carries no financial liability on the company." + FOOTER },
  salary_certificate: { name: "Standard salary certificate", subject: "Salary certificate", body: "Date: {{date}}\n\nTo whom it may concern,\n\nThis is to certify that {{employee.name}} is employed with {{company.name}} as {{employee.designation}} since {{employee.joined_on}} and receives a total monthly salary of {{salary.currency}} {{salary.gross}}, made up of basic salary {{salary.basic}}, housing allowance {{salary.housing}}, transport allowance {{salary.transport}} and other allowances {{salary.other}}.\n\nThis certificate is issued at the employee's request for {{purpose}}." + FOOTER },
  experience: { name: "Standard experience certificate", subject: "Experience certificate", body: "Date: {{date}}\n\nTo whom it may concern,\n\nThis is to certify that {{employee.name}} worked with {{company.name}} as {{employee.designation}} from {{employee.joined_on}} to {{employee.exit_on}}.\n\nDuring this period we found their conduct and performance satisfactory. We wish them every success." + FOOTER },
  relieving: { name: "Standard relieving letter", subject: "Relieving letter", body: "Date: {{date}}\n\nDear {{employee.name}},\n\nWe confirm that your resignation has been accepted and that you are relieved from your duties as {{employee.designation}} with effect from {{employee.exit_on}}, after completing all handover and clearance formalities.\n\nWe thank you for your service and wish you well." + FOOTER },
};

export async function ensureLetterTemplates(u: Uow) {
  if ((await u.repo("HrLetterTemplate").count({ transaction: u.tx })) > 0) return;
  for (const [kind, t] of Object.entries(DEFAULTS)) await u.repo("HrLetterTemplate").create({ id: randomUUID(), kind, name: t.name, subject: t.subject, body: t.body, active: true }, { transaction: u.tx });
}

export async function listLetterTemplates(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "hr.letters");
  return withUow(sq, ctx, async (u) => { await ensureLetterTemplates(u); return (await u.repo("HrLetterTemplate").findAll({ order: [["kind", "ASC"], ["name", "ASC"]], transaction: u.tx })).map(plain); });
}

export const VARIABLES = ["date", "company.name", "signatory", "employee.name", "employee.no", "employee.designation", "employee.department", "employee.joined_on", "employee.probation_ends_on", "employee.exit_on", "employee.manager", "employee.work_location", "employee.nationality", "salary.currency", "salary.basic", "salary.housing", "salary.transport", "salary.other", "salary.gross", "effective_date", "reason", "purpose"];
const SALARY_VARS = /\{\{\s*salary\.[a-z_]+\s*\}\}/;

export async function saveLetterTemplate(sq: Sequelize, ctx: RequestContext, i: { id?: string; kind: string; name: string; subject: string; body: string; active?: boolean }) {
  authorize(ctx, "hr.letters");
  if (!LETTER_KINDS.some((k) => k.kind === i.kind)) throw new ConflictError("Unknown letter type");
  if (!i.name.trim() || !i.subject.trim() || !i.body.trim()) throw new ConflictError("Name, subject and body are required");
  const unknown = [...(i.subject + i.body).matchAll(/\{\{\s*([a-z_.]+)\s*\}\}/g)].map((m) => m[1]!).filter((v) => !VARIABLES.includes(v));
  if (unknown.length) throw new ConflictError(`Unknown placeholder${unknown.length > 1 ? "s" : ""}: ${[...new Set(unknown)].map((v) => `{{${v}}}`).join(", ")}`);
  return withUow(sq, ctx, async (u) => {
    const clash: any = await u.repo("HrLetterTemplate").findOne({ where: { kind: i.kind, name: i.name.trim(), ...(i.id ? { id: { [Op.ne]: i.id } } : {}) }, transaction: u.tx });
    if (clash) throw new ConflictError("A template with that name already exists for this letter type");
    const vals = { kind: i.kind, name: i.name.trim(), subject: i.subject.trim(), body: i.body, active: i.active ?? true };
    const id = i.id ?? randomUUID();
    if (i.id) { if (!(await u.repo("HrLetterTemplate").updateById(id, vals, { transaction: u.tx }))) throw new NotFoundError("Template"); } else await u.repo("HrLetterTemplate").create({ id, ...vals }, { transaction: u.tx });
    await u.audit({ action: i.id ? "hr.letter_template_updated" : "hr.letter_template_created", entityType: "hr_letter_template", entityId: id, after: { kind: i.kind, name: vals.name } });
    return plain(await u.repo("HrLetterTemplate").findById(id, { transaction: u.tx }));
  });
}

const fmtDate = (d: unknown) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }) : "");
const money = (n: unknown) => Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Replaces {{placeholders}}. A placeholder with no value is an error, so a letter never goes out with a blank or a raw {{tag}} in it. */
export function renderLetterTemplate(text: string, vars: Record<string, string>) {
  const missing = new Set<string>();
  const out = text.replace(/\{\{\s*([a-z_.]+)\s*\}\}/g, (_m, k: string) => { const v = vars[k]; if (v === undefined || v === "") { missing.add(k); return ""; } return v; });
  return { text: out, missing: [...missing] };
}

async function variablesFor(u: Uow, ctx: RequestContext, e: any, extra: Record<string, string>, needSalary: boolean) {
  const company: any = ((await u.sq.query("SELECT name FROM tenants WHERE id=:t", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT })) as unknown as { name: string }[])[0];
  const mgr: any = e.get("managerEmployeeId") ? await u.repo("HrEmployee").findById(e.get("managerEmployeeId"), { transaction: u.tx }) : null;
  const me: any = await u.repo("User").findById(ctx.userId, { transaction: u.tx });
  const vars: Record<string, string> = {
    date: fmtDate(dubaiDate()), "company.name": company?.name ?? "", signatory: extra.signatory ?? "Human Resources", "employee.name": e.get("fullName"), "employee.no": e.get("employeeNo"), "employee.designation": e.get("designation") ?? "",
    "employee.department": e.get("department") ?? "", "employee.joined_on": fmtDate(e.get("joinedOn")), "employee.probation_ends_on": fmtDate(e.get("probationEndsOn")), "employee.exit_on": fmtDate(e.get("exitOn")),
    "employee.manager": mgr?.get("fullName") ?? "your line manager", "employee.work_location": e.get("workLocation") ?? "our office", "employee.nationality": e.get("nationality") ?? "", effective_date: extra.effective_date ?? fmtDate(dubaiDate()), ...extra,
  };
  void me;
  if (needSalary) {
    const s = await currentSalaryFor(u, e.get("id"));
    if (!s) throw new ConflictError("This letter uses salary details but no salary is set for the employee yet");
    Object.assign(vars, { "salary.currency": s.currency, "salary.basic": money(s.basic), "salary.housing": money(s.housing), "salary.transport": money(s.transport), "salary.other": money(s.otherAllowance), "salary.gross": money(s.gross) });
  }
  return vars;
}

/** Builds a draft letter from a template. Salary placeholders need hr.salary; anything still missing is reported before anything is saved. */
export async function createLetter(sq: Sequelize, ctx: RequestContext, i: { employeeId: string; templateId: string; vars?: Record<string, string> }) {
  authorize(ctx, "hr.letters");
  return withUow(sq, ctx, async (u) => {
    await ensureLetterTemplates(u);
    const e: any = await u.repo("HrEmployee").findById(i.employeeId, { transaction: u.tx });
    if (!e) throw new NotFoundError("Employee");
    const t: any = await u.repo("HrLetterTemplate").findOne({ where: { id: i.templateId, active: true }, transaction: u.tx });
    if (!t) throw new NotFoundError("Template");
    const usesSalary = SALARY_VARS.test(t.get("subject") + t.get("body"));
    if (usesSalary) authorize(ctx, "hr.salary");
    const vars = await variablesFor(u, ctx, e, i.vars ?? {}, usesSalary);
    const subject = renderLetterTemplate(t.get("subject"), vars), body = renderLetterTemplate(t.get("body"), vars);
    const missing = [...new Set([...subject.missing, ...body.missing])];
    if (missing.length) throw new ConflictError(`Fill in: ${missing.map((m) => ({ reason: "the reason", purpose: "the purpose", "employee.exit_on": "the employee's last working day", "employee.probation_ends_on": "the probation end date", "salary.gross": "salary" })[m] ?? m).join(", ")}`);
    const id = randomUUID();
    await u.repo("HrLetter").create({ id, number: `DRAFT-${id.slice(0, 8)}`, employeeId: e.get("id"), templateId: t.get("id"), kind: t.get("kind"), subject: subject.text, body: body.text, status: "draft" }, { transaction: u.tx });
    await u.audit({ action: "hr.letter_drafted", entityType: "hr_letter", entityId: id, after: { kind: t.get("kind"), employee: e.get("employeeNo") } });
    return plain(await u.repo("HrLetter").findById(id, { transaction: u.tx }));
  });
}

export async function updateLetterDraft(sq: Sequelize, ctx: RequestContext, id: string, i: { subject?: string; body?: string }) {
  authorize(ctx, "hr.letters");
  return withUow(sq, ctx, async (u) => {
    const l: any = await u.repo("HrLetter").findById(id, { transaction: u.tx });
    if (!l) throw new NotFoundError("Letter");
    if (l.get("status") !== "draft") throw new ConflictError("An issued letter cannot be edited. Create a new one.");
    if (/\{\{/.test(`${i.subject ?? ""}${i.body ?? ""}`)) throw new ConflictError("Replace every {{placeholder}} before saving");
    await u.repo("HrLetter").updateById(id, { ...(i.subject !== undefined ? { subject: i.subject.trim().slice(0, 200) } : {}), ...(i.body !== undefined ? { body: i.body } : {}) }, { transaction: u.tx });
    return plain(await u.repo("HrLetter").findById(id, { transaction: u.tx }));
  });
}

/** Numbers the letter (HRL-000001) and freezes its text. */
export async function issueLetter(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "hr.letters");
  return withUow(sq, ctx, async (u) => {
    const l: any = await u.repo("HrLetter").findById(id, { transaction: u.tx });
    if (!l) throw new NotFoundError("Letter");
    if (l.get("status") !== "draft") return plain(l);
    const number = `HRL-${String(await nextCounter(u, ctx.tenantId, "hr_letter")).padStart(6, "0")}`;
    await u.repo("HrLetter").updateById(id, { number, status: "issued", issuedBy: ctx.userId, issuedAt: new Date() }, { transaction: u.tx });
    await u.audit({ action: "hr.letter_issued", entityType: "hr_letter", entityId: id, after: { number, kind: l.get("kind") } });
    return plain(await u.repo("HrLetter").findById(id, { transaction: u.tx }));
  });
}

export async function listLetters(sq: Sequelize, ctx: RequestContext, f: { employeeId?: string; limit?: number } = {}) {
  authorize(ctx, "hr.letters");
  return withUow(sq, ctx, async (u) => {
    const rows = (await u.repo("HrLetter").findAll({ where: f.employeeId ? { employeeId: f.employeeId } : {}, order: [["createdAt", "DESC"]], limit: Math.min(f.limit ?? 100, 300), transaction: u.tx })) as any[];
    const emps = new Map(((await u.repo("HrEmployee").findAll({ where: { id: { [Op.in]: [...new Set(rows.map((r) => r.get("employeeId")))].concat(["-"]) } }, attributes: ["id", "fullName", "employeeNo"], transaction: u.tx })) as any[]).map((e) => [e.get("id"), e]));
    return rows.map((r) => ({ ...plain(r), employeeName: emps.get(r.get("employeeId"))?.get("fullName") ?? "", employeeNo: emps.get(r.get("employeeId"))?.get("employeeNo") ?? "" }));
  });
}

export function renderLetterPdf(l: { number: string; subject: string; body: string; company: string; status: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 70, bottom: 70, left: 70, right: 70 }, info: { Title: l.subject, Producer: "Reales CRM" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c)); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject);
    const latin = (s: string) => String(s ?? "").replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ]/g, "?");
    doc.font("Helvetica-Bold").fontSize(16).fillColor("#111111").text(latin(l.company));
    doc.moveTo(70, doc.y + 4).lineTo(doc.page.width - 70, doc.y + 4).strokeColor("#999999").stroke();
    doc.moveDown(1.2).font("Helvetica").fontSize(9).fillColor("#666666").text(l.status === "draft" ? "DRAFT - not yet issued" : `Ref: ${l.number}`, { align: "right" });
    doc.moveDown(0.8).font("Helvetica-Bold").fontSize(12).fillColor("#111111").text(latin(l.subject));
    doc.moveDown(0.8).font("Helvetica").fontSize(11).fillColor("#111111").text(latin(l.body), { lineGap: 3, align: "left" });
    doc.end();
  });
}

async function loadLetter(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const l: any = await u.repo("HrLetter").findById(id, { transaction: u.tx });
    if (!l) throw new NotFoundError("Letter");
    const company = ((await u.sq.query("SELECT name FROM tenants WHERE id=:t", { replacements: { t: ctx.tenantId }, transaction: u.tx, type: QueryTypes.SELECT })) as unknown as { name: string }[])[0]?.name ?? "";
    const e: any = await u.repo("HrEmployee").findById(l.get("employeeId"), { transaction: u.tx });
    return { l, company, e };
  });
}

export async function letterPdf(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "hr.letters");
  const { l, company, e } = await loadLetter(sq, ctx, id);
  const bytes = await renderLetterPdf({ number: l.get("number"), subject: l.get("subject"), body: l.get("body"), company, status: l.get("status") });
  return { bytes, filename: `${String(l.get("kind")).replace(/_/g, "-")}-${String(e?.get("employeeNo") ?? "employee")}-${l.get("status") === "draft" ? "draft" : l.get("number")}.pdf` };
}

/** E-mails the issued letter as a PDF attachment to the employee (or another address). The result is recorded on the letter, success or failure. */
export async function emailLetter(sq: Sequelize, ctx: RequestContext, id: string, to?: string) {
  authorize(ctx, "hr.letters");
  const { l, company, e } = await loadLetter(sq, ctx, id);
  if (l.get("status") === "draft") throw new ConflictError("Issue the letter before e-mailing it");
  const address = (to ?? e?.get("email") ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || /[\r\n]/.test(address)) throw new ConflictError("Enter a valid e-mail address (the employee has none on file)");
  const { bytes, filename } = await letterPdf(sq, ctx, id);
  let error: string | null = null;
  try {
    await getMailer().send({ to: address, subject: String(l.get("subject")).replace(/[\r\n]+/g, " "), text: `Dear ${e?.get("fullName") ?? "colleague"},\n\nPlease find your ${l.get("subject")} attached (reference ${l.get("number")}).\n\nRegards,\n${company}`, attachments: [{ filename, content: bytes, contentType: "application/pdf" }] });
  } catch (err) { error = err instanceof Error ? err.message.slice(0, 280) : "Send failed"; logger.error({ err }, "hr letter e-mail failed"); }
  await withUow(sq, ctx, async (u) => {
    await u.repo("HrLetter").updateById(id, error ? { emailError: error } : { status: "emailed", emailedAt: new Date(), emailedTo: address, emailError: null }, { transaction: u.tx });
    await u.audit({ action: error ? "hr.letter_email_failed" : "hr.letter_emailed", entityType: "hr_letter", entityId: id, after: { to: address, number: l.get("number") } });
  });
  if (error) throw new ConflictError(`The e-mail could not be sent: ${error}`);
  return { ok: true, to: address };
}

export async function deleteLetterDraft(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "hr.letters");
  return withUow(sq, ctx, async (u) => {
    const l: any = await u.repo("HrLetter").findById(id, { transaction: u.tx });
    if (!l) throw new NotFoundError("Letter");
    if (l.get("status") !== "draft") throw new ConflictError("Only drafts can be deleted");
    await u.repo("HrLetter").deleteById(id, { transaction: u.tx });
    await u.audit({ action: "hr.letter_draft_deleted", entityType: "hr_letter", entityId: id });
    return { id };
  });
}
void hasPermission;

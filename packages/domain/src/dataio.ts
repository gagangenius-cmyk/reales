import { randomUUID } from "node:crypto";
import { Op, Sequelize } from "sequelize";
import { RequestContext } from "@reales/database";
import { authorize, hasPermission, ForbiddenError } from "@reales/rbac";
import { createContact, DuplicateContactError, findDuplicateContacts, listContacts } from "./contacts";
import { createLead } from "./leads";
import { listLeads } from "./leads";
import { listListings } from "./listings";
import { createUnit, listUnits } from "./inventory";
import { normalizeEmail, normalizePhone } from "./normalize";
import { plain } from "./scope";
import { ConflictError, NotFoundError, withUow } from "./uow";

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------- CSV
/** RFC 4180-style parser: quoted fields, doubled quotes, CRLF/LF, BOM, embedded newlines. Returns rows of strings (blank lines dropped). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (quoted) throw new ConflictError("The CSV has an unterminated quoted field");
  row.push(field);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

/** Spreadsheet formula injection: a cell that starts with = + - @ (or a tab/CR) is executed as a formula by Excel. Prefix such cells with an apostrophe. */
export const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (columns: string[], rows: Array<Record<string, unknown>>) =>
  `﻿${[columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\r\n")}\r\n`;

// ---------------------------------------------------------------- import definitions
export type ImportKind = "contacts" | "leads" | "units";
interface RowResult<T> { ok: true; value: T }
interface RowError { ok: false; error: string }

const COLUMNS: Record<ImportKind, { required: string[]; optional: string[] }> = {
  contacts: { required: [], optional: ["first_name", "last_name", "company_name", "email", "phone", "language", "nationality"] },
  leads: { required: ["purpose"], optional: ["first_name", "last_name", "email", "phone", "budget_min", "budget_max", "bedrooms", "source_code", "preferred_areas", "language"] },
  units: { required: ["building", "unit_number", "type"], optional: ["floor", "bedrooms", "bathrooms", "area_sqft", "view", "list_price"] },
};
export const templateCsv = (kind: ImportKind) => `${[...COLUMNS[kind].required, ...COLUMNS[kind].optional].join(",")}\r\n`;

const num = (v: string, what: string, o: { int?: boolean; min?: number } = {}): number | undefined | string => {
  if (v.trim() === "") return undefined;
  const n = Number(v.replace(/[, ]/g, ""));
  if (!Number.isFinite(n) || (o.int && !Number.isInteger(n)) || n < (o.min ?? 0)) return `${what} must be ${o.int ? "a whole " : ""}number${(o.min ?? 0) >= 0 ? " >= " + (o.min ?? 0) : ""}`;
  return n;
};

function validateRow(kind: ImportKind, r: Record<string, string>, buildings: Map<string, string[]>, sources: Set<string>): RowResult<Record<string, unknown>> | RowError {
  const t = (k: string) => (r[k] ?? "").trim();
  const bad = (error: string): RowError => ({ ok: false, error });
  if (kind === "contacts" || kind === "leads") {
    const email = t("email") ? normalizeEmail(t("email")) : null;
    if (t("email") && !email) return bad("Invalid email address");
    const phone = t("phone") ? normalizePhone(t("phone")) : null;
    if (t("phone") && !phone) return bad("Invalid phone number");
    if (!email && !phone) return bad("An email or a phone number is required");
    if (kind === "contacts" && !t("first_name") && !t("last_name") && !t("company_name")) return bad("A name or company name is required");
    const base = { firstName: t("first_name") || undefined, lastName: t("last_name") || undefined, companyName: t("company_name") || undefined, email: email ?? undefined, phone: phone ?? undefined, language: t("language") || undefined, nationality: t("nationality") || undefined };
    if (kind === "contacts") return { ok: true, value: base };
    if (t("source_code") && !sources.has(t("source_code"))) return bad(`Unknown source_code "${t("source_code")}"`);
    if (!["buy", "rent", "invest", "off_plan"].includes(t("purpose"))) return bad("purpose must be buy, rent, invest or off_plan");
    const bmin = num(t("budget_min"), "budget_min"), bmax = num(t("budget_max"), "budget_max"), beds = num(t("bedrooms"), "bedrooms", { int: true });
    for (const x of [bmin, bmax, beds]) if (typeof x === "string") return bad(x);
    if (typeof bmin === "number" && typeof bmax === "number" && bmin > bmax) return bad("budget_min is above budget_max");
    return { ok: true, value: { contact: base, purpose: t("purpose"), budgetMin: bmin, budgetMax: bmax, bedrooms: beds, sourceCode: t("source_code") ? t("source_code") : sources.has("import") ? "import" : undefined, preferredAreas: t("preferred_areas") ? t("preferred_areas").split(";").map((x) => x.trim()).filter(Boolean) : undefined, language: t("language") || undefined } };
  }
  // units
  const ids = buildings.get(t("building").toLowerCase());
  if (!ids) return bad(`Building "${t("building")}" was not found`);
  if (ids.length > 1) return bad(`Building name "${t("building")}" matches more than one building`);
  if (!t("unit_number")) return bad("unit_number is required");
  if (!["apartment", "villa", "townhouse", "penthouse", "office", "retail", "land"].includes(t("type"))) return bad("Unknown unit type");
  const floor = num(t("floor"), "floor", { int: true, min: -5 }), beds = num(t("bedrooms"), "bedrooms", { int: true }), baths = num(t("bathrooms"), "bathrooms", { int: true });
  const area = num(t("area_sqft"), "area_sqft"), price = num(t("list_price"), "list_price");
  for (const x of [floor, beds, baths, area, price]) if (typeof x === "string") return bad(x);
  return { ok: true, value: { buildingId: ids[0], unitNumber: t("unit_number"), type: t("type"), floor, bedrooms: beds, bathrooms: baths, areaSqft: area, view: t("view") || undefined, listPrice: price } };
}

export interface ImportError { row: number; message: string }
export interface ImportSummary { id: string; kind: ImportKind; status: string; totalRows: number; validRows: number; errorRows: number; committedRows: number; skippedRows: number; errors: ImportError[]; preview: unknown[] }

const summary = (j: any, previewRows = 5): ImportSummary => ({
  id: j.get("id"), kind: j.get("kind"), status: j.get("status"), totalRows: j.get("totalRows"), validRows: j.get("validRows"), errorRows: j.get("errorRows"), committedRows: j.get("committedRows"),
  skippedRows: j.get("skippedRows"), errors: ((j.get("errors") as ImportError[]) ?? []).slice(0, 100), preview: ((j.get("payload") as Array<{ row: number; data: unknown }>) ?? []).slice(0, previewRows).map((p) => p.data),
});

/** Step 1: parse and validate everything; nothing is created. Duplicates inside the file are flagged, and duplicates of existing contacts are skipped at commit (or rejected if `onDuplicate: "error"`). */
export async function validateImport(sq: Sequelize, ctx: RequestContext, i: { kind: ImportKind; filename: string; csv: string; onDuplicate?: "skip" | "error" }): Promise<ImportSummary> {
  authorize(ctx, "import.manage");
  if (Buffer.byteLength(i.csv) > MAX_IMPORT_BYTES) throw new ConflictError(`The file is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB`);
  const all = parseCsv(i.csv);
  if (all.length < 2) throw new ConflictError("The file needs a header row and at least one data row");
  if (all.length - 1 > MAX_IMPORT_ROWS) throw new ConflictError(`At most ${MAX_IMPORT_ROWS} rows can be imported at once`);
  const header = all[0]!.map((h) => h.trim().toLowerCase());
  const spec = COLUMNS[i.kind];
  const known = new Set([...spec.required, ...spec.optional]);
  const missing = spec.required.filter((c) => !header.includes(c));
  if (missing.length) throw new ConflictError(`Missing required column(s): ${missing.join(", ")}`);
  const unknown = header.filter((h) => !known.has(h));
  if (unknown.length) throw new ConflictError(`Unknown column(s): ${unknown.join(", ")}. Expected: ${[...known].join(", ")}`);
  if (new Set(header).size !== header.length) throw new ConflictError("Duplicate column names in the header");

  return withUow(sq, ctx, async (u) => {
    const buildings = new Map<string, string[]>();
    if (i.kind === "units") for (const b of (await u.repo("Building").findAll({ transaction: u.tx })) as any[]) buildings.set(String(b.get("name")).toLowerCase(), [...(buildings.get(String(b.get("name")).toLowerCase()) ?? []), b.get("id")]);
    const sources = new Set<string>(i.kind === "leads" ? ((await u.repo("LeadSource").findAll({ transaction: u.tx })) as any[]).map((x) => x.get("code")) : []);
    const payload: Array<{ row: number; data: Record<string, unknown> }> = [];
    const errors: ImportError[] = [];
    const seen = new Set<string>();
    const dupMode = i.onDuplicate ?? "skip";
    for (let n = 1; n < all.length; n++) {
      const cells = all[n]!;
      if (cells.length > header.length) { errors.push({ row: n + 1, message: "More cells than header columns" }); continue; }
      const rec = Object.fromEntries(header.map((h, k) => [h, cells[k] ?? ""]));
      const v = validateRow(i.kind, rec, buildings, sources);
      if (!v.ok) { errors.push({ row: n + 1, message: v.error }); continue; }
      const c: any = i.kind === "leads" ? (v.value as any).contact : v.value;
      const keys = i.kind === "units" ? [`${v.value.buildingId}|${String(v.value.unitNumber).toLowerCase()}`] : [c.email && `e:${c.email}`, c.phone && `p:${c.phone}`].filter(Boolean) as string[];
      if (keys.some((k) => seen.has(k))) { errors.push({ row: n + 1, message: i.kind === "units" ? "Duplicate unit in the file" : "Duplicate of an earlier row in the file" }); continue; }
      keys.forEach((k) => seen.add(k));
      if (i.kind === "contacts" && dupMode === "error") {
        if ((await findDuplicateContacts(u, ctx, c.email ?? null, c.phone ?? null)).length) { errors.push({ row: n + 1, message: "A contact with this email or phone already exists" }); continue; }
      }
      payload.push({ row: n + 1, data: v.value });
    }
    const id = randomUUID();
    const job = await u.repo("ImportJob").create({
      id, kind: i.kind, filename: i.filename.slice(0, 255), createdBy: ctx.userId, status: "validated", totalRows: all.length - 1, validRows: payload.length, errorRows: errors.length,
      committedRows: 0, skippedRows: 0, payload, errors, options: { onDuplicate: dupMode },
    }, { transaction: u.tx });
    await u.audit({ action: "import.validated", entityType: "import_job", entityId: id, after: { kind: i.kind, rows: all.length - 1, errors: errors.length } });
    return summary(job);
  });
}

async function ownJob(u: any, ctx: RequestContext, id: string) {
  const j: any = await u.repo("ImportJob").findById(id, { transaction: u.tx });
  if (!j) throw new NotFoundError("Import");
  if (j.get("createdBy") !== ctx.userId && !hasPermission(ctx, "user.update")) throw new NotFoundError("Import");
  return j;
}

/** Step 2: create the valid rows through the normal domain functions (so every permission, quota, duplicate and audit rule applies per row). Rows that fail are reported, not hidden. */
export async function commitImport(sq: Sequelize, ctx: RequestContext, id: string): Promise<ImportSummary> {
  authorize(ctx, "import.manage");
  const claimed = await withUow(sq, ctx, async (u) => {
    const j = await ownJob(u, ctx, id);
    if (j.get("status") !== "validated") throw new ConflictError(`This import is already ${j.get("status")}`);
    await u.repo("ImportJob").updateById(id, { status: "committed" }, { transaction: u.tx }); // claim first: a double click cannot run it twice
    return { kind: j.get("kind") as ImportKind, payload: j.get("payload") as Array<{ row: number; data: any }>, errors: (j.get("errors") as ImportError[]) ?? [], onDuplicate: (j.get("options") as any)?.onDuplicate ?? "skip" };
  });
  let done = 0, skipped = 0;
  const errors = [...claimed.errors];
  for (const { row, data } of claimed.payload) {
    try {
      if (claimed.kind === "contacts") await createContact(sq, ctx, data);
      else if (claimed.kind === "leads") await createLead(sq, ctx, data);
      else await createUnit(sq, ctx, data);
      done++;
    } catch (e) {
      if (e instanceof DuplicateContactError) { skipped++; continue; }
      errors.push({ row, message: (e as Error).message });
    }
  }
  return withUow(sq, ctx, async (u) => {
    const status = done === 0 && claimed.payload.length > 0 ? "failed" : "committed";
    await u.repo("ImportJob").updateById(id, { status, committedRows: done, skippedRows: skipped, errorRows: errors.length, errors, payload: null }, { transaction: u.tx });
    await u.audit({ action: "import.committed", entityType: "import_job", entityId: id, after: { kind: claimed.kind, created: done, skipped, errors: errors.length } });
    return summary(await u.repo("ImportJob").findById(id, { transaction: u.tx }));
  });
}

export async function cancelImport(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "import.manage");
  return withUow(sq, ctx, async (u) => {
    const j = await ownJob(u, ctx, id);
    if (j.get("status") !== "validated") throw new ConflictError(`This import is already ${j.get("status")}`);
    await u.repo("ImportJob").updateById(id, { status: "cancelled", payload: null }, { transaction: u.tx });
    return summary(await u.repo("ImportJob").findById(id, { transaction: u.tx }));
  });
}

export async function listImports(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "import.manage");
  return withUow(sq, ctx, async (u) => {
    const where = hasPermission(ctx, "user.update") ? {} : { createdBy: ctx.userId };
    return (await u.repo("ImportJob").findAll({ where: { [Op.and]: [where] }, order: [["createdAt", "DESC"]], limit: 50, transaction: u.tx })).map((j: any) => summary(j, 0));
  });
}

export async function getImport(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "import.manage");
  return withUow(sq, ctx, async (u) => summary(await ownJob(u, ctx, id)));
}

// ---------------------------------------------------------------- export
export type ExportKind = "contacts" | "leads" | "listings" | "units";
const EXPORTS: Record<ExportKind, { columns: string[]; load: (sq: Sequelize, ctx: RequestContext) => Promise<any[]> }> = {
  contacts: { columns: ["id", "type", "first_name", "last_name", "company_name", "email", "phone", "language", "nationality", "created_at"], load: (sq, c) => listContacts(sq, c, { limit: 10000, offset: 0 }) as any },
  leads: { columns: ["id", "contact_id", "status", "purpose", "budget_min", "budget_max", "bedrooms", "currency", "assigned_user_id", "score", "created_at"], load: (sq, c) => listLeads(sq, c, { limit: 10000, offset: 0 }) as any },
  listings: { columns: ["id", "title", "purpose", "status", "price", "currency", "agent_user_id", "published_at", "created_at"], load: (sq, c) => listListings(sq, c, { limit: 10000, offset: 0 }) as any },
  units: { columns: ["id", "building_id", "unit_number", "type", "bedrooms", "bathrooms", "area_sqft", "status", "list_price", "currency"], load: (sq, c) => listUnits(sq, c, { limit: 10000, offset: 0 }) as any },
};
const snake = (s: string) => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
const NEEDS: Record<ExportKind, string> = { contacts: "contact.read", leads: "lead.read", listings: "listing.read", units: "inventory.read" };

/** Exports exactly what the caller may already see in the app (same scoped queries). Audited, with the row count. */
export async function exportCsv(sq: Sequelize, ctx: RequestContext, kind: ExportKind): Promise<{ filename: string; csv: string; rows: number }> {
  const spec = EXPORTS[kind];
  if (!spec) throw new ConflictError("Unknown export");
  for (const p of ["export.data", NEEDS[kind]]) if (!hasPermission(ctx, p)) throw new ForbiddenError(`Missing permission: ${p}`);
  const rows = await spec.load(sq, ctx);
  const flat = rows.map((r: any) => Object.fromEntries(spec.columns.map((c) => [c, r[camel(c)] ?? r[c]])));
  await withUow(sq, ctx, async (u) => { await u.audit({ action: "export.csv", entityType: kind, entityId: ctx.tenantId, after: { rows: rows.length } }); });
  return { filename: `${kind}-${new Date().toISOString().slice(0, 10)}.csv`, csv: toCsv(spec.columns, flat), rows: rows.length };
}

void plain; void snake;

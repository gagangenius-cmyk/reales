import { QueryTypes, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { ConflictError, withUow } from "./uow";

/**
 * Configurable modules and automation settings. A company turns whole areas of the CRM on or off (the menu, the pages and the API of a disabled module all
 * disappear) and tunes the behaviour of the ones it keeps. Stored per tenant in tenant_settings, so no schema change is needed to add a module or a setting.
 */
export interface ModuleDef {
  key: string; label: string; group: string; description: string;
  /** Always on: the CRM cannot work without it. */
  core?: boolean; defaultOn: boolean; requires?: string[];
  /** Page path prefixes ("/leads") and API path prefixes ("leads" under /api/v1) that belong to this module. */
  pages: string[]; api: string[];
}

export const MODULES: ModuleDef[] = [
  { key: "leads", label: "Leads", group: "Sales", description: "Lead capture, pipeline, follow-ups, board and bulk actions.", core: true, defaultOn: true, pages: ["/leads"], api: ["leads", "pipelines"] },
  { key: "contacts", label: "Contacts", group: "Sales", description: "People and companies, consent and duplicates.", core: true, defaultOn: true, pages: ["/contacts"], api: ["contacts", "suppressions"] },
  { key: "routing", label: "Lead routing and pools", group: "Sales", description: "Round robin, assignment rules, lead pools and automatic repooling.", defaultOn: true, requires: ["leads"], pages: ["/pools"], api: ["routing-rules", "pools", "repool-rules"] },
  { key: "lead_sources", label: "Lead sources and Meta", group: "Sales", description: "Signed inbound lead sources such as Meta lead ads, website forms and portals.", defaultOn: true, requires: ["leads"], pages: ["/lead-sources"], api: ["lead-sources", "ingest"] },
  { key: "calls", label: "Call log", group: "Sales", description: "Log calls against leads and see agent call statistics.", defaultOn: true, requires: ["leads"], pages: ["/calls"], api: ["calls"] },
  { key: "imports", label: "Bulk upload and export", group: "Sales", description: "CSV import of contacts, leads and units, and data export.", defaultOn: true, pages: ["/imports"], api: ["imports", "exports"] },
  { key: "calendar", label: "Calendar and tasks", group: "Sales", description: "Calendar, tasks and reminders.", defaultOn: true, pages: ["/calendar", "/tasks"], api: ["calendar", "tasks"] },
  { key: "viewings", label: "Viewings and availability", group: "Sales", description: "Book viewings, agent availability and time off.", defaultOn: true, requires: ["leads"], pages: ["/viewings", "/availability"], api: ["viewings", "availability"] },
  { key: "inventory", label: "Inventory", group: "Inventory", description: "Developers, projects, buildings and units.", core: true, defaultOn: true, pages: ["/inventory", "/projects"], api: ["developers", "real-estate-projects", "buildings", "units", "inventory", "projects"] },
  { key: "listings", label: "Listings", group: "Inventory", description: "Listings with photos, permits, publish, expire, close and archive.", defaultOn: true, requires: ["inventory"], pages: ["/listings"], api: ["listings", "listing-permits", "broker-licences"] },
  { key: "syndication", label: "Portals and feeds", group: "Inventory", description: "Bayut, Property Finder and other portal feeds.", defaultOn: true, requires: ["listings"], pages: ["/distribution"], api: ["distribution", "portal", "portal-connections", "feeds"] },
  { key: "website", label: "Public website", group: "Inventory", description: "A public property website with enquiry forms.", defaultOn: true, requires: ["listings"], pages: ["/website"], api: ["site-settings", "public"] },
  { key: "matching", label: "Saved searches and matching", group: "Inventory", description: "Client requirements matched to listings.", defaultOn: true, requires: ["listings"], pages: ["/searches"], api: ["saved-searches", "search"] },
  { key: "valuation", label: "Valuation", group: "Inventory", description: "Market estimates from comparable listings and sales.", defaultOn: true, requires: ["inventory"], pages: ["/valuation"], api: [] },
  { key: "deals", label: "Offers, reservations and deals", group: "Transactions", description: "Offers, reservations, deals, milestones and closing checklists.", defaultOn: true, requires: ["inventory"], pages: ["/deals", "/checklists", "/documents"], api: ["offers", "reservations", "deals", "checklist-templates", "documents", "document-folders", "document-library", "signature-envelopes"] },
  { key: "finance", label: "Finance and daily transactions", group: "Transactions", description: "Invoices, payments, receipts and the daily transaction register.", defaultOn: true, pages: ["/finance", "/ledger"], api: ["invoices", "payments", "payment-links", "ledger"] },
  { key: "commissions", label: "Commissions and payouts", group: "Transactions", description: "Commission plans, calculations and payout requests.", defaultOn: true, requires: ["deals"], pages: ["/commissions", "/payouts", "/targets", "/agents"], api: ["commission-plans", "commissions", "payouts", "targets", "agent-profiles"] },
  { key: "referrals", label: "Referrals", group: "Transactions", description: "Referral partners and referral fees.", defaultOn: true, pages: ["/referrals"], api: ["referral-partners", "referrals"] },
  { key: "messaging", label: "Inbox and templates", group: "Marketing", description: "Shared inbox for WhatsApp, SMS and e-mail, and message templates.", defaultOn: true, pages: ["/inbox", "/templates", "/channels"], api: ["conversations", "messages", "templates", "channel-accounts"] },
  { key: "campaigns", label: "Broadcast campaigns", group: "Marketing", description: "WhatsApp, SMS and e-mail broadcasts to segments, with consent checks.", defaultOn: true, requires: ["messaging"], pages: ["/campaigns"], api: ["campaigns", "segments"] },
  { key: "automation", label: "Workflows and bots", group: "Marketing", description: "Visual workflows and conversational bots.", defaultOn: true, pages: ["/automation", "/bots"], api: ["workflows", "workflow-runs", "bots", "bot-sessions"] },
  { key: "property_management", label: "Property management", group: "Property management", description: "Portfolios, leases, rent, maintenance and inspections.", defaultOn: true, pages: ["/portfolios", "/leases", "/maintenance", "/inspections"], api: ["portfolios", "leases", "ownerships", "maintenance-tickets", "maintenance-sla", "vendors", "inspections", "inspection-templates", "statements"] },
  { key: "compliance", label: "Compliance (KYC and AML)", group: "Compliance", description: "KYC profiles, screening, cases and data-subject requests.", defaultOn: true, pages: ["/compliance"], api: ["compliance-cases", "kyc-profiles", "screening-hits", "ubo-links", "dsr-requests", "legal-holds", "retention-policies", "retention-runs", "aml-exports"] },
  { key: "insights", label: "Insights and reports", group: "Insights", description: "Dashboards and analytics.", defaultOn: true, pages: ["/insights"], api: ["dashboards", "warehouse-exports"] },
  { key: "hr", label: "Human resources", group: "People", description: "Employees, salaries, leave, attendance with live check-in and breaks, HR letters, documents, announcements and celebrations.", defaultOn: true, pages: ["/hr"], api: ["hr"] },
  { key: "assistant", label: "Assistant", group: "Insights", description: "Ask in plain words (hot leads, listings expiring, who is on leave) and get answers from your own data with links.", defaultOn: true, pages: ["/assistant"], api: ["assistant"] },
  { key: "noticeboard", label: "Noticeboard", group: "Team", description: "Company notices with read receipts.", defaultOn: true, pages: ["/noticeboard"], api: ["notices"] },
  { key: "support", label: "Support desk", group: "Team", description: "Internal support tickets.", defaultOn: true, pages: ["/support"], api: ["support-tickets"] },
];

const BY_KEY = new Map(MODULES.map((m) => [m.key, m]));

// ---------------------------------------------------------------- automation settings

export type SettingType = "boolean" | "number" | "choice";
export interface SettingDef { key: string; label: string; group: string; description: string; type: SettingType; default: boolean | number | string; min?: number; max?: number; choices?: string[]; module?: string }

export const SETTINGS: SettingDef[] = [
  { key: "leads.auto_assign", group: "Lead assignment", module: "routing", type: "boolean", default: true, label: "Assign new leads automatically", description: "Run new leads through the routing rules (round robin, weighted, by area or language). Off: new leads stay unassigned until someone picks them up." },
  { key: "leads.transfer_requires_reason", group: "Lead assignment", module: "leads", type: "boolean", default: true, label: "Ask for a reason when leads are transferred", description: "Managers must say why when they hand leads to another agent." },
  { key: "listings.auto_expire", group: "Listings", module: "listings", type: "boolean", default: true, label: "Expire listings automatically", description: "Move published listings to Expired when their expiry date passes, and take them off the website and portals." },
  { key: "listings.expiry_days", group: "Listings", module: "listings", type: "number", default: 90, min: 7, max: 365, label: "Days a listing stays live", description: "Counted from publish or refresh." },
  { key: "listings.archive_after_days", group: "Listings", module: "listings", type: "number", default: 180, min: 0, max: 1825, label: "Archive closed or expired listings after (days, 0 = never)", description: "Archived listings leave the working list but stay searchable and can be restored." },
  { key: "notifications.email.lead_assigned", group: "E-mail notifications", module: "leads", type: "boolean", default: true, label: "E-mail an agent when a lead is assigned to them", description: "In-app notifications are always on." },
  { key: "notifications.email.followup_overdue", group: "E-mail notifications", module: "leads", type: "boolean", default: true, label: "E-mail an agent when a follow-up becomes overdue", description: "Sent once per follow-up." },
  { key: "notifications.email.listing_expiring", group: "E-mail notifications", module: "listings", type: "boolean", default: true, label: "E-mail the listing agent before a listing expires", description: "Sent 7 days before." },
  { key: "notifications.email.listing_enquiry", group: "E-mail notifications", module: "website", type: "boolean", default: true, label: "E-mail the listing agent about website enquiries", description: "One e-mail per enquiry." },
  { key: "notifications.email.deal_milestone", group: "E-mail notifications", module: "deals", type: "boolean", default: false, label: "E-mail the deal owner when a milestone is completed", description: "Useful for brokerages that manage many deals." },
  { key: "notifications.email.daily_digest", group: "E-mail notifications", module: "leads", type: "boolean", default: false, label: "Send each agent a daily summary", description: "New leads, overdue follow-ups and expiring listings, each morning." },
  { key: "hr.attendance.allow_web_checkin", group: "Human resources", module: "hr", type: "boolean", default: true, label: "Let employees check in and out from the CRM", description: "Off: only HR can record attendance." },
  { key: "hr.attendance.auto_close", group: "Human resources", module: "hr", type: "boolean", default: true, label: "Close forgotten check-outs automatically", description: "A check-in with no check-out is closed at the end of the shift the next morning and flagged." },
  { key: "hr.leave.allow_negative_balance", group: "Human resources", module: "hr", type: "boolean", default: false, label: "Allow leave beyond the balance", description: "Lets requests go through when an employee has fewer days left than they ask for." },
  { key: "hr.payroll.deduct_absence", group: "Human resources", module: "hr", type: "boolean", default: true, label: "Deduct unexplained absence in payroll", description: "Working days with no attendance, leave or holiday are deducted at gross salary divided by 30. Unpaid leave is always deducted." },
  { key: "hr.expiry_alert_days", group: "Human resources", module: "hr", type: "number", default: 60, min: 7, max: 365, label: "Warn HR about expiring visas, IDs and documents (days before)", description: "Passport, visa, Emirates ID and uploaded HR documents with an expiry date." },
];
const SETTING_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

// ---------------------------------------------------------------- storage and cache

const TTL_MS = 15_000;
const cache = new Map<string, { at: number; modules: Record<string, boolean>; settings: Record<string, unknown> }>();
export const clearConfigCache = (tenantId?: string) => (tenantId ? cache.delete(tenantId) : cache.clear());

async function load(sq: Sequelize, tenantId: string) {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const rows = (await sq.query("SELECT `key` AS k, value AS v FROM tenant_settings WHERE tenant_id=:t AND `key` IN ('modules','automation')", { replacements: { t: tenantId }, type: QueryTypes.SELECT })) as unknown as { k: string; v: unknown }[];
  const parse = (v: unknown) => { try { const x = typeof v === "string" ? JSON.parse(v) : v; return x && typeof x === "object" ? (x as Record<string, unknown>) : {}; } catch { return {}; } };
  const mods = parse(rows.find((r) => r.k === "modules")?.v), set = parse(rows.find((r) => r.k === "automation")?.v);
  const entry = { at: Date.now(), modules: Object.fromEntries(MODULES.map((m) => [m.key, m.core ? true : typeof mods[m.key] === "boolean" ? (mods[m.key] as boolean) : m.defaultOn])), settings: set };
  cache.set(tenantId, entry);
  return entry;
}

/** A module is effectively on only when it and everything it requires are on. */
function effective(modules: Record<string, boolean>) {
  const out: Record<string, boolean> = {};
  const on = (k: string, seen: string[] = []): boolean => {
    if (k in out) return out[k]!;
    const m = BY_KEY.get(k);
    if (!m || seen.includes(k)) return false;
    return (out[k] = modules[k]! && (m.requires ?? []).every((r) => on(r, [...seen, k])));
  };
  for (const m of MODULES) on(m.key);
  return out;
}

export async function moduleStates(sq: Sequelize, tenantId: string) { return effective((await load(sq, tenantId)).modules); }
export async function isModuleOn(sq: Sequelize, tenantId: string, key: string) { return (await moduleStates(sq, tenantId))[key] !== false; }

/** The module a page path belongs to, if any (longest prefix wins). */
export function moduleForPage(path: string): string | null {
  let best: { k: string; n: number } | null = null;
  for (const m of MODULES) for (const p of m.pages) if ((path === p || path.startsWith(`${p}/`)) && (!best || p.length > best.n)) best = { k: m.key, n: p.length };
  return best?.k ?? null;
}
/** The module an API path (the part after /api/v1/) belongs to, if any. */
export function moduleForApi(path: string): string | null {
  const first = path.replace(/^\/?(api\/v1\/)?/, "").split("/")[0] ?? "";
  return MODULES.find((m) => m.api.includes(first))?.key ?? null;
}

export async function getSetting<T extends boolean | number | string>(sq: Sequelize, tenantId: string, key: string): Promise<T> {
  const def = SETTING_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown setting ${key}`);
  const v = (await load(sq, tenantId)).settings[key];
  return (valid(def, v) ? v : def.default) as T;
}
function valid(def: SettingDef, v: unknown) {
  if (def.type === "boolean") return typeof v === "boolean";
  if (def.type === "number") return typeof v === "number" && Number.isFinite(v) && v >= (def.min ?? -Infinity) && v <= (def.max ?? Infinity);
  return typeof v === "string" && (def.choices ?? []).includes(v);
}

// ---------------------------------------------------------------- read and change (admin)

export async function getConfig(sq: Sequelize, ctx: RequestContext) {
  const c = await load(sq, ctx.tenantId), eff = effective(c.modules);
  return {
    modules: MODULES.map((m) => ({ key: m.key, label: m.label, group: m.group, description: m.description, core: !!m.core, requires: m.requires ?? [], enabled: c.modules[m.key]!, effective: eff[m.key]! })),
    settings: SETTINGS.map((s) => ({ ...s, value: valid(s, c.settings[s.key]) ? (c.settings[s.key] as boolean | number | string) : s.default, isDefault: !valid(s, c.settings[s.key]) })),
  };
}

async function upsert(u: { repo: (m: any) => any; tx: unknown }, key: string, value: Record<string, unknown>) {
  const row = await u.repo("TenantSetting").findOne({ where: { key }, transaction: u.tx });
  if (row) await u.repo("TenantSetting").updateById(row.get("id"), { value }, { transaction: u.tx });
  else await u.repo("TenantSetting").create({ key, value }, { transaction: u.tx });
}

export async function setModules(sq: Sequelize, ctx: RequestContext, changes: Record<string, boolean>) {
  authorize(ctx, "tenant.manage");
  const keys = Object.keys(changes);
  for (const k of keys) {
    const m = BY_KEY.get(k);
    if (!m) throw new ConflictError(`Unknown module ${k}`);
    if (m.core && changes[k] === false) throw new ConflictError(`${m.label} is always on`);
  }
  const res = await withUow(sq, ctx, async (u) => {
    const cur = { ...(await load(sq, ctx.tenantId)).modules, ...changes };
    // A module cannot be on while one it needs is off: say so instead of silently hiding it.
    for (const m of MODULES) if (cur[m.key] && changes[m.key] === true) for (const r of m.requires ?? []) if (!cur[r]) throw new ConflictError(`${m.label} needs ${BY_KEY.get(r)!.label}. Turn that on first.`);
    for (const m of MODULES) if (!cur[m.key] && changes[m.key] === false) { const dependants = MODULES.filter((d) => cur[d.key] && (d.requires ?? []).includes(m.key)); if (dependants.length) throw new ConflictError(`Turn off ${dependants.map((d) => d.label).join(", ")} first: ${dependants.length > 1 ? "they need" : "it needs"} ${m.label}.`); }
    const stored = Object.fromEntries(MODULES.filter((m) => !m.core).map((m) => [m.key, cur[m.key]]));
    await upsert(u as never, "modules", stored);
    await u.audit({ action: "config.modules_changed", entityType: "tenant_settings", entityId: ctx.tenantId, after: changes });
    return stored;
  });
  clearConfigCache(ctx.tenantId);
  return res;
}

export async function setSettings(sq: Sequelize, ctx: RequestContext, changes: Record<string, boolean | number | string>) {
  authorize(ctx, "tenant.manage");
  for (const [k, v] of Object.entries(changes)) {
    const def = SETTING_BY_KEY.get(k);
    if (!def) throw new ConflictError(`Unknown setting ${k}`);
    if (!valid(def, v)) throw new ConflictError(`Invalid value for ${def.label}`);
  }
  const res = await withUow(sq, ctx, async (u) => {
    const raw = (await u.repo("TenantSetting").findOne({ where: { key: "automation" }, transaction: u.tx })) as any;
    const cur = raw ? ((typeof raw.get("value") === "string" ? JSON.parse(raw.get("value")) : raw.get("value")) ?? {}) : {};
    const next = { ...cur, ...changes };
    await upsert(u as never, "automation", next);
    await u.audit({ action: "config.settings_changed", entityType: "tenant_settings", entityId: ctx.tenantId, before: Object.fromEntries(Object.keys(changes).map((k) => [k, cur[k] ?? null])), after: changes });
    return next;
  });
  clearConfigCache(ctx.tenantId);
  return res;
}

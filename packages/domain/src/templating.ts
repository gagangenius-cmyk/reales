export type MessageChannel = "email" | "whatsapp" | "sms";

/**
 * The ONLY data a template may reference. Roots map to an allow-list of fields, so a user-authored template can never traverse
 * arbitrary object properties (e.g. password hashes, other tenants' data, prototype chains).
 */
export const VARIABLE_CATALOG: Record<string, Record<string, "string" | "money" | "date" | "number">> = {
  contact: { first_name: "string", last_name: "string", full_name: "string", email: "string", phone: "string" },
  lead: { purpose: "string", budget_max: "money", budget_min: "money", bedrooms: "number" },
  agent: { name: "string", email: "string", phone: "string" },
  unit: { number: "string", type: "string", bedrooms: "number", area_sqft: "number", price: "money" },
  property: { title: "string", price: "money", building: "string", community: "string", city: "string" },
  listing: { title: "string", price: "money", reference: "string" },
  project: { name: "string" },
  deal: { amount: "money", stage: "string" },
  lease: { end_date: "date", annual_rent: "money" },
  tenant: { name: "string" },
};

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/** Own-property lookup only: `contact.constructor` or `__proto__.x` must never resolve through the prototype chain. */
const catalogType = (root: string, field: string) => (own(VARIABLE_CATALOG, root) && own(VARIABLE_CATALOG[root]!, field) ? VARIABLE_CATALOG[root]![field] : undefined);
const ANY_BRACES = /\{\{([^}]*)\}\}/g;

export interface TemplateIssue { code: string; message: string }

/** Every `{{ root.field }}` token, and any malformed or non-catalogue token as an issue. */
export function extractVariables(text: string): { vars: string[]; issues: TemplateIssue[] } {
  const vars = new Set<string>();
  const issues: TemplateIssue[] = [];
  for (const m of text.matchAll(ANY_BRACES)) {
    const t = /^\s*([a-z_]+)\.([a-z_]+)\s*$/.exec(m[1]!);
    if (!t) { issues.push({ code: "variable_malformed", message: `Invalid variable "{{${m[1]}}}" (use {{ root.field }})` }); continue; }
    if (!catalogType(t[1]!, t[2]!)) { issues.push({ code: "variable_unknown", message: `Unknown variable "${t[1]}.${t[2]}"` }); continue; }
    vars.add(`${t[1]}.${t[2]}`);
  }
  return { vars: [...vars].sort(), issues };
}

export type VariableValues = Record<string, Record<string, string | number | null | undefined>>;

const fmt = (type: string, v: string | number): string => {
  if (type === "money") return Number(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return String(v);
};
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export class MissingVariableError extends Error {
  constructor(public missing: string[]) {
    super(`Missing values for: ${missing.join(", ")}`);
    this.name = "MissingVariableError";
  }
}

/**
 * Render with values supplied by the caller. Unknown variables throw (never render as blank), missing values throw rather
 * than silently sending "Dear ,", and HTML output escapes every substituted value.
 */
export function renderTemplate(text: string, values: VariableValues, opts: { html?: boolean } = {}): string {
  const missing: string[] = [];
  const out = text.replace(ANY_BRACES, (_all, inner: string) => {
    const t = /^\s*([a-z_]+)\.([a-z_]+)\s*$/.exec(inner);
    const type = t && catalogType(t[1]!, t[2]!);
    if (!t || !type) throw new Error(`Unknown template variable "{{${inner}}}"`);
    const v = Object.prototype.hasOwnProperty.call(values[t[1]!] ?? {}, t[2]!) ? values[t[1]!]![t[2]!] : undefined;
    if (v === null || v === undefined || v === "") { missing.push(`${t[1]}.${t[2]}`); return ""; }
    const s = fmt(type, v);
    return opts.html ? escapeHtml(s) : s;
  });
  if (missing.length) throw new MissingVariableError([...new Set(missing)]);
  return out;
}

// ---------------------------------------------------------------- SMS
const GSM7 = new Set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà".split(""));
const GSM7_EXT = new Set("^{}\\[~]|€".split(""));

/** Encoding and billable segments. Arabic text forces UCS-2 (70 chars/segment, 67 when concatenated). */
export function smsStats(text: string): { encoding: "GSM-7" | "UCS-2"; length: number; segments: number } {
  let gsm = true;
  let units = 0;
  for (const ch of text) {
    if (GSM7.has(ch)) units += 1;
    else if (GSM7_EXT.has(ch)) units += 2;
    else { gsm = false; break; }
  }
  if (gsm) return { encoding: "GSM-7", length: units, segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153) };
  const len = [...text].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  return { encoding: "UCS-2", length: len, segments: len === 0 ? 0 : len <= 70 ? 1 : Math.ceil(len / 67) };
}

// ---------------------------------------------------------------- per-channel validation
export interface WhatsAppComponents {
  header?: { type: "text"; text: string };
  body: { text: string };
  footer?: { text: string };
  buttons?: Array<{ type: "quick_reply" | "url"; text: string; url?: string }>;
}

export interface TemplateContent {
  channel: MessageChannel;
  subject?: string | null;
  html?: string | null;
  text?: string | null;
  components?: WhatsAppComponents | null;
}

export const SMS_MAX_SEGMENTS = 4;

/** All text fields a template can render, used for variable extraction. */
export function contentTexts(c: TemplateContent): string[] {
  if (c.channel === "email") return [c.subject ?? "", c.html ?? "", c.text ?? ""];
  if (c.channel === "sms") return [c.text ?? ""];
  const w = c.components;
  return [w?.header?.text ?? "", w?.body.text ?? "", w?.footer?.text ?? "", ...(w?.buttons ?? []).map((b) => b.text)];
}

/** Channel-specific rules: each channel exposes only what it can actually carry. */
export function validateContent(c: TemplateContent): { issues: TemplateIssue[]; variables: string[] } {
  const issues: TemplateIssue[] = [];
  if (c.channel === "email") {
    if (!c.subject?.trim()) issues.push({ code: "email_subject_missing", message: "An email needs a subject" });
    if (!c.html?.trim() && !c.text?.trim()) issues.push({ code: "email_body_missing", message: "An email needs an HTML or text body" });
    if (c.html && /<\s*script|javascript:|\son[a-z]+\s*=/i.test(c.html)) issues.push({ code: "email_active_content", message: "Scripts and inline event handlers are not allowed in email HTML" });
    if (c.subject && /[\r\n]/.test(c.subject)) issues.push({ code: "email_subject_newline", message: "The subject cannot contain line breaks" });
  } else if (c.channel === "sms") {
    if (!c.text?.trim()) issues.push({ code: "sms_body_missing", message: "An SMS needs text" });
    else if (smsStats(c.text).segments > SMS_MAX_SEGMENTS) issues.push({ code: "sms_too_long", message: `SMS would exceed ${SMS_MAX_SEGMENTS} segments` });
  } else {
    const w = c.components;
    if (!w?.body?.text?.trim()) issues.push({ code: "wa_body_missing", message: "A WhatsApp template needs a body" });
    else if (w.body.text.length > 1024) issues.push({ code: "wa_body_too_long", message: "WhatsApp body is limited to 1024 characters" });
    if (w?.header && w.header.text.length > 60) issues.push({ code: "wa_header_too_long", message: "WhatsApp header is limited to 60 characters" });
    if (w?.footer && w.footer.text.length > 60) issues.push({ code: "wa_footer_too_long", message: "WhatsApp footer is limited to 60 characters" });
    const btns = w?.buttons ?? [];
    if (btns.length > 3) issues.push({ code: "wa_too_many_buttons", message: "At most 3 buttons are allowed" });
    for (const b of btns) {
      if (b.text.length > 25) issues.push({ code: "wa_button_too_long", message: "Button text is limited to 25 characters" });
      if (b.type === "url" && !/^https:\/\//i.test(b.url ?? "")) issues.push({ code: "wa_button_url", message: "URL buttons must use https" });
    }
  }
  const all = extractVariables(contentTexts(c).join("\n"));
  issues.push(...all.issues);
  return { issues, variables: all.vars };
}

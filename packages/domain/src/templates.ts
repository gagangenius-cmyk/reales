import { randomUUID } from "node:crypto";
import { Op, Sequelize } from "sequelize";
import { mysqlDate, RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { MessageChannel, TemplateContent, validateContent, VARIABLE_CATALOG, WhatsAppComponents } from "./templating";
import { plain } from "./scope";
import { ConflictError, NotFoundError, withUow } from "./uow";

export class TemplateInvalidError extends Error {
  status = 422;
  constructor(public issues: Array<{ code: string; message: string }>) {
    super("The template content is not valid for this channel");
    this.name = "TemplateInvalidError";
  }
}

export interface TemplateVersionInput {
  subject?: string; designJson?: unknown; html?: string; text?: string; components?: WhatsAppComponents;
}

const toContent = (channel: MessageChannel, v: TemplateVersionInput): TemplateContent => ({ channel, subject: v.subject, html: v.html, text: v.text, components: v.components });

/** WhatsApp message templates must be approved by the provider/compliance before use; email and SMS do not. */
const needsApproval = (channel: MessageChannel) => channel === "whatsapp";

export async function createTemplate(sq: Sequelize, ctx: RequestContext, i: { name: string; channel: MessageChannel; purpose?: string; projectId?: string } & TemplateVersionInput) {
  authorize(ctx, "template.manage");
  const check = validateContent(toContent(i.channel, i));
  if (check.issues.length) throw new TemplateInvalidError(check.issues);
  return withUow(sq, ctx, async (u) => {
    if (i.purpose && !(await u.repo("ConsentPurpose").findOne({ where: { code: i.purpose }, transaction: u.tx }))) throw new ConflictError("Unknown consent purpose");
    if (await u.repo("Template").findOne({ where: { name: i.name }, transaction: u.tx })) throw new ConflictError("A template with this name already exists");
    const id = randomUUID();
    await u.repo("Template").create({ id, projectId: i.projectId ?? null, channel: i.channel, name: i.name, purpose: i.purpose ?? null, status: "draft", createdBy: ctx.userId }, { transaction: u.tx });
    const vid = await writeVersion(u, ctx, id, 1, i.channel, i, check.variables);
    await u.repo("Template").updateById(id, { currentVersionId: vid }, { transaction: u.tx });
    return getTemplateInUow(u, id);
  });
}

async function writeVersion(u: any, ctx: RequestContext, templateId: string, version: number, channel: MessageChannel, v: TemplateVersionInput, variables: string[]) {
  const id = randomUUID();
  const schema = Object.fromEntries(variables.map((x) => { const [r, f] = x.split("."); return [x, { type: VARIABLE_CATALOG[r!]![f!], required: true }]; }));
  await u.repo("TemplateVersion").create({
    id, templateId, version, subject: v.subject ?? null, designJson: v.designJson ?? null, renderedHtml: v.html ?? null, textBody: v.text ?? null,
    structuredComponentsJson: v.components ?? null, variableSchemaJson: schema, approvalStatus: needsApproval(channel) ? "pending" : "not_required",
    createdBy: ctx.userId, createdAt: mysqlDate(new Date()),
  }, { transaction: u.tx });
  return id;
}

/** An edit never mutates history: it adds a version, which (for approval-gated channels) must be approved again before it can be sent. */
export async function addTemplateVersion(sq: Sequelize, ctx: RequestContext, templateId: string, v: TemplateVersionInput) {
  authorize(ctx, "template.manage");
  return withUow(sq, ctx, async (u) => {
    const t: any = await u.repo("Template").findById(templateId, { transaction: u.tx });
    if (!t) throw new NotFoundError("Template");
    if (t.get("status") === "archived") throw new ConflictError("An archived template cannot be edited");
    const check = validateContent(toContent(t.get("channel"), v));
    if (check.issues.length) throw new TemplateInvalidError(check.issues);
    const last: any = await u.repo("TemplateVersion").findOne({ where: { templateId }, order: [["version", "DESC"]], transaction: u.tx });
    const vid = await writeVersion(u, ctx, templateId, (last?.get("version") ?? 0) + 1, t.get("channel"), v, check.variables);
    await u.repo("Template").updateById(templateId, { currentVersionId: vid, ...(needsApproval(t.get("channel")) ? { status: "draft" } : {}) }, { transaction: u.tx });
    await u.audit({ action: "template.version_added", entityType: "template", entityId: templateId, after: { version: (last?.get("version") ?? 0) + 1 } });
    return getTemplateInUow(u, templateId);
  });
}

/**
 * Approval is a distinct permission (template.approve) and cannot be self-granted by the author for approval-gated channels.
 * For channels without provider review (email/SMS) the template is simply marked approved for use.
 */
export async function approveTemplate(sq: Sequelize, ctx: RequestContext, templateId: string, outcome: "approved" | "rejected") {
  authorize(ctx, "template.approve");
  return withUow(sq, ctx, async (u) => {
    const t: any = await u.repo("Template").findById(templateId, { transaction: u.tx });
    if (!t) throw new NotFoundError("Template");
    const v: any = await u.repo("TemplateVersion").findById(t.get("currentVersionId"), { transaction: u.tx });
    if (needsApproval(t.get("channel")) && v.get("createdBy") === ctx.userId) throw new ConflictError("A different person must approve this template version");
    if (needsApproval(t.get("channel"))) await u.sq.query("UPDATE template_versions SET approval_status=:s WHERE id=:id AND tenant_id=:t", { replacements: { s: outcome, id: v.get("id"), t: ctx.tenantId }, transaction: u.tx });
    await u.repo("Template").updateById(templateId, { status: outcome === "approved" ? "approved" : "draft" }, { transaction: u.tx });
    await u.audit({ action: `template.${outcome}`, entityType: "template", entityId: templateId, after: { version: v.get("version") } });
    await u.emit({ type: `template.${outcome}`, aggregateType: "template", aggregateId: templateId, payload: { version: v.get("version") } });
    return getTemplateInUow(u, templateId);
  });
}

export async function archiveTemplate(sq: Sequelize, ctx: RequestContext, templateId: string) {
  authorize(ctx, "template.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("Template").findById(templateId, { transaction: u.tx }))) throw new NotFoundError("Template");
    const live = await u.repo("Campaign").count({ where: { status: { [Op.in]: ["scheduled", "preparing", "running", "paused"] } }, transaction: u.tx });
    void live;
    await u.repo("Template").updateById(templateId, { status: "archived" }, { transaction: u.tx });
    return getTemplateInUow(u, templateId);
  });
}

async function getTemplateInUow(u: any, id: string) {
  const t = await u.repo("Template").findById(id, { transaction: u.tx });
  if (!t) throw new NotFoundError("Template");
  const versions = await u.repo("TemplateVersion").findAll({ where: { templateId: id }, order: [["version", "ASC"]], transaction: u.tx });
  return { ...plain(t), versions: versions.map(plain) };
}

export async function getTemplate(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "template.read");
  return withUow(sq, ctx, (u) => getTemplateInUow(u, id));
}

export async function listTemplates(sq: Sequelize, ctx: RequestContext, f: { channel?: string; status?: string } = {}) {
  authorize(ctx, "template.read");
  return withUow(sq, ctx, async (u) => (await u.repo("Template").findAll({ where: { ...(f.channel ? { channel: f.channel } : {}), ...(f.status ? { status: f.status } : {}) }, order: [["createdAt", "DESC"]], transaction: u.tx })).map(plain));
}

/** Render a preview with sample values (no sending, no consent gate). */
export async function previewTemplate(sq: Sequelize, ctx: RequestContext, id: string, values: Record<string, Record<string, string | number>>) {
  authorize(ctx, "template.read");
  const { renderTemplate } = await import("./templating");
  return withUow(sq, ctx, async (u) => {
    const t: any = await u.repo("Template").findById(id, { transaction: u.tx });
    if (!t) throw new NotFoundError("Template");
    const v: any = await u.repo("TemplateVersion").findById(t.get("currentVersionId"), { transaction: u.tx });
    const html = t.get("channel") === "email" && !!v.get("renderedHtml");
    const src = t.get("channel") === "whatsapp" ? v.get("structuredComponentsJson")?.body?.text ?? "" : html ? v.get("renderedHtml") : v.get("textBody") ?? "";
    return { subject: v.get("subject") ? renderTemplate(v.get("subject"), values) : null, body: renderTemplate(src, values, { html }) };
  });
}

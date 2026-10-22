import { randomUUID } from "node:crypto";
import { Op, Sequelize } from "sequelize";
import type { RequestContext } from "@reales/database";
import { authorize } from "@reales/rbac";
import { DEAL_SCOPE, registerDealCreatedHook, registerDealGate } from "./deals";
import { plain, scopeWhere } from "./scope";
import { ConflictError, NotFoundError, Uow, withUow } from "./uow";

export const GATE_STAGES = ["none", "contract", "signed", "payment", "registration", "closed"] as const;
export type GateStage = (typeof GATE_STAGES)[number];
export interface TemplateItemInput { title: string; guidance?: string; required?: boolean; gateStage?: GateStage; dueOffsetDays?: number | null }

/** Sensible UAE starting points. They are editable on the Checklists page and are NOT legal advice: confirm requirements with your compliance officer. */
export const STARTER_TEMPLATES: { name: string; dealType: "sale" | "lease"; projectKind: "any" | "ready" | "off_plan"; items: TemplateItemInput[] }[] = [
  { name: "Secondary sale (ready property)", dealType: "sale", projectKind: "ready", items: [
    { title: "Buyer passport and Emirates ID copies", gateStage: "contract", dueOffsetDays: 2 }, { title: "Seller title deed copy", gateStage: "contract", dueOffsetDays: 2 },
    { title: "Signed MOU / Form F", gateStage: "signed", dueOffsetDays: 3 }, { title: "Deposit receipt on file", gateStage: "signed", dueOffsetDays: 3 },
    { title: "Mortgage pre-approval or proof of funds", required: false, gateStage: "payment", dueOffsetDays: 7 }, { title: "Developer NOC", gateStage: "registration", dueOffsetDays: 14 },
    { title: "Manager's cheques arranged", gateStage: "registration", dueOffsetDays: 20 }, { title: "DLD transfer appointment booked", gateStage: "registration", dueOffsetDays: 21 }, { title: "Title deed issued to buyer", gateStage: "closed", dueOffsetDays: 30 },
  ] },
  { name: "Off-plan sale", dealType: "sale", projectKind: "off_plan", items: [
    { title: "Buyer passport and Emirates ID copies", gateStage: "contract", dueOffsetDays: 2 }, { title: "Reservation form signed", gateStage: "contract", dueOffsetDays: 2 },
    { title: "Booking deposit receipt", gateStage: "signed", dueOffsetDays: 3 }, { title: "SPA signed by buyer and developer", gateStage: "signed", dueOffsetDays: 14 },
    { title: "Payment plan schedule confirmed", gateStage: "payment", dueOffsetDays: 14 }, { title: "Oqood registration completed", gateStage: "registration", dueOffsetDays: 30 }, { title: "Developer commission invoice sent", gateStage: "closed", dueOffsetDays: 35 },
  ] },
  { name: "Residential lease", dealType: "lease", projectKind: "any", items: [
    { title: "Tenant passport, visa and Emirates ID", gateStage: "contract", dueOffsetDays: 1 }, { title: "Landlord title deed and ID", gateStage: "contract", dueOffsetDays: 1 },
    { title: "Security deposit and first cheque received", gateStage: "signed", dueOffsetDays: 2 }, { title: "Tenancy contract signed", gateStage: "signed", dueOffsetDays: 2 },
    { title: "Ejari registered", gateStage: "registration", dueOffsetDays: 5 }, { title: "Utilities (DEWA) connected", required: false, gateStage: "closed", dueOffsetDays: 7 }, { title: "Keys and move-in checklist handed over", gateStage: "closed", dueOffsetDays: 7 },
  ] },
];

const clean = (items: TemplateItemInput[]) => {
  if (!items.length) throw new ConflictError("A checklist needs at least one item");
  if (items.length > 60) throw new ConflictError("A checklist can have at most 60 items");
  return items.map((i, n) => {
    if (!i.title?.trim()) throw new ConflictError(`Item ${n + 1} needs a title`);
    if (i.gateStage && !GATE_STAGES.includes(i.gateStage)) throw new ConflictError(`Unknown stage "${i.gateStage}"`);
    return { position: n, title: i.title.trim().slice(0, 200), guidance: i.guidance?.trim().slice(0, 500) || null, required: i.required ?? true, gateStage: i.gateStage ?? "none", dueOffsetDays: i.dueOffsetDays ?? null };
  });
};

export async function saveChecklistTemplate(sq: Sequelize, ctx: RequestContext, i: { id?: string; name: string; dealType: "sale" | "lease"; projectKind?: "any" | "ready" | "off_plan"; active?: boolean; items: TemplateItemInput[] }) {
  authorize(ctx, "deal.checklist.manage");
  const items = clean(i.items);
  if (!i.name.trim()) throw new ConflictError("Give the checklist a name");
  return withUow(sq, ctx, async (u) => {
    let id = i.id;
    if (id) {
      if (!(await u.repo("DealChecklistTemplate").findById(id, { transaction: u.tx }))) throw new NotFoundError("Checklist template");
      await u.repo("DealChecklistTemplate").updateById(id, { name: i.name.trim(), dealType: i.dealType, projectKind: i.projectKind ?? "any", active: i.active ?? true }, { transaction: u.tx });
      await u.repo("DealChecklistTemplateItem").deleteWhere({ templateId: id }, { transaction: u.tx });
    } else {
      id = randomUUID();
      await u.repo("DealChecklistTemplate").create({ id, name: i.name.trim(), dealType: i.dealType, projectKind: i.projectKind ?? "any", active: i.active ?? true }, { transaction: u.tx });
    }
    for (const it of items) await u.repo("DealChecklistTemplateItem").create({ id: randomUUID(), templateId: id, ...it }, { transaction: u.tx });
    await u.audit({ action: i.id ? "checklist_template.updated" : "checklist_template.created", entityType: "deal_checklist_template", entityId: id, after: { name: i.name, items: items.length } });
    return { id, items: items.length };
  });
}

export async function installStarterChecklists(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "deal.checklist.manage");
  const existing = await listChecklistTemplates(sq, ctx);
  let added = 0;
  for (const t of STARTER_TEMPLATES) if (!existing.some((e: any) => e.name === t.name)) { await saveChecklistTemplate(sq, ctx, t); added++; }
  return { added };
}

export async function listChecklistTemplates(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "deal.checklist.manage");
  return withUow(sq, ctx, async (u) => {
    const [templates, items] = await Promise.all([
      u.repo("DealChecklistTemplate").findAll({ order: [["name", "ASC"]], transaction: u.tx }),
      u.repo("DealChecklistTemplateItem").findAll({ order: [["position", "ASC"]], transaction: u.tx }),
    ]);
    return (templates as any[]).map((t) => ({ ...plain(t), items: (items as any[]).filter((x) => x.get("templateId") === t.get("id")).map(plain) }));
  });
}

export async function deleteChecklistTemplate(sq: Sequelize, ctx: RequestContext, id: string) {
  authorize(ctx, "deal.checklist.manage");
  return withUow(sq, ctx, async (u) => {
    if (!(await u.repo("DealChecklistTemplate").findById(id, { transaction: u.tx }))) throw new NotFoundError("Checklist template");
    // Deals keep their own copy of the items, so deleting a template never changes a deal in flight.
    await u.repo("DealChecklistTemplateItem").deleteWhere({ templateId: id }, { transaction: u.tx });
    await u.repo("DealChecklistTemplate").deleteById(id, { transaction: u.tx });
    await u.audit({ action: "checklist_template.deleted", entityType: "deal_checklist_template", entityId: id });
  });
}

/** Copy the newest active template that fits the deal (type, and project kind when known) onto the deal. Called when a deal is created. */
export async function instantiateChecklist(u: Uow, deal: any) {
  const kind = await dealProjectKind(u, deal);
  const templates = (await u.repo("DealChecklistTemplate").findAll({ where: { active: true, dealType: deal.get("dealType") }, order: [["createdAt", "DESC"]], transaction: u.tx })) as any[];
  const pick = templates.find((t) => t.get("projectKind") === kind) ?? templates.find((t) => t.get("projectKind") === "any");
  if (!pick) return 0;
  const items = (await u.repo("DealChecklistTemplateItem").findAll({ where: { templateId: pick.get("id") }, order: [["position", "ASC"]], transaction: u.tx })) as any[];
  const now = Date.now();
  for (const it of items) {
    const off = it.get("dueOffsetDays");
    await u.repo("DealChecklistItem").create({
      id: randomUUID(), dealId: deal.get("id"), templateItemId: it.get("id"), position: it.get("position"), title: it.get("title"), guidance: it.get("guidance"), required: it.get("required"),
      gateStage: it.get("gateStage"), status: "pending", dueAt: off == null ? null : new Date(now + off * 86_400_000), assigneeUserId: deal.get("agentUserId") ?? null,
    }, { transaction: u.tx });
  }
  return items.length;
}

async function dealProjectKind(u: Uow, deal: any): Promise<"ready" | "off_plan" | "any"> {
  try {
    const unit: any = await u.repo("Unit").findById(deal.get("unitId"), { transaction: u.tx });
    const b: any = unit ? await u.repo("Building").findById(unit.get("buildingId"), { transaction: u.tx }) : null;
    const p: any = b ? await u.repo("ReProject").findById(b.get("reProjectId"), { transaction: u.tx }) : null;
    return (p?.get("kind") as "ready" | "off_plan") ?? "any";
  } catch { return "any"; }
}

registerDealCreatedHook(async (u, deal) => { await instantiateChecklist(u, deal); });

const ORDER = ["contract", "signed", "payment", "registration", "closed"] as const;
/** A required item gated on stage X (or an earlier one) must be done or waived before the deal can reach X. */
registerDealGate(async (u, deal, to) => {
  const ti = ORDER.indexOf(to as (typeof ORDER)[number]);
  if (ti < 0) return [];
  const open = (await u.repo("DealChecklistItem").findAll({ where: { dealId: deal.get("id"), required: true, status: "pending", gateStage: { [Op.ne]: "none" } }, transaction: u.tx })) as any[];
  return open.filter((x) => ORDER.indexOf(x.get("gateStage")) <= ti).map((x) => `Checklist: "${x.get("title")}" is not done`);
});

async function dealIn(u: Uow, ctx: RequestContext, dealId: string, perm: string) {
  const scope = await scopeWhere(u, ctx, perm, DEAL_SCOPE);
  const d: any = await u.repo("Deal").findOne({ where: { [Op.and]: [{ id: dealId }, scope] }, transaction: u.tx });
  if (!d) throw new NotFoundError("Deal");
  return d;
}

export async function getDealChecklist(sq: Sequelize, ctx: RequestContext, dealId: string) {
  return withUow(sq, ctx, async (u) => {
    await dealIn(u, ctx, dealId, "deal.read");
    const items = (await u.repo("DealChecklistItem").findAll({ where: { dealId }, order: [["position", "ASC"]], transaction: u.tx })).map(plain);
    const required = items.filter((i: any) => i.required);
    return { items, progress: { done: items.filter((i: any) => i.status !== "pending").length, total: items.length, requiredOpen: required.filter((i: any) => i.status === "pending").length } };
  });
}

export async function addChecklistItem(sq: Sequelize, ctx: RequestContext, dealId: string, i: TemplateItemInput & { dueAt?: string; assigneeUserId?: string }) {
  return withUow(sq, ctx, async (u) => {
    const d = await dealIn(u, ctx, dealId, "deal.read");
    authorize(ctx, "deal.update", { ownerUserId: d.get("agentUserId"), branchId: d.get("branchId"), projectId: d.get("projectId") });
    if (!i.title?.trim()) throw new ConflictError("An item needs a title");
    const n = await u.repo("DealChecklistItem").count({ where: { dealId }, transaction: u.tx });
    const id = randomUUID();
    await u.repo("DealChecklistItem").create({ id, dealId, position: n, title: i.title.trim().slice(0, 200), guidance: i.guidance?.trim() || null, required: i.required ?? true, gateStage: i.gateStage ?? "none", status: "pending", dueAt: i.dueAt ? new Date(i.dueAt) : null, assigneeUserId: i.assigneeUserId ?? d.get("agentUserId") ?? null }, { transaction: u.tx });
    return { id };
  });
}

/** Mark an item done, waive it (reason required; needs deal.close because it lets a deal skip a requirement) or reopen it. */
export async function updateChecklistItem(sq: Sequelize, ctx: RequestContext, itemId: string, i: { status?: "pending" | "done" | "waived"; reason?: string; assigneeUserId?: string | null; dueAt?: string | null; note?: string; documentId?: string | null }) {
  return withUow(sq, ctx, async (u) => {
    const item: any = await u.repo("DealChecklistItem").findById(itemId, { transaction: u.tx });
    if (!item) throw new NotFoundError("Checklist item");
    const d = await dealIn(u, ctx, item.get("dealId"), "deal.read");
    const res = { ownerUserId: d.get("agentUserId"), branchId: d.get("branchId"), projectId: d.get("projectId") };
    authorize(ctx, "deal.update", res);
    const patch: Record<string, unknown> = {};
    if (i.status && i.status !== item.get("status")) {
      if (i.status === "waived") {
        authorize(ctx, "deal.close", res);
        if (!i.reason?.trim()) throw new ConflictError("A reason is required to waive a checklist item");
        patch.waivedReason = i.reason.trim();
      }
      patch.status = i.status;
      patch.completedBy = i.status === "pending" ? null : ctx.userId;
      patch.completedAt = i.status === "pending" ? null : new Date();
      if (i.status !== "waived") patch.waivedReason = null;
      await u.audit({ action: `checklist_item.${i.status}`, entityType: "deal", entityId: item.get("dealId"), reason: i.reason, after: { item: item.get("title") } });
    }
    if (i.assigneeUserId !== undefined) patch.assigneeUserId = i.assigneeUserId;
    if (i.dueAt !== undefined) patch.dueAt = i.dueAt ? new Date(i.dueAt) : null;
    if (i.note !== undefined) patch.note = i.note.slice(0, 500) || null;
    if (i.documentId !== undefined) patch.documentId = i.documentId;
    if (Object.keys(patch).length) await u.repo("DealChecklistItem").updateById(itemId, patch, { transaction: u.tx });
    return plain(await u.repo("DealChecklistItem").findById(itemId, { transaction: u.tx }));
  });
}

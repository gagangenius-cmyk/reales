import { z } from "zod";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const iso = z.string().datetime({ offset: true });
const money = z.number().positive().finite();

const page = { limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) };

// ---- viewings
export const scheduleViewingSchema = z.object({
  leadId: uuid.optional(), contactId: uuid.optional(), unitId: uuid.optional(), listingId: uuid.optional(), agentUserId: uuid.optional(),
  scheduledAt: iso, durationMin: z.number().int().min(10).max(240).optional(), locationNote: z.string().max(255).optional(),
}).strict().refine((v) => !!v.leadId || !!v.contactId, { message: "provide leadId or contactId" });
export const completeViewingSchema = z.object({ rating: z.number().int().min(1).max(5), interest: z.enum(["high", "medium", "low", "none"]), notes: z.string().max(4000).optional() }).strict();
export const reasonSchema = z.object({ reason: z.string().min(1).max(255) }).strict();
export const viewingListQuery = z.object({
  ...page, status: z.enum(["scheduled", "checked_in", "completed", "cancelled", "no_show"]).optional(), from: iso.optional(), to: iso.optional(),
  mine: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});

// ---- offers and reservations
export const createOfferSchema = z.object({
  unitId: uuid, contactId: uuid, leadId: uuid.optional(), amount: money, depositAmount: money.optional(), validUntil: iso.optional(), terms: z.record(z.unknown()).optional(),
}).strict();
export const counterOfferSchema = z.object({ amount: money, by: z.enum(["buyer", "seller"]), terms: z.record(z.unknown()).optional() }).strict();
export const offerListQuery = z.object({ ...page, status: z.enum(["draft", "submitted", "countered", "accepted", "rejected", "withdrawn", "expired"]).optional(), unitId: uuid.optional() });
export const createReservationSchema = z.object({ unitId: uuid, contactId: uuid, offerId: uuid.optional(), depositAmount: money.optional(), holdHours: z.number().int().min(1).max(24 * 14).optional() }).strict();
export const reservationListQuery = z.object({ ...page, status: z.enum(["active", "converted", "cancelled", "expired"]).optional() });

// ---- deals
export const createDealSchema = z.object({ reservationId: uuid, dealType: z.enum(["sale", "lease"]).optional(), amount: money.optional() }).strict();
export const dealStageSchema = z.object({ to: z.enum(["reserved", "contract", "signed", "payment", "registration", "closed"]), reason: z.string().max(255).optional() }).strict();
export const paymentPlanSchema = z.object({ installments: z.array(z.object({ title: z.string().min(1).max(180), dueDate: isoDate, amount: money }).strict()).min(1).max(60) }).strict();
export const milestoneCompleteSchema = z.object({ waive: z.boolean().optional(), reason: z.string().max(255).optional() }).strict();
export const dealListQuery = z.object({ ...page, status: z.enum(["open", "closed", "cancelled"]).optional(), stage: z.enum(["reserved", "contract", "signed", "payment", "registration", "closed", "cancelled"]).optional() });

// ---- documents (multipart fields are validated separately)
export const documentKind = z.enum(["contract", "id_document", "permit", "invoice", "receipt", "other"]);
export const linkSchema = z.object({ entityType: z.enum(["deal", "lead", "listing", "contact"]), entityId: uuid }).strict();
export const documentListQuery = z.object({ entityType: z.enum(["deal", "lead", "listing", "contact"]), entityId: uuid });
export const downloadQuery = z.object({ version: z.coerce.number().int().min(1).optional() });

// ---- signatures
export const createEnvelopeSchema = z.object({
  documentId: uuid, version: z.number().int().min(1).optional(), dealId: uuid.optional(), provider: z.string().max(40).optional(),
  signers: z.array(z.object({ name: z.string().min(1).max(180), email: z.string().email().max(254), contactId: uuid.optional(), order: z.number().int().min(1).max(20).optional() }).strict()).min(1).max(20),
}).strict();
export const simulateSignSchema = z.object({ signerEmail: z.string().email(), action: z.enum(["sign", "decline"]).default("sign") }).strict();

// ---- finance
export const invoiceSchema = z.object({
  contactId: uuid, dealId: uuid.optional(), dueDate: isoDate.optional(), currency: z.string().length(3).optional(),
  lines: z.array(z.object({ description: z.string().min(1).max(255), quantity: z.number().positive().max(100000), unitPrice: z.number().min(0).max(1e12), vatRate: z.number().min(0).max(100).optional() }).strict()).min(1).max(100),
}).strict();
export const voidInvoiceSchema = z.object({ reason: z.string().min(1).max(255) }).strict();
export const invoiceListQuery = z.object({ ...page, status: z.enum(["draft", "issued", "partially_paid", "paid", "void"]).optional(), contactId: uuid.optional() });
export const recordPaymentSchema = z.object({
  contactId: uuid, amount: money, method: z.enum(["card", "bank_transfer", "cheque", "cash"]), currency: z.string().length(3).optional(),
  providerRef: z.string().max(120).optional(), dealId: uuid.optional(), milestoneId: uuid.optional(), invoiceId: uuid.optional(), receivedAt: iso.optional(),
}).strict();
export const paymentLinkSchema = z.object({ contactId: uuid, amount: money, currency: z.string().length(3).optional(), invoiceId: uuid.optional(), dealId: uuid.optional(), milestoneId: uuid.optional(), provider: z.string().max(40).optional() }).strict();
export const paymentListQuery = z.object({ ...page, status: z.enum(["pending", "succeeded", "failed"]).optional() });

// ---- commissions
export const commissionPlanSchema = z.object({
  name: z.string().min(1).max(120), dealType: z.enum(["sale", "lease"]), ratePct: z.number().gt(0).max(100),
  splits: z.array(z.object({ role: z.string().min(1).max(40), pct: z.number().gt(0).max(100) }).strict()).min(1).max(10),
  agentType: z.enum(["any", "internal", "external"]).optional(), vatPct: z.number().min(0).max(30).optional(),
  slabs: z.array(z.object({ fromValue: z.number().min(0), ratePct: z.number().gt(0).max(100).optional(), agentSharePct: z.number().gt(0).max(100).optional(), label: z.string().max(60).optional() }).strict()).max(12).optional(),
}).strict();
export const agentProfileSchema = z.object({
  userId: z.string().uuid(), agentType: z.enum(["internal", "external"]), commissionPlanId: z.string().uuid().nullable().optional(),
  brn: z.string().max(40).nullable().optional(), agencyName: z.string().max(160).nullable().optional(), agencyLicenceNo: z.string().max(60).nullable().optional(),
  payoutNote: z.string().max(255).nullable().optional(), status: z.enum(["active", "inactive"]).optional(),
}).strict();
export const commissionPaySchema = z.object({ reference: z.string().min(1).max(120) }).strict();
export const commissionListQuery = z.object({ ...page, status: z.enum(["calculated", "approved", "void"]).optional() });

// ---- roles and permissions
const grantSchema = z.object({ permission: z.string().min(1).max(100), scope: z.enum(["tenant", "business_unit", "branch", "project", "portfolio", "own_records"]) }).strict();
export const createRoleSchema = z.object({
  name: z.string().trim().min(2).max(120), requiresMfa: z.boolean().optional(),
  grants: z.array(grantSchema).max(400).default([]), copyFromRoleId: z.string().uuid().optional(),
}).strict();
export const setRoleGrantsSchema = z.object({ grants: z.array(grantSchema).max(400), name: z.string().trim().min(2).max(120).optional(), requiresMfa: z.boolean().optional() }).strict();

// ---- agent availability
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const weeklyAvailabilitySchema = z.object({
  windows: z.array(z.object({ weekday: z.number().int().min(0).max(6), startTime: hhmm, endTime: hhmm }).strict()).max(60),
}).strict();
export const timeOffSchema = z.object({ startsAt: z.string().min(10), endsAt: z.string().min(10), reason: z.string().max(160).optional() }).strict();
export const freeSlotsQuery = z.object({ agentUserId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), durationMin: z.coerce.number().int().min(10).max(240).default(30) });

// ---- teams, targets, deal checklists
const gateStage = z.enum(["none", "contract", "signed", "payment", "registration", "closed"]);
export const teamUpdateSchema = z.object({
  name: z.string().trim().min(1).max(180).optional(), branchId: z.string().uuid().nullable().optional(), parentTeamId: z.string().uuid().nullable().optional(),
  description: z.string().max(255).nullable().optional(), status: z.enum(["active", "archived"]).optional(),
}).strict();
export const teamMemberSchema = z.object({ userId: z.string().uuid(), role: z.enum(["leader", "member"]).optional() }).strict();
export const targetSchema = z.object({
  scopeType: z.enum(["user", "team", "branch", "tenant"]), scopeId: z.string().uuid().nullable().optional(), periodType: z.enum(["month", "quarter", "year"]),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), metric: z.enum(["closed_value", "closed_deals", "new_leads", "viewings_done"]), targetValue: z.number().gt(0), note: z.string().max(255).optional(),
}).strict();
export const targetQuery = z.object({ period: z.enum(["month", "quarter", "year"]).default("month"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const checklistItem = z.object({ title: z.string().trim().min(1).max(200), guidance: z.string().max(500).optional(), required: z.boolean().optional(), gateStage: gateStage.optional(), dueOffsetDays: z.number().int().min(0).max(365).nullable().optional() }).strict();
export const checklistTemplateSchema = z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(160), dealType: z.enum(["sale", "lease"]), projectKind: z.enum(["any", "ready", "off_plan"]).optional(), active: z.boolean().optional(), items: z.array(checklistItem).min(1).max(60) }).strict();
export const checklistItemAddSchema = checklistItem.extend({ dueAt: z.string().datetime().optional(), assigneeUserId: z.string().uuid().optional() }).strict();
export const checklistItemUpdateSchema = z.object({ status: z.enum(["pending", "done", "waived"]).optional(), reason: z.string().max(255).optional(), assigneeUserId: z.string().uuid().nullable().optional(), dueAt: z.string().datetime().nullable().optional(), note: z.string().max(500).optional(), documentId: z.string().uuid().nullable().optional() }).strict();

// ---- lead pools, repool rules, calls
const uuidV = z.string().uuid();
export const poolSchema = z.object({ id: uuidV.optional(), name: z.string().trim().min(1).max(120), description: z.string().max(255).nullable().optional(), branchId: uuidV.nullable().optional(), dailyClaimLimit: z.number().int().min(1).nullable().optional(), active: z.boolean().optional() }).strict();
export const releaseSchema = z.object({ poolId: uuidV, reason: z.string().trim().min(1).max(200) }).strict();
export const repoolRuleSchema = z.object({
  id: uuidV.optional(), name: z.string().trim().min(1).max(120), triggerKind: z.enum(["no_first_response", "no_activity"]), afterMinutes: z.number().int().min(5).max(60 * 24 * 30),
  action: z.enum(["reassign", "to_pool", "notify_manager"]), poolId: uuidV.nullable().optional(), maxRepools: z.number().int().min(1).max(20).optional(), hotOnly: z.boolean().optional(), active: z.boolean().optional(),
}).strict();
export const callSchema = z.object({
  leadId: uuidV.optional(), contactId: uuidV.optional(), direction: z.enum(["outbound", "inbound"]).optional(), outcome: z.enum(["answered", "no_answer", "busy", "voicemail", "wrong_number", "callback_requested", "not_interested"]),
  startedAt: z.string().datetime().optional(), durationSec: z.number().int().min(0).max(21600).optional(), notes: z.string().max(4000).optional(), followUpAt: z.string().datetime().optional(), recordingUrl: z.string().url().max(500).optional(),
}).strict().refine((v) => !!v.leadId || !!v.contactId, { message: "provide a leadId or a contactId" });
export const callListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0), userId: uuidV.optional(), leadId: uuidV.optional(),
  outcome: z.enum(["answered", "no_answer", "busy", "voicemail", "wrong_number", "callback_requested", "not_interested"]).optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export const callStatsQuery = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

// ---- inbound lead sources
export const ingestSourceSchema = z.object({
  name: z.string().trim().min(1).max(120), kind: z.enum(["meta", "portal", "website", "generic"]), sourceCode: z.string().max(60).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(), poolId: z.string().uuid().nullable().optional(), routeMode: z.enum(["rules", "pool"]).optional(),
  defaultPurpose: z.enum(["buy", "rent", "invest", "off_plan"]).optional(), campaign: z.string().max(160).nullable().optional(),
}).strict();
export const ingestSourcePatchSchema = z.object({ active: z.boolean() }).strict();

// ---- payouts, noticeboard, support
export const payoutRequestSchema = z.object({ calculationIds: z.array(z.string().uuid()).min(1).max(100), invoiceRef: z.string().trim().max(80).optional(), note: z.string().max(500).optional() }).strict();
export const payoutDecisionSchema = z.object({ outcome: z.enum(["approved", "rejected"]), reason: z.string().max(255).optional() }).strict();
export const payoutPaySchema = z.object({ reference: z.string().trim().min(1).max(120) }).strict();
export const noticeSchema = z.object({
  id: z.string().uuid().optional(), title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20000), audience: z.enum(["all", "branch"]).optional(), branchId: z.string().uuid().nullable().optional(),
  pinned: z.boolean().optional(), requiresAck: z.boolean().optional(), publishAt: z.string().datetime().optional(), expiresAt: z.string().datetime().nullable().optional(),
}).strict();
export const noticeMarkSchema = z.object({ ack: z.boolean().optional() }).strict();
export const supportTicketSchema = z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(20000), category: z.enum(["bug", "access", "data", "question", "request", "other"]).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(), pageUrl: z.string().max(300).optional() }).strict();
export const supportCommentSchema = z.object({ body: z.string().trim().min(1).max(20000), internal: z.boolean().optional() }).strict();
export const supportUpdateSchema = z.object({ status: z.enum(["open", "in_progress", "waiting", "resolved", "closed"]).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(), assigneeId: z.string().uuid().nullable().optional() }).strict();
export const supportListQuery = z.object({ status: z.string().max(20).optional(), mine: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });

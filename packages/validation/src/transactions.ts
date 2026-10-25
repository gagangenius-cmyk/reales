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

// ---- listing detail, distribution, website
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const listingDetailsSchema = z.object({
  title: z.string().max(255).nullable().optional(), description: z.string().max(10000).nullable().optional(), titleAr: z.string().max(255).nullable().optional(), descriptionAr: z.string().max(10000).nullable().optional(),
  price: z.number().positive().nullable().optional(), ownerPrice: z.number().positive().nullable().optional(), features: z.array(z.string().max(60)).max(80).optional(),
  furnishing: z.enum(["unfurnished", "semi_furnished", "furnished"]).nullable().optional(), parkingSpaces: z.number().int().min(0).max(50).nullable().optional(),
  rentFrequency: z.enum(["yearly", "quarterly", "monthly"]).nullable().optional(), cheques: z.number().int().min(1).max(12).nullable().optional(),
  securityDeposit: z.number().min(0).nullable().optional(), serviceCharge: z.number().min(0).nullable().optional(), commissionPct: z.number().min(0).max(100).nullable().optional(),
  videoUrl: z.string().max(300).nullable().optional(), virtualTourUrl: z.string().max(300).nullable().optional(),
  exclusivity: z.enum(["none", "exclusive", "non_exclusive"]).optional(), agreementStartsOn: dateStr.nullable().optional(), agreementExpiresOn: dateStr.nullable().optional(), expiresOn: dateStr.nullable().optional(),
  featured: z.boolean().optional(), latitude: z.number().min(-90).max(90).nullable().optional(), longitude: z.number().min(-180).max(180).nullable().optional(),
  completionStatus: z.enum(["ready", "off_plan"]).nullable().optional(), ownership: z.enum(["freehold", "leasehold", "usufruct", "musataha"]).nullable().optional(), yearBuilt: z.number().int().min(1900).max(2100).nullable().optional(), availableFrom: dateStr.nullable().optional(), utilitiesIncluded: z.boolean().nullable().optional(),
}).strict();
export const mediaOrderSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }).strict();
export const mediaPatchSchema = z.object({ caption: z.string().max(200).nullable().optional(), cover: z.boolean().optional() }).strict();
export const shareSchema = z.object({ enabled: z.boolean().optional(), regenerate: z.boolean().optional() }).strict();
export const channelSchema = z.object({ portalAccountId: z.string().uuid(), enabled: z.boolean() }).strict();
export const bulkListingSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("publish") }).strict(), z.object({ type: z.literal("unpublish"), reason: z.string().max(200).optional() }).strict(), z.object({ type: z.literal("refresh") }).strict(),
    z.object({ type: z.literal("assign"), userId: z.string().uuid() }).strict(), z.object({ type: z.literal("feature"), value: z.boolean() }).strict(),
    z.object({ type: z.literal("archive") }).strict(), z.object({ type: z.literal("close"), outcome: z.enum(["sold", "rented", "withdrawn"]) }).strict(),
  ]),
}).strict();
export const credentialsSchema = z.object({
  baseUrl: z.string().url().max(300), apiKey: z.string().min(1).max(300), apiSecret: z.string().min(1).max(300),
  tokenPath: z.string().max(120).optional(), listingsPath: z.string().max(120).optional(), locationsPath: z.string().max(120).optional(), locationMap: z.record(z.union([z.string(), z.number()])).optional(),
}).strict();
export const portalModeSchema = z.object({ mode: z.enum(["export", "api"]) }).strict();
export const siteSettingsSchema = z.object({
  enabled: z.boolean().optional(), title: z.string().max(120).nullable().optional(), tagline: z.string().max(200).nullable().optional(), about: z.string().max(8000).nullable().optional(),
  phone: z.string().max(40).nullable().optional(), whatsapp: z.string().max(40).nullable().optional(), email: z.string().max(254).nullable().optional(), address: z.string().max(255).nullable().optional(),
  logoUrl: z.string().max(400).nullable().optional(), primaryColor: z.string().max(9).nullable().optional(), defaultLanguage: z.enum(["en", "ar"]).optional(), showPrices: z.boolean().optional(),
  areaUnit: z.enum(["sqft", "sqm"]).optional(), seoDescription: z.string().max(300).nullable().optional(), social: z.record(z.string().max(400)).optional(),
}).strict();
export const publicEnquirySchema = z.object({
  token: z.string().min(20).max(60), name: z.string().trim().min(1).max(120), phone: z.string().max(40).optional(), email: z.string().max(254).optional(), message: z.string().max(2000).optional(), website: z.string().max(200).optional(),
}).strict();

export const shortlistPdfSchema = z.object({
  listingIds: z.array(z.string().uuid()).min(1).max(30), clientName: z.string().trim().max(120).optional(), title: z.string().trim().max(120).optional(), notes: z.string().max(1500).optional(), leadId: z.string().uuid().optional(),
  layout: z.enum(["table", "detailed", "both"]).optional(), showPrice: z.boolean().optional(), includePhotos: z.boolean().optional(), includeFloorPlans: z.boolean().optional(), validityDays: z.number().int().min(1).max(90).optional(),
}).strict();

const trashRef = z.object({ entity: z.string().min(1).max(40), id: z.string().uuid() });
export const trashDeleteSchema = trashRef.extend({ reason: z.string().trim().max(300).optional() }).strict();
export const trashActionSchema = trashRef.strict();
export const trashListQuery = z.object({ entity: z.string().max(40).optional(), q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() });

export const configModulesSchema = z.object({ modules: z.record(z.string().max(40), z.boolean()).refine((m) => Object.keys(m).length <= 60) }).strict();
export const configSettingsSchema = z.object({ settings: z.record(z.string().max(80), z.union([z.boolean(), z.number(), z.string().max(40)])).refine((m) => Object.keys(m).length <= 60) }).strict();

export const closeListingSchema = z.object({ outcome: z.enum(["sold", "rented", "withdrawn"]), dealId: z.string().uuid().optional(), note: z.string().trim().max(300).optional() }).strict();

const ptype = z.enum(["apartment", "villa", "townhouse", "penthouse", "office", "retail", "land", "duplex", "hotel_apartment", "studio", "compound", "full_floor", "half_floor", "whole_building", "bulk_units", "warehouse", "showroom", "labour_camp", "factory", "farm", "staff_accommodation"]);
export const newPropertyListingSchema = z.object({
  emirate: z.string().min(2).max(40), community: z.string().trim().min(1).max(120), subCommunity: z.string().trim().max(120).nullable().optional(), buildingName: z.string().trim().min(1).max(180), unitNumber: z.string().trim().min(1).max(40),
  type: ptype, purpose: z.enum(["sale", "rent"]), price: z.number().positive(), bedrooms: z.number().int().min(0).max(30).nullable().optional(), bathrooms: z.number().int().min(0).max(30).nullable().optional(),
  builtUpAreaSqft: z.number().positive().max(10_000_000), plotAreaSqft: z.number().positive().max(100_000_000).nullable().optional(), floor: z.number().int().min(-5).max(200).nullable().optional(), view: z.string().trim().max(80).nullable().optional(),
  currency: z.string().length(3).optional(), title: z.string().max(255).optional(), description: z.string().max(10000).optional(), agentUserId: z.string().uuid().optional(),
  completionStatus: z.enum(["ready", "off_plan"]).optional(), ownership: z.enum(["freehold", "leasehold", "usufruct", "musataha"]).nullable().optional(), yearBuilt: z.number().int().min(1900).max(2100).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(), longitude: z.number().min(-180).max(180).nullable().optional(),
}).strict();
export const locationSchema = z.object({ id: z.string().uuid().optional(), emirate: z.string().min(2).max(40), community: z.string().trim().min(1).max(120), subCommunity: z.string().trim().max(120).nullable().optional(), latitude: z.number().nullable().optional(), longitude: z.number().nullable().optional(), bayutId: z.string().trim().max(60).nullable().optional(), pfId: z.string().trim().max(60).nullable().optional(), active: z.boolean().optional() }).strict();
export const locationQuery = z.object({ emirate: z.string().max(40).optional(), q: z.string().max(80).optional(), all: z.enum(["1"]).optional() });

export const leadTransferSchema = z.object({ fromUserId: z.string().uuid(), toUserId: z.string().uuid(), scope: z.enum(["open", "hot", "all"]), reason: z.string().trim().max(300).optional(), dryRun: z.boolean().optional() }).strict();

export const publicLeadFormSchema = z.object({
  publicId: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/), name: z.string().trim().min(1).max(120), phone: z.string().trim().max(40).optional(), email: z.string().trim().max(254).optional(), message: z.string().max(2000).optional(),
  purpose: z.enum(["buy", "rent", "invest", "off_plan"]).optional(), budgetMax: z.number().positive().max(1e12).optional(), website: z.string().max(200).optional(),
}).strict();

export const telephonySchema = z.object({ accountSid: z.string().trim().max(64), authToken: z.string().trim().max(128).optional(), fromNumber: z.string().trim().max(32), enabled: z.boolean().optional() }).strict();
export const dialSchema = z.object({ leadId: uuidV.optional(), contactId: uuidV.optional() }).strict().refine((v) => !!v.leadId || !!v.contactId, { message: "provide a leadId or a contactId" });
export const mergeContactSchema = z.object({ duplicateId: uuidV }).strict();

import { z } from "zod";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const page = { limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) };
const method = z.enum(["bank_transfer", "cheque", "cash", "card"]);
const priority = z.enum(["urgent", "high", "normal", "low"]);

export const portfolioSchema = z.object({ name: z.string().min(1).max(160), ownerContactId: uuid, branchId: uuid.optional() }).strict();
export const ownershipSchema = z.object({ unitId: uuid, portfolioId: uuid, sharePct: z.number().gt(0).max(100).optional(), fromDate: date }).strict();
export const agreementSchema = z.object({ feePct: z.number().min(0).max(100), startsOn: date, endsOn: date.optional(), documentId: uuid.optional() }).strict();

export const leaseSchema = z.object({
  unitId: uuid, startsOn: date, endsOn: date, annualRent: z.number().positive().max(1_000_000_000), installments: z.number().int().min(1).max(12).optional(),
  tenantContactIds: z.array(uuid).min(1).max(6), guarantorContactIds: z.array(uuid).max(4).optional(), landlordContactId: uuid.optional(),
  depositAmount: z.number().nonnegative().max(1_000_000_000).optional(), agentUserId: uuid.optional(), portfolioId: uuid.optional(), registrationRef: z.string().min(1).max(80).optional(),
}).strict();
export const leaseListQuery = z.object({ ...page, status: z.enum(["draft", "active", "ended", "terminated"]).optional(), unitId: uuid.optional(), portfolioId: uuid.optional() });
export const leaseDocumentSchema = z.object({ documentId: uuid, registrationRef: z.string().min(1).max(80).optional() }).strict();
export const rentPaymentSchema = z.object({ amount: z.number().positive().max(1_000_000_000), method, providerRef: z.string().max(120).optional(), scheduleId: uuid.optional(), receivedAt: z.string().datetime().optional() }).strict();
export const depositCollectSchema = z.object({ method, providerRef: z.string().max(120).optional() }).strict();
export const depositDeductSchema = z.object({ amount: z.number().positive().max(1_000_000_000), reason: z.string().min(3).max(500) }).strict();
export const addendumSchema = z.object({ title: z.string().min(1).max(200), effectiveOn: date, changes: z.record(z.unknown()).optional(), documentId: uuid.optional() }).strict();
export const terminateSchema = z.object({ effectiveOn: date, reason: z.string().min(3).max(500), noticeGivenOn: date.optional() }).strict();
export const renewSchema = z.object({ newAnnualRent: z.number().positive().max(1_000_000_000), newEndsOn: date.optional(), installments: z.number().int().min(1).max(12).optional(), overrideReason: z.string().max(500).optional() }).strict();

export const vendorSchema = z.object({
  name: z.string().min(1).max(180), categories: z.array(z.string().min(1).max(40)).min(1).max(12), contactName: z.string().max(120).optional(), phoneE164: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),
  email: z.string().email().max(254).optional(), tradeLicenceNo: z.string().max(80).optional(), licenceExpiresOn: date.optional(),
}).strict();
export const vendorStatusSchema = z.object({ status: z.enum(["active", "suspended"]) }).strict();

export const ticketSchema = z.object({
  unitId: uuid, category: z.enum(["plumbing", "electrical", "hvac", "appliance", "structural", "cleaning", "pest", "other"]), priority: priority.optional(),
  title: z.string().min(1).max(255), description: z.string().max(4000).optional(), reporterContactId: uuid.optional(), assignedUserId: uuid.optional(),
}).strict();
export const ticketListQuery = z.object({ ...page, status: z.string().max(20).optional(), unitId: uuid.optional(), breachedOnly: z.enum(["true", "false"]).transform((v) => v === "true").optional() });
export const triageSchema = z.object({ assignedUserId: uuid.optional(), priority: priority.optional() }).strict();
export const quotationSchema = z.object({ vendorId: uuid, amount: z.number().positive().max(1_000_000_000), notes: z.string().max(500).optional() }).strict();
export const quotationDecisionSchema = z.object({ outcome: z.enum(["approved", "rejected"]) }).strict();
export const workOrderSchema = z.object({ vendorId: uuid.optional(), scheduledAt: z.string().datetime().optional() }).strict();
export const completeWorkSchema = z.object({ finalCost: z.number().nonnegative().max(1_000_000_000), notes: z.string().max(1000).optional() }).strict();

const kind = z.enum(["move_in", "move_out", "periodic"]);
export const inspectionTemplateSchema = z.object({ name: z.string().min(1).max(160), kind, items: z.array(z.object({ label: z.string().min(1).max(200), area: z.string().max(80).optional() }).strict()).min(1).max(200) }).strict();
export const inspectionSchema = z.object({ unitId: uuid, kind, inspectorUserId: uuid, templateId: uuid.optional(), leaseId: uuid.optional(), scheduledFor: z.string().datetime().optional() }).strict();
export const inspectionListQuery = z.object({ ...page, status: z.enum(["scheduled", "in_progress", "completed", "signed"]).optional(), unitId: uuid.optional() });
export const inspectionSyncSchema = z.object({
  mutations: z.array(z.object({
    clientMutationId: z.string().min(1).max(80), baseVersion: z.number().int().min(0),
    changes: z.array(z.object({ itemId: uuid, condition: z.enum(["good", "fair", "poor", "damaged", "na"]).optional(), notes: z.string().max(1000).nullable().optional(), meterReading: z.number().nullable().optional() }).strict()).max(200),
    addMediaDocumentIds: z.array(z.object({ itemId: uuid.optional(), documentId: uuid }).strict()).max(50).optional(),
  }).strict()).max(200),
}).strict();
export const inspectionCompleteSchema = z.object({ summary: z.string().max(4000).optional() }).strict();
export const inspectionSignSchema = z.object({ contactId: uuid }).strict();

export const statementSchema = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict();
export const statementListQuery = z.object({ ...page, portfolioId: uuid.optional() });

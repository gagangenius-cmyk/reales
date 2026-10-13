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
}).strict();
export const commissionListQuery = z.object({ ...page, status: z.enum(["calculated", "approved", "void"]).optional() });

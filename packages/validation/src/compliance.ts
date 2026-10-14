import { z } from "zod";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const page = { limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) };

export const kycProfileSchema = z.object({
  idType: z.string().max(40).optional(), idNumber: z.string().min(3).max(60).optional(), dateOfBirth: date.optional(), nationality: z.string().max(60).optional(),
  countryOfResidence: z.string().max(60).optional(), sourceOfFunds: z.string().max(500).optional(), occupation: z.string().max(160).optional(),
}).strict();
export const kycListQuery = z.object({ ...page, status: z.enum(["draft", "in_review", "approved", "rejected", "expired"]).optional(), riskLevel: z.enum(["low", "medium", "high", "unrated"]).optional() });
export const kycDocumentSchema = z.object({
  documentId: uuid, docType: z.enum(["passport", "emirates_id", "visa", "trade_licence", "proof_of_address", "source_of_funds", "other"]), expiresOn: date.optional(),
}).strict();
export const kycReviewSchema = z.object({ outcome: z.enum(["approved", "rejected"]), reason: z.string().min(3).max(500) }).strict();
export const identityRevealSchema = z.object({ reason: z.string().min(3).max(500) }).strict();
export const uboLinkSchema = z.object({
  parentContactId: uuid, ownerContactId: uuid, ownershipPct: z.number().gt(0).max(100), relation: z.enum(["shareholder", "director", "controller", "trustee"]).optional(),
}).strict();
export const hitDisposeSchema = z.object({ outcome: z.enum(["true_match", "false_positive"]), reason: z.string().min(10).max(1000) }).strict();

export const caseSchema = z.object({
  profileId: uuid, kind: z.enum(["screening_hit", "high_risk", "suspicious_activity", "document_issue", "other"]), summary: z.string().min(3).max(1000), assignedUserId: uuid.optional(),
}).strict();
export const caseListQuery = z.object({ ...page, status: z.enum(["open", "escalated", "closed"]).optional() });
export const caseAssignSchema = z.object({ userId: uuid }).strict();
export const caseNoteSchema = z.object({ note: z.string().min(1).max(2000) }).strict();
export const caseCloseSchema = z.object({ outcome: z.enum(["cleared", "reported", "rejected"]), resolution: z.string().min(10).max(1000) }).strict();
export const amlExportSchema = z.object({ from: z.string().datetime(), to: z.string().datetime() }).strict();

export const dsrSchema = z.object({ contactId: uuid, kind: z.enum(["access", "rectification", "erasure", "restriction"]), note: z.string().max(1000).optional() }).strict();
export const dsrListQuery = z.object({ ...page, status: z.enum(["received", "completed", "rejected"]).optional() });
export const dsrCloseSchema = z.object({ outcome: z.enum(["completed", "rejected"]), note: z.string().min(1).max(1000) }).strict();
export const legalHoldSchema = z.object({ contactId: uuid, reason: z.string().min(3).max(500) }).strict();
export const legalHoldListQuery = z.object({ contactId: uuid.optional(), activeOnly: z.enum(["true", "false"]).transform((v) => v === "true").optional() });
export const retentionPolicySchema = z.object({ entityType: z.enum(["contact_archived", "kyc_profile", "message"]), retainDays: z.number().int().min(30).max(36500), action: z.enum(["anonymise", "delete_content"]).optional() }).strict();
export const retentionRunSchema = z.object({ dryRun: z.boolean().default(true) }).strict();

import { z } from "zod";

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const channel = z.enum(["whatsapp", "sms", "email", "call"]);

export const contactSchema = z.object({
  type: z.enum(["person", "company"]).optional(),
  firstName: z.string().max(120).optional(),
  lastName: z.string().max(120).optional(),
  companyName: z.string().max(180).optional(),
  email: z.string().max(254).optional(),
  phone: z.string().max(40).optional(),
  language: z.string().min(2).max(10).optional(),
  nationality: z.string().max(60).optional(),
  organizationId: uuid.optional(),
  branchId: uuid.optional(),
  allowDuplicate: z.boolean().optional(),
  salutation: z.string().max(20).optional(), gender: z.enum(["male", "female", "other"]).optional(), dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  jobTitle: z.string().max(120).optional(), employer: z.string().max(160).optional(), phoneSecondary: z.string().max(40).optional(), whatsapp: z.string().max(40).optional(),
  addressLine: z.string().max(255).optional(), city: z.string().max(80).optional(), country: z.string().max(80).optional(), residency: z.enum(["uae_resident", "non_resident"]).optional(),
  preferredChannel: z.enum(["phone", "whatsapp", "email", "sms"]).optional(), preferredContactTime: z.string().max(60).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(), notes: z.string().max(5000).optional(),
}).strict();

const CLEARABLE = ["firstName", "lastName", "companyName", "nationality", "salutation", "gender", "dateOfBirth", "jobTitle", "employer", "addressLine", "city", "country", "residency", "preferredChannel", "preferredContactTime", "notes"] as const;
/** Like create, but a clearable field set to null is erased (omitted means unchanged). */
export const updateContactSchema = contactSchema.omit({ allowDuplicate: true, branchId: true, type: true }).extend(Object.fromEntries(CLEARABLE.map((k) => [k, contactSchema.shape[k].nullable()])) as { [K in (typeof CLEARABLE)[number]]: z.ZodNullable<(typeof contactSchema.shape)[K]> }).strict();

export const contactListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().max(100).optional(),
});

export const consentSchema = z.object({
  purposeCode: z.string().min(1).max(60),
  channel,
  granted: z.boolean(),
  basis: z.enum(["consent", "contract", "legitimate_interest", "legal_obligation"]).optional(),
  textVersion: z.string().max(60).optional(),
  text: z.string().max(5000).optional(),
  source: z.string().max(80).optional(),
  suppress: z.boolean().optional(),
}).strict();

export const suppressionSchema = z.object({
  channel,
  destination: z.string().min(3).max(254),
  reason: z.enum(["unsubscribed", "complaint", "dnd", "bounced", "manual", "legal"]),
  contactId: uuid.optional(),
}).strict();

export const liftSuppressionSchema = z.object({ reason: z.string().min(10).max(500) }).strict();

const leadProfile = {
  financing: z.enum(["cash", "mortgage", "undecided"]).optional(),
  purchaseTimeline: z.enum(["immediate", "one_to_three_months", "three_to_six_months", "over_six_months", "exploring"]).optional(),
  propertyTypes: z.array(z.string().max(30)).max(10).optional(), tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(), notes: z.string().max(5000).optional(),
  nextFollowUpAt: z.string().datetime().optional(), expectedCloseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
};
export const leadSchema = z.object({
  contactId: uuid.optional(),
  contact: contactSchema.optional(),
  projectId: uuid.optional(),
  sourceCode: z.string().max(60).optional(),
  purpose: z.enum(["buy", "rent", "invest", "off_plan"]),
  budgetMin: z.number().nonnegative().optional(),
  budgetMax: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  preferredAreas: z.array(z.string().max(80)).max(20).optional(),
  bedrooms: z.number().int().min(0).max(20).optional(),
  language: z.string().min(2).max(10).optional(),
  branchId: uuid.optional(),
  stageId: uuid.optional(),
  assignedUserId: uuid.optional(),
  isHot: z.boolean().optional(),
  campaign: z.string().trim().max(160).optional(),
  ...leadProfile,
}).strict().refine((v) => !!v.contactId !== !!v.contact, { message: "provide exactly one of contactId or contact" })
  .refine((v) => v.budgetMin === undefined || v.budgetMax === undefined || v.budgetMin <= v.budgetMax, { message: "budgetMin must not exceed budgetMax" });

export const updateLeadSchema = z.object({
  ...leadProfile, isHot: z.boolean().optional(), campaign: z.string().trim().max(160).optional(),
  budgetMin: z.number().nonnegative().optional(),
  budgetMax: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  preferredAreas: z.array(z.string().max(80)).max(20).optional(),
  bedrooms: z.number().int().min(0).max(20).optional(),
  language: z.string().min(2).max(10).optional(),
  purpose: z.enum(["buy", "rent", "invest", "off_plan"]).optional(),
}).strict();

export const leadListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(["open", "won", "lost"]).optional(),
  stageKey: z.string().max(40).optional(),
  mine: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});

export const stageSchema = z.object({ stageKey: z.string().min(1).max(40), reason: z.string().max(255).optional() }).strict();
export const assignSchema = z.object({ userId: uuid.nullable(), reason: z.string().max(255).optional() }).strict();
export const activitySchema = z.object({ kind: z.enum(["note", "call", "whatsapp", "email", "sms", "viewing"]), summary: z.string().min(1).max(4000) }).strict();
export const taskSchema = z.object({ title: z.string().min(1).max(255), leadId: uuid.optional(), assigneeId: uuid.optional(), dueAt: z.string().datetime().optional() }).strict();

export const routingRuleSchema = z.object({
  name: z.string().min(1).max(120),
  priority: z.number().int().min(0).max(10000).optional(),
  active: z.boolean().optional(),
  conditions: z.object({
    sourceKinds: z.array(z.string()).max(20).optional(), sourceCodes: z.array(z.string()).max(20).optional(),
    projectIds: z.array(uuid).max(50).optional(), languages: z.array(z.string()).max(20).optional(),
    purposes: z.array(z.enum(["buy", "rent", "invest", "off_plan"])).max(4).optional(),
    minBudget: z.number().nonnegative().optional(), maxBudget: z.number().nonnegative().optional(),
  }).strict(),
  target: z.object({ userIds: z.array(uuid).max(100).optional(), teamId: uuid.optional(), branchId: uuid.optional() }).strict(),
  strategy: z.enum(["round_robin", "least_loaded"]).optional(),
  maxOpenLeads: z.number().int().min(1).max(10000).nullable().optional(),
}).strict();

// ---- inventory
export const developerSchema = z.object({ name: z.string().min(1).max(180), registrationNo: z.string().max(80).optional(), jurisdictionCode: z.string().min(2).max(40), escrowRegistered: z.boolean().optional() }).strict();
export const reProjectSchema = z.object({
  name: z.string().min(1).max(180), jurisdictionCode: z.string().min(2).max(40), kind: z.enum(["ready", "off_plan"]),
  developerId: uuid.optional(), crmProjectId: uuid.optional(), registrationNo: z.string().max(80).optional(),
  escrowAccountRef: z.string().max(120).optional(), handoverDate: isoDate.optional(),
}).strict();
export const buildingSchema = z.object({ reProjectId: uuid, name: z.string().min(1).max(180), community: z.string().max(120).optional(), city: z.string().max(80).optional(), floorsCount: z.number().int().min(1).max(300).optional() }).strict();
export const unitSchema = z.object({
  buildingId: uuid, unitNumber: z.string().min(1).max(40), floor: z.number().int().optional(),
  type: z.enum(["apartment", "villa", "townhouse", "penthouse", "office", "retail", "land", "duplex", "hotel_apartment", "studio", "compound", "full_floor", "half_floor", "whole_building", "bulk_units", "warehouse", "showroom", "labour_camp", "factory", "farm", "staff_accommodation"]),
  bedrooms: z.number().int().min(0).max(20).optional(), bathrooms: z.number().int().min(0).max(20).optional(),
  areaSqft: z.number().positive().optional(), view: z.string().max(80).optional(), listPrice: z.number().positive().optional(),
  currency: z.string().length(3).optional(), ownerContactId: uuid.optional(),
}).strict();
export const unitStatusSchema = z.object({ status: z.enum(["available", "reserved", "sold", "rented", "blocked"]), reason: z.string().max(255).optional() }).strict();
export const unitListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(["available", "reserved", "sold", "rented", "blocked"]).optional(),
  type: z.enum(["apartment", "villa", "townhouse", "penthouse", "office", "retail", "land", "duplex", "hotel_apartment", "studio", "compound", "full_floor", "half_floor", "whole_building", "bulk_units", "warehouse", "showroom", "labour_camp", "factory", "farm", "staff_accommodation"]).optional(),
  bedrooms: z.coerce.number().int().min(0).optional(), minPrice: z.coerce.number().nonnegative().optional(), maxPrice: z.coerce.number().nonnegative().optional(),
  buildingId: uuid.optional(), reProjectId: uuid.optional(),
});

// ---- listings and compliance
export const createListingSchema = z.object({
  unitId: uuid, purpose: z.enum(["sale", "rent"]), title: z.string().max(255).optional(), description: z.string().max(10000).optional(),
  price: z.number().positive().optional(), currency: z.string().length(3).optional(), agentUserId: uuid.optional(),
  brokerLicenceId: uuid.optional(), branchId: uuid.optional(), projectId: uuid.optional(),
}).strict();
export const updateListingSchema = z.object({
  title: z.string().max(255).optional(), description: z.string().max(10000).optional(), price: z.number().positive().optional(),
  brokerLicenceId: uuid.optional(), agentUserId: uuid.optional(),
}).strict();
export const listingListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(["draft", "published", "unpublished", "expired", "closed", "archived"]).optional(),
  purpose: z.enum(["sale", "rent"]).optional(), q: z.string().max(100).optional(),
});
export const mediaSchema = z.object({ kind: z.enum(["image", "video", "floorplan"]), storageKey: z.string().min(1).max(500), position: z.number().int().min(0).optional() }).strict();
export const permitSchema = z.object({ permitNo: z.string().min(1).max(80), authority: z.string().min(1).max(60), issuedAt: isoDate.optional(), expiresAt: isoDate }).strict();
export const verifyPermitSchema = z.object({ outcome: z.enum(["valid", "rejected", "revoked"]) }).strict();
export const licenceSchema = z.object({
  holderType: z.enum(["company", "agent"]), holderName: z.string().min(1).max(180), userId: uuid.optional(),
  licenceNo: z.string().min(1).max(80), authority: z.string().min(1).max(60), issuedAt: isoDate.optional(), expiresAt: isoDate,
}).strict();
export const verifyLicenceSchema = z.object({ outcome: z.enum(["valid", "revoked"]) }).strict();
export const portalAccountSchema = z.object({ provider: z.string().min(1).max(40), name: z.string().min(1).max(120), mode: z.enum(["export", "api"]).optional(), config: z.record(z.unknown()).optional() }).strict();
export const unpublishSchema = z.object({ reason: z.string().max(255).optional() }).strict();

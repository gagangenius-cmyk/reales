import { z } from "zod";

const uuid = z.string().uuid();
const page = { limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) };

export const notificationQuery = z.object({ unreadOnly: z.enum(["true", "false"]).transform((v) => v === "true").optional(), limit: z.coerce.number().int().min(1).max(200).optional() });
export const matchStatusSchema = z.object({ status: z.enum(["shared", "dismissed"]) }).strict();
export const criteriaSchema = z.object({
  purpose: z.enum(["sale", "rent"]).optional(), minPrice: z.number().nonnegative().optional(), maxPrice: z.number().nonnegative().optional(), bedrooms: z.number().int().min(0).max(20).optional(),
  communities: z.array(z.string().min(1).max(80)).max(10).optional(), types: z.array(z.enum(["apartment", "villa", "townhouse", "penthouse", "office", "retail", "land", "duplex", "hotel_apartment", "studio", "compound", "full_floor", "half_floor", "whole_building", "bulk_units", "warehouse", "showroom", "labour_camp", "factory", "farm", "staff_accommodation"])).max(21).optional(),
}).strict();
export const savedSearchSchema = z.object({ name: z.string().min(1).max(160), criteria: criteriaSchema, contactId: uuid.optional(), leadId: uuid.optional(), notify: z.boolean().optional() }).strict();
export const searchStatusSchema = z.object({ status: z.enum(["active", "paused"]) }).strict();
export const partnerSchema = z.object({ name: z.string().min(1).max(160), kind: z.enum(["broker", "developer", "bank", "corporate", "individual"]), feePct: z.number().min(0).max(100), contactId: uuid.optional() }).strict();
export const partnerStatusSchema = z.object({ status: z.enum(["active", "inactive"]) }).strict();
export const referralSchema = z.object({ partnerId: uuid, leadId: uuid, note: z.string().max(500).optional() }).strict();
export const referralListQuery = z.object({ ...page, status: z.enum(["submitted", "won", "paid", "void"]).optional(), partnerId: uuid.optional() });
export const referralVoidSchema = z.object({ reason: z.string().min(3).max(500) }).strict();

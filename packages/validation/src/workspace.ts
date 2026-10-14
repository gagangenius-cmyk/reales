import { z } from "zod";

const uuid = z.string().uuid();
export const calendarQuery = z.object({ from: z.string().min(8).max(40), to: z.string().min(8).max(40) });
export const taskListQuery = z.object({
  scope: z.enum(["mine", "all"]).optional(), status: z.enum(["open", "done"]).optional(), overdueOnly: z.enum(["true", "false"]).transform((v) => v === "true").optional(), limit: z.coerce.number().int().min(1).max(500).optional(),
});
export const rescheduleSchema = z.object({ dueAt: z.string().datetime().nullable() }).strict();
export const generateDocSchema = z.object({ kind: z.enum(["receipt", "lease_contract", "owner_statement", "offer_letter"]), id: uuid }).strict();
export const portalInviteSchema = z.object({ contactId: uuid, kind: z.enum(["owner", "tenant"]), email: z.string().email().max(254).optional() }).strict();
export const portalRequestSchema = z.object({
  leaseId: uuid, category: z.enum(["plumbing", "electrical", "hvac", "appliance", "structural", "cleaning", "pest", "other"]), title: z.string().min(3).max(255), description: z.string().max(4000).optional(),
}).strict();

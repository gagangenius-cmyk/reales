import { z } from "zod";

const uuid = z.string().uuid();
const text = (n: number) => z.string().trim().max(n);

// ---- API keys and outbound webhooks
export const apiKeySchema = z.object({ name: text(120).min(1), scopes: z.array(text(80)).min(1).max(200), expiresInDays: z.number().int().min(1).max(365).optional() }).strict();
export const webhookEndpointSchema = z.object({ id: uuid.optional(), name: text(120).min(1), url: text(500).min(8), eventTypes: z.array(text(80)).min(1).max(50), active: z.boolean().optional() }).strict();
export const webhookDeliveriesQuery = z.object({ status: z.enum(["pending", "delivered", "failed"]).optional() });

// ---- photoshoots and saved views
const optText = (n: number) => z.string().trim().max(n).nullable().optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const photoshootRequestSchema = z.object({
  listingId: uuid, shootTypes: z.array(z.enum(["photos", "video", "drone", "floorplan", "virtual_tour"])).min(1).max(5), preferredDate: isoDate.nullable().optional(),
  accessContactName: optText(120), accessContactPhone: optText(40), accessNotes: optText(500), notes: optText(1000),
}).strict();
export const photoshootActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("schedule"), scheduledAt: z.string().datetime(), durationMinutes: z.number().int().min(15).max(480).optional(), photographerUserId: uuid.nullable().optional(), photographerName: optText(120) }).strict(),
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("deliver"), mediaCount: z.number().int().min(1).max(500), note: optText(500) }).strict(),
  z.object({ action: z.literal("cancel"), reason: z.string().trim().min(1).max(255) }).strict(),
]);
export const photoshootListQuery = z.object({ status: z.enum(["requested", "scheduled", "in_progress", "delivered", "cancelled"]).optional(), listingId: uuid.optional(), mine: z.enum(["true", "false"]).optional() });
export const savedViewSchema = z.object({
  id: uuid.optional(), entity: z.enum(["leads", "listings", "contacts", "deals"]), name: text(80).min(1), filters: z.record(z.string().max(200)), columns: z.array(text(60)).max(40).nullable().optional(),
  shared: z.boolean().optional(), isDefault: z.boolean().optional(),
}).strict();
export const savedViewQuery = z.object({ entity: z.enum(["leads", "listings", "contacts", "deals"]) });

// ---- commission claims
export const claimCreateSchema = z.object({ title: text(160).optional(), calculationIds: z.array(uuid).min(1).max(200), notes: text(500).optional() }).strict();
export const claimListQuery = z.object({ status: z.enum(["draft", "submitted", "verified", "approved", "scheduled", "released", "rejected", "cancelled", "reversed"]).optional() });
export const claimActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit") }).strict(),
  z.object({ action: z.literal("verify") }).strict(),
  z.object({ action: z.literal("approve") }).strict(),
  z.object({ action: z.literal("schedule"), date: isoDateOnly() }).strict(),
  z.object({ action: z.literal("release"), reference: text(120).min(1) }).strict(),
  z.object({ action: z.literal("reverse"), reason: text(255).min(1) }).strict(),
  z.object({ action: z.literal("reject"), reason: text(255).min(1) }).strict(),
  z.object({ action: z.literal("cancel"), reason: text(255).min(1) }).strict(),
  z.object({ action: z.literal("add_items"), calculationIds: z.array(uuid).min(1).max(200) }).strict(),
  z.object({ action: z.literal("remove_item"), itemId: uuid }).strict(),
  z.object({ action: z.literal("verify_item"), itemId: uuid, outcome: z.enum(["verified", "flagged"]), note: text(255).optional() }).strict(),
  z.object({ action: z.literal("evidence"), kind: z.enum(["bank_statement", "invoice", "contract", "email", "other"]), description: text(300).min(1), documentId: uuid.nullable().optional(), itemId: uuid.nullable().optional() }).strict(),
]);
function isoDateOnly() { return z.string().regex(/^\d{4}-\d{2}-\d{2}$/); }

// ---- Google Workspace
export const googleSettingsSchema = z.object({ syncCalendar: z.boolean().optional(), syncGmail: z.boolean().optional() }).strict();
export const googleCallbackQuery = z.object({ code: z.string().min(10).max(2000).optional(), state: z.string().min(10).max(2000).optional(), error: z.string().max(200).optional() });
export const googleEmailsQuery = z.object({ contactId: uuid });

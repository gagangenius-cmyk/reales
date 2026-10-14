import { z } from "zod";

const uuid = z.string().uuid();
const channel = z.enum(["whatsapp", "sms", "email"]);
const node = z.object({ id: z.string().min(1).max(80), type: z.string().min(1).max(80), config: z.record(z.unknown()).optional(), position: z.object({ x: z.number(), y: z.number() }).optional() }).passthrough();
const edge = z.object({ id: z.string().max(120).optional(), source: z.string().max(80), target: z.string().max(80), sourceHandle: z.string().max(40).nullable().optional() }).passthrough();
export const botGraphSchema = z.object({ nodes: z.array(node).max(60), edges: z.array(edge).max(200) }).passthrough();

export const botSchema = z.object({ name: z.string().min(1).max(160), channel, graph: botGraphSchema.optional() }).strict();
export const botDraftSchema = z.object({ graph: botGraphSchema }).strict();
export const botStatusSchema = z.object({ status: z.enum(["published", "disabled"]) }).strict();
export const botStartSchema = z.object({ botId: uuid, contactId: uuid, conversationId: uuid.optional(), leadId: uuid.optional() }).strict();
export const botMessageSchema = z.object({ text: z.string().min(1).max(1000) }).strict();
export const modelActivateSchema = z.object({ acknowledgeWeak: z.boolean().optional() }).strict();
export const dashboardKindSchema = z.enum(["sales", "manager", "property", "compliance"]);
export const exportQuery = z.object({
  entity: z.enum(["leads", "deals", "invoices", "leases", "tickets", "lead_scores"]), after: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(5000).optional(),
});

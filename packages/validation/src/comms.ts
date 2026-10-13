import { z } from "zod";

const uuid = z.string().uuid();
const channel = z.enum(["email", "whatsapp", "sms"]);
const page = { limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) };

const components = z.object({
  header: z.object({ type: z.literal("text"), text: z.string().max(200) }).strict().optional(),
  body: z.object({ text: z.string().max(4000) }).strict(),
  footer: z.object({ text: z.string().max(200) }).strict().optional(),
  buttons: z.array(z.object({ type: z.enum(["quick_reply", "url"]), text: z.string().max(100), url: z.string().max(500).optional() }).strict()).max(10).optional(),
}).strict();

const versionBody = {
  subject: z.string().max(255).optional(), designJson: z.unknown().optional(), html: z.string().max(500_000).optional(),
  text: z.string().max(10_000).optional(), components: components.optional(),
};
export const createTemplateSchema = z.object({ name: z.string().min(1).max(160), channel, purpose: z.string().max(60).optional(), projectId: uuid.optional(), ...versionBody }).strict();
export const templateVersionSchema = z.object(versionBody).strict();
export const approveTemplateSchema = z.object({ outcome: z.enum(["approved", "rejected"]) }).strict();
export const templatePreviewSchema = z.object({ values: z.record(z.record(z.union([z.string(), z.number()]))).default({}) }).strict();
export const templateListQuery = z.object({ channel: channel.optional(), status: z.enum(["draft", "approved", "archived"]).optional() });

export const channelAccountSchema = z.object({ channel, provider: z.string().min(1).max(40), name: z.string().min(1).max(120), identity: z.string().min(3).max(254), config: z.record(z.unknown()).optional() }).strict();

export const sendMessageSchema = z.object({
  contactId: uuid, channel, purposeCode: z.string().min(1).max(60), channelAccountId: uuid.optional(),
  body: z.string().min(1).max(4000).optional(), subject: z.string().max(255).optional(), templateVersionId: uuid.optional(),
  values: z.record(z.record(z.union([z.string(), z.number(), z.null()]))).optional(),
}).strict().refine((v) => !!v.body !== !!v.templateVersionId, { message: "provide exactly one of body or templateVersionId" });
export const conversationListQuery = z.object({ ...page, status: z.enum(["open", "closed"]).optional(), unreadOnly: z.enum(["true", "false"]).transform((v) => v === "true").optional() });

const segmentDef = z.object({
  language: z.array(z.string().max(10)).max(20).optional(), nationality: z.array(z.string().max(60)).max(50).optional(), branchId: uuid.optional(), ownerUserId: uuid.optional(),
  hasOpenLead: z.boolean().optional(), leadPurpose: z.array(z.enum(["buy", "rent", "invest", "off_plan"])).max(4).optional(), leadProjectIds: z.array(uuid).max(50).optional(),
  budgetMin: z.number().nonnegative().optional(), budgetMax: z.number().nonnegative().optional(), createdAfter: z.string().datetime().optional(), createdBefore: z.string().datetime().optional(),
}).strict();
export const segmentSchema = z.object({ name: z.string().min(1).max(160), definition: segmentDef }).strict();
export const segmentPreviewSchema = z.object({ definition: segmentDef }).strict();

export const campaignSchema = z.object({
  name: z.string().min(1).max(160), channel, templateVersionId: uuid, segmentId: uuid, channelAccountId: uuid, purposeCode: z.string().min(1).max(60),
  maxPerMinute: z.number().int().min(1).max(6000).optional(), scheduledAt: z.string().datetime().optional(),
}).strict();
export const scheduleCampaignSchema = z.object({ at: z.string().datetime().optional() }).strict();

const node = z.object({ id: z.string().min(1).max(80), type: z.string().min(1).max(80), config: z.record(z.unknown()).optional(), position: z.object({ x: z.number(), y: z.number() }).optional() }).passthrough();
const edge = z.object({ id: z.string().max(120).optional(), source: z.string().max(80), target: z.string().max(80), sourceHandle: z.string().max(40).nullable().optional() }).passthrough();
export const graphSchema = z.object({ nodes: z.array(node).max(200), edges: z.array(edge).max(400) }).passthrough();
export const createWorkflowSchema = z.object({ name: z.string().min(1).max(160), projectId: uuid.optional(), graph: graphSchema.optional() }).strict();
export const draftSchema = z.object({ graph: graphSchema }).strict();
export const workflowStatusSchema = z.object({ status: z.enum(["published", "disabled"]) }).strict();

import { z } from "zod";

const uuid = z.string().uuid();
const https = z.string().url().max(500).startsWith("https://");

export const ssoBeginSchema = z.object({ tenant: z.string().min(2).max(100).regex(/^[a-z0-9-]+$/), email: z.string().email().max(254) }).strict();
export const ssoCallbackQuery = z.object({ code: z.string().min(1).max(2000), state: z.string().min(10).max(200) });
export const ssoConnectionSchema = z.object({
  name: z.string().min(1).max(120), issuer: https, clientId: z.string().min(1).max(255), clientSecret: z.string().max(500).optional(), authorizationEndpoint: https, tokenEndpoint: https, jwksUri: https,
  emailDomains: z.array(z.string().min(3).max(120)).min(1).max(20), jitEnabled: z.boolean().optional(), jitRoleKey: z.string().max(60).optional(), trustIdpMfa: z.boolean().optional(), enforce: z.boolean().optional(),
}).strict();
export const ssoStatusSchema = z.object({ status: z.enum(["active", "disabled"]) }).strict();

export const policySchema = z.object({ allowedRegions: z.array(z.string().min(2).max(32)).min(1).max(20), allowCrossBorder: z.boolean().optional(), requireRegisteredProviders: z.boolean().optional() }).strict();
export const subprocessorSchema = z.object({
  code: z.string().regex(/^[a-z0-9_-]{2,60}$/), name: z.string().min(1).max(160), purpose: z.string().min(1).max(255), region: z.string().min(2).max(32),
  status: z.enum(["approved", "pending", "blocked"]), dpaSignedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();
export const quotaSchema = z.object({ meter: z.string().regex(/^[a-z_]{2,40}$/), limit: z.number().int().min(0).nullable() }).strict();

export const deviceSchema = z.object({ deviceId: z.string().min(8).max(80), name: z.string().max(120).optional(), platform: z.enum(["ios", "android", "web"]) }).strict();
export const mobileSyncSchema = z.object({
  deviceId: z.string().min(8).max(80),
  mutations: z.array(z.object({
    clientMutationId: z.string().min(1).max(80), kind: z.literal("inspection.sync"),
    payload: z.object({
      inspectionId: uuid,
      mutations: z.array(z.object({
        clientMutationId: z.string().min(1).max(80), baseVersion: z.number().int().min(0),
        changes: z.array(z.object({ itemId: uuid, condition: z.enum(["good", "fair", "poor", "damaged", "na"]).optional(), notes: z.string().max(1000).nullable().optional(), meterReading: z.number().nullable().optional() }).strict()).max(200),
        addMediaDocumentIds: z.array(z.object({ itemId: uuid.optional(), documentId: uuid }).strict()).max(50).optional(),
      }).strict()).max(200),
    }).strict(),
  }).strict()).max(100),
}).strict();

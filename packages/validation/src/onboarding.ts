import { z } from "zod";

const uuid = z.string().uuid();
export const forgotSchema = z.object({ tenant: z.string().min(2).max(100).regex(/^[a-z0-9-]+$/), email: z.string().email().max(254) }).strict();
export const resetSchema = z.object({ token: z.string().min(20).max(200), password: z.string().min(1).max(200) }).strict();
export const inviteSchema = z.object({
  email: z.string().email().max(254), firstName: z.string().max(120).optional(), lastName: z.string().max(120).optional(), roleKeys: z.array(z.string().min(1).max(60)).min(1).max(5),
  businessUnitId: uuid.optional(), branchId: uuid.optional(),
}).strict();
export const importSchema = z.object({ kind: z.enum(["contacts", "leads", "units"]), filename: z.string().min(1).max(255), csv: z.string().min(1).max(2_200_000), onDuplicate: z.enum(["skip", "error"]).optional() }).strict();
export const templateQuery = z.object({ kind: z.enum(["contacts", "leads", "units"]) });

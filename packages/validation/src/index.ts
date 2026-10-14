import { z } from "zod";

export { z };

const uuid = z.string().uuid();

export const loginSchema = z.object({
  tenant: z.string().min(2).max(100).regex(/^[a-z0-9-]+$/),
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

export const mfaCodeSchema = z.object({ code: z.string().min(6).max(13) });

export const createUserSchema = z.object({
  email: z.string().email().max(254),
  firstName: z.string().max(120).optional(),
  lastName: z.string().max(120).optional(),
  phoneE164: z.string().regex(/^\+[1-9]\d{6,14}$/).optional(),
  password: z.string().min(12).max(200).optional(),
  roleKeys: z.array(z.string().min(1).max(60)).min(1).max(10),
  businessUnitId: uuid.optional(),
  branchId: uuid.optional(),
});

export const updateUserSchema = z.object({
  status: z.enum(["active", "disabled"]).optional(),
  businessUnitId: uuid.nullable().optional(),
  branchId: uuid.nullable().optional(),
  firstName: z.string().max(120).optional(),
  lastName: z.string().max(120).optional(),
}).strict();

export const assignRoleSchema = z.object({
  roleKey: z.string().min(1).max(60),
  anchorType: z.enum(["business_unit", "branch", "project", "portfolio"]).optional(),
  anchorId: uuid.optional(),
}).refine((v) => !!v.anchorType === !!v.anchorId, { message: "anchorType and anchorId go together" });

export const createBusinessUnitSchema = z.object({ name: z.string().min(1).max(180), type: z.enum(["brokerage", "property_management", "developer"]) });
export const createBranchSchema = z.object({ businessUnitId: uuid, name: z.string().min(1).max(180), city: z.string().max(80).optional() });
export const createTeamSchema = z.object({ branchId: uuid.optional(), name: z.string().min(1).max(180) });
export const createProjectSchema = z.object({
  code: z.string().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(180),
  kind: z.enum(["project", "portfolio", "workspace"]).default("project"),
  businessUnitId: uuid.optional(),
});
export const updateProjectSchema = z.object({ name: z.string().min(1).max(180).optional(), status: z.enum(["active", "archived"]).optional() }).strict();

export const settingSchema = z.object({ value: z.unknown() });
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export * from "./crm";
export * from "./transactions";
export * from "./comms";
export * from "./pm";
export * from "./compliance";
export * from "./intel";
export * from "./hardening";
export * from "./extras";
export * from "./onboarding";
export * from "./workspace";

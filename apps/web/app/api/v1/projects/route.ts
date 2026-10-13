import { createProject, listProjects } from "@reales/domain";
import { createProjectSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ projects: await listProjects(sq, ctx) }));
export const POST = api({ body: createProjectSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createProject(sq, ctx, body) }));

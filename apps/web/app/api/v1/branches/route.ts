import { createBranch } from "@reales/domain";
import { createBranchSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: createBranchSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createBranch(sq, ctx, body) }));

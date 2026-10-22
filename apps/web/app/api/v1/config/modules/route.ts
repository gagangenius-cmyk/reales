import { setModules } from "@reales/domain";
import { configModulesSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const PUT = api({ body: configModulesSchema, idempotent: true }, async ({ ctx, sq, body }) => setModules(sq, ctx, body.modules));

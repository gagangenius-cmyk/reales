import { addSuppression } from "@reales/domain";
import { suppressionSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: suppressionSchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await addSuppression(sq, ctx, body) }));

import { runRetention } from "@reales/domain";
import { retentionRunSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: retentionRunSchema }, async ({ ctx, sq, body }) => runRetention(sq, ctx, body));

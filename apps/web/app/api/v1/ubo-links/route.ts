import { linkUbo } from "@reales/domain";
import { uboLinkSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: uboLinkSchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await linkUbo(sq, ctx, body) }));

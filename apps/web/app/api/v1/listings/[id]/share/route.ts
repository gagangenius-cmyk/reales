import { setListingShare } from "@reales/domain";
import { shareSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api<{ id: string }, typeof shareSchema>({ body: shareSchema }, async ({ ctx, sq, params, body }) => setListingShare(sq, ctx, z.string().uuid().parse(params.id), body));

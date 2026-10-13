import { cancelViewing } from "@reales/domain";
import { reasonSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof reasonSchema>({ body: reasonSchema }, async ({ ctx, sq, body, params }) => cancelViewing(sq, ctx, uuid.parse(params.id), body.reason));

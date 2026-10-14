import { closeDsr } from "@reales/domain";
import { dsrCloseSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof dsrCloseSchema>({ body: dsrCloseSchema }, async ({ ctx, sq, params, body }) => closeDsr(sq, ctx, uuid.parse(params.id), body));

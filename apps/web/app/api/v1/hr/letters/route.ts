import { createLetter, listLetters } from "@reales/domain";
import { letterCreateSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq, req }) => listLetters(sq, ctx, { employeeId: req.nextUrl.searchParams.get("employeeId") ?? undefined }));
export const POST = api({ body: letterCreateSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createLetter(sq, ctx, body) }));

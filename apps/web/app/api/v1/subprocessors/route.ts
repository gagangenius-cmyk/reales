import { listSubprocessors, upsertSubprocessor } from "@reales/domain";
import { subprocessorSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ subprocessors: await listSubprocessors(sq, ctx) }));
export const PUT = api({ body: subprocessorSchema }, async ({ ctx, sq, body }) => upsertSubprocessor(sq, ctx, body));

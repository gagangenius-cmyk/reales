import { listImports, validateImport } from "@reales/domain";
import { importSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ imports: await listImports(sq, ctx) }));
export const POST = api({ body: importSchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await validateImport(sq, ctx, body) }));

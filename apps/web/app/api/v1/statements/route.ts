import { listOwnerStatements } from "@reales/domain";
import { statementListQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: statementListQuery }, async ({ ctx, sq, query }) => ({ statements: await listOwnerStatements(sq, ctx, query) }));

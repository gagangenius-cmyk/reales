import { listAllDocuments } from "@reales/domain";
import { libraryQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: libraryQuery }, async ({ ctx, sq, query }) => ({ documents: await listAllDocuments(sq, ctx, query) }));

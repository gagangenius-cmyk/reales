import { globalSearch } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

const query = z.object({ q: z.string().max(80).default("") });

export const GET = api({ query }, async ({ ctx, sq, query: { q } }) => ({ hits: await globalSearch(sq, ctx, q) }));

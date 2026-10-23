import { clearRoster, listRoster, setRoster } from "@reales/domain";
import { rosterClearSchema, rosterQuery, rosterSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: rosterQuery }, async ({ ctx, sq, query }) => listRoster(sq, ctx, query.from, query.to, query.mine === "1"));
export const POST = api({ body: rosterSchema, idempotent: true }, async ({ ctx, sq, body }) => setRoster(sq, ctx, body));
export const DELETE = api({ body: rosterClearSchema }, async ({ ctx, sq, body }) => clearRoster(sq, ctx, body));

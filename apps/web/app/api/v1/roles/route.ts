import { listRoles } from "@reales/domain";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ roles: await listRoles(sq, ctx) }));

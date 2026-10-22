import { listPayable } from "@reales/domain";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ payable: await listPayable(sq, ctx) }));

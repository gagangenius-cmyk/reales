import { myPayslips } from "@reales/domain";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => myPayslips(sq, ctx));

import { listPipelines } from "@reales/domain";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ pipelines: await listPipelines(sq, ctx) }));

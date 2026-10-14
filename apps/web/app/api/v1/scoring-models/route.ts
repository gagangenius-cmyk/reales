import { listScoringModels, trainScoringModel } from "@reales/domain";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ models: await listScoringModels(sq, ctx) }));
export const POST = api({}, async ({ ctx, sq }) => ({ status: 201, data: await trainScoringModel(sq, ctx) }));

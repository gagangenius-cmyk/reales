import { listRuns } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => ({ runs: await listRuns(sq, ctx, uuid.parse(params.id)) }));

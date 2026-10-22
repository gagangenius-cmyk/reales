import { rotatePortalFeedToken } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api<{ id: string }>({}, async ({ ctx, sq, params }) => rotatePortalFeedToken(sq, ctx, z.string().uuid().parse(params.id)));

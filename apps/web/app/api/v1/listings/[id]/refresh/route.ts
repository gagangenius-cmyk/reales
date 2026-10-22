import { refreshListing } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api<{ id: string }>({}, async ({ ctx, sq, params }) => refreshListing(sq, ctx, z.string().uuid().parse(params.id)));

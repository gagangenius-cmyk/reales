import { commitImport } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api<{ id: string }>({}, async ({ ctx, sq, params }) => commitImport(sq, ctx, z.string().uuid().parse(params.id)));

import { listMyDevices, registerDevice } from "@reales/domain";
import { deviceSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ devices: await listMyDevices(sq, ctx) }));
export const POST = api({ body: deviceSchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await registerDevice(sq, ctx, body) }));

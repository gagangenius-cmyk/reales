import { createVendor, listVendors } from "@reales/domain";
import { vendorSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq }) => ({ vendors: await listVendors(sq, ctx) }));
export const POST = api({ body: vendorSchema }, async ({ ctx, sq, body }) => ({ status: 201, data: await createVendor(sq, ctx, body) }));

import { createLease, listLeases } from "@reales/domain";
import { leaseSchema, leaseListQuery } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: leaseListQuery }, async ({ ctx, sq, query }) => ({ leases: await listLeases(sq, ctx, query) }));
export const POST = api({ body: leaseSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: 201, data: await createLease(sq, ctx, body) }));

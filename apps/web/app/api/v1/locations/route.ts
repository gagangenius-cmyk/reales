import { EMIRATES, listLocations, PROPERTY_TYPES, saveLocation } from "@reales/domain";
import { locationQuery, locationSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: locationQuery }, async ({ ctx, sq, query }) => ({ emirates: EMIRATES, propertyTypes: PROPERTY_TYPES, locations: await listLocations(sq, ctx, { emirate: query.emirate, q: query.q, all: query.all === "1" }) }));
export const POST = api({ body: locationSchema, idempotent: true }, async ({ ctx, sq, body }) => saveLocation(sq, ctx, body));

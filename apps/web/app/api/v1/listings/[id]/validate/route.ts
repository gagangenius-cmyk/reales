import { validateListing } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

/** Dry-run of the publication gate: tells the user exactly what is missing. */
export const POST = api<{ id: string }>({}, async ({ ctx, sq, params }) => validateListing(sq, ctx, uuid.parse(params.id)));

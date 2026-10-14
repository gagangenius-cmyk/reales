import { getKycProfileByContact, upsertKycProfile } from "@reales/domain";
import { kycProfileSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => ({ profile: await getKycProfileByContact(sq, ctx, uuid.parse(params.id)) }));
export const PUT = api<{ id: string }, typeof kycProfileSchema>({ body: kycProfileSchema }, async ({ ctx, sq, params, body }) => upsertKycProfile(sq, ctx, uuid.parse(params.id), body));

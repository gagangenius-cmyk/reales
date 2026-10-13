import { unpublishListing } from "@reales/domain";
import { unpublishSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

export const POST = api<{ id: string }, typeof unpublishSchema>({ body: unpublishSchema }, async ({ ctx, sq, body, params }) =>
  unpublishListing(sq, ctx, uuid.parse(params.id), body.reason ?? "manual"),
);

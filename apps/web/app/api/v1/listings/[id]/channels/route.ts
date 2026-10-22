import { getListingChannels, setListingChannel } from "@reales/domain";
import { channelSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const id = z.string().uuid();

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => ({ channels: await getListingChannels(sq, ctx, id.parse(params.id)) }));
export const PUT = api<{ id: string }, typeof channelSchema>({ body: channelSchema }, async ({ ctx, sq, params, body }) => {
  await setListingChannel(sq, ctx, id.parse(params.id), body.portalAccountId, body.enabled);
  return { ok: true };
});

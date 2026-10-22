import { archiveNotice, markNotice, noticeReceipts } from "@reales/domain";
import { noticeMarkSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const id = z.string().uuid();

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => noticeReceipts(sq, ctx, id.parse(params.id)));
export const POST = api<{ id: string }, typeof noticeMarkSchema>({ body: noticeMarkSchema }, async ({ ctx, sq, params, body }) => {
  await markNotice(sq, ctx, id.parse(params.id), !!body.ack);
  return { ok: true };
});
export const DELETE = api<{ id: string }>({}, async ({ ctx, sq, params }) => {
  await archiveNotice(sq, ctx, id.parse(params.id), true);
  return { ok: true };
});

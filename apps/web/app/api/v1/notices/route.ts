import { listAllNotices, listNoticesForMe, saveNotice } from "@reales/domain";
import { noticeSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({ query: z.object({ all: z.enum(["true", "false"]).optional() }) }, async ({ ctx, sq, query }) => ({ notices: query.all === "true" ? await listAllNotices(sq, ctx) : await listNoticesForMe(sq, ctx) }));
export const POST = api({ body: noticeSchema, idempotent: true }, async ({ ctx, sq, body }) => ({ status: body.id ? 200 : 201, data: await saveNotice(sq, ctx, body) }));

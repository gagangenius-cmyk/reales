import { listAnnouncements, saveAnnouncement } from "@reales/domain";
import { announcementSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api({}, async ({ ctx, sq, req }) => listAnnouncements(sq, ctx, req.nextUrl.searchParams.get("all") === "1"));
export const POST = api({ body: announcementSchema, idempotent: true }, async ({ ctx, sq, body }) => saveAnnouncement(sq, ctx, body));

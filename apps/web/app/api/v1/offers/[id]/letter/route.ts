import { offerLetterPdf } from "@reales/domain";
import { z } from "@reales/validation";
import { api } from "@/lib/api";

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => {
  const bytes = await offerLetterPdf(sq, ctx, z.string().uuid().parse(params.id));
  return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/pdf", "content-disposition": "inline; filename=\"document.pdf\"", "x-content-type-options": "nosniff", "cache-control": "private, no-store" } });
});

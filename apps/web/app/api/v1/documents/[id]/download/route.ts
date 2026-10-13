import { downloadDocument } from "@reales/domain";
import { downloadQuery, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

/** Always an attachment with a fixed, sniffed content type and nosniff: an uploaded file can never execute in our origin. */
export const GET = api<{ id: string }, undefined, typeof downloadQuery>({ query: downloadQuery }, async ({ ctx, sq, params, query }) => {
  const d = await downloadDocument(sq, ctx, uuid.parse(params.id), query.version);
  return new Response(new Uint8Array(d.bytes), {
    headers: {
      "content-type": d.mime,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(d.filename)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "no-store",
      "x-document-hash": d.contentHash,
    },
  });
});

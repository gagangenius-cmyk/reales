import { NextResponse } from "next/server";
import { createDocument, listDocumentsFor, MAX_UPLOAD_BYTES } from "@reales/domain";
import { documentKind, documentListQuery, linkSchema, z } from "@reales/validation";
import { api } from "@/lib/api";
import { readUpload } from "@/lib/uploads";

export const GET = api({ query: documentListQuery }, async ({ ctx, sq, query }) => ({ documents: await listDocumentsFor(sq, ctx, query) }));

/** multipart/form-data: title, kind, optional entityType+entityId, and the file. */
export const POST = api({}, async ({ req, ctx, sq }) => {
  const { form, file } = await readUpload(req, MAX_UPLOAD_BYTES);
  const title = String(form.get("title") ?? "").trim();
  if (!title || title.length > 255) return NextResponse.json({ error: { code: "validation_error", message: "title is required (max 255 characters)" } }, { status: 400 });
  const kind = documentKind.parse(String(form.get("kind") ?? "other"));
  const links = form.get("entityType") ? [linkSchema.parse({ entityType: form.get("entityType"), entityId: form.get("entityId") })] : [];
  const folderId = typeof form.get("folderId") === "string" && String(form.get("folderId")) ? z.string().uuid().parse(String(form.get("folderId"))) : null;
  return { status: 201, data: await createDocument(sq, ctx, { title, kind, links, file, folderId }) };
});

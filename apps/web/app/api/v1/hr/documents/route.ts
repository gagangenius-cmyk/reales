import { listHrDocuments, uploadHrDocument } from "@reales/domain";
import { docListQuery } from "@reales/validation";
import { readUpload } from "@/lib/uploads";
import { api } from "@/lib/api";

export const GET = api({ query: docListQuery }, async ({ ctx, sq, query }) => listHrDocuments(sq, ctx, query));
export const POST = api({}, async ({ req, ctx, sq }) => {
  const { form, file } = await readUpload(req, 15 * 1024 * 1024);
  const s = (k: string) => (typeof form.get(k) === "string" ? String(form.get(k)) : undefined);
  const vis = s("visibility");
  return { status: 201, data: await uploadHrDocument(sq, ctx, file, { employeeId: s("employeeId") || null, title: s("title") ?? file.filename, category: s("category") ?? "other", expiresOn: s("expiresOn") || null, visibility: vis === "hr_only" || vis === "company" || vis === "employee" ? vis : undefined }) };
});

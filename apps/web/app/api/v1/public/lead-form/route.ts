import { submitPublicLeadForm } from "@reales/domain";
import { publicLeadFormSchema } from "@reales/validation";
import { api } from "@/lib/api";

/** Public: the hosted lead-capture form (landing page or QR code). No session; per-IP rate limit; a hidden `website` field catches bots. */
export const POST = api({ auth: "none", body: publicLeadFormSchema, limit: { limit: 8, windowSec: 600, key: "lead-form" } }, async ({ sq, body }) => {
  const { publicId, ...rest } = body;
  return submitPublicLeadForm(sq, publicId, rest);
});

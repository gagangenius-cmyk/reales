import { submitListingEnquiry } from "@reales/domain";
import { publicEnquirySchema } from "@reales/validation";
import { api } from "@/lib/api";

/** Public: a visitor enquiry from a listing page. No session; per-IP rate limit; a hidden `website` field catches bots. */
export const POST = api({ auth: "none", body: publicEnquirySchema, limit: { limit: 10, windowSec: 600, key: "listing-enquiry" } }, async ({ sq, body }) => {
  const { token, ...rest } = body;
  return submitListingEnquiry(sq, token, rest);
});

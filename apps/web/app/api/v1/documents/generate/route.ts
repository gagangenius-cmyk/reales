import { leaseContractDraftPdf, offerLetterPdf, ownerStatementPdf, receiptPdf, savePdfAsDocument } from "@reales/domain";
import { generateDocSchema } from "@reales/validation";
import { api } from "@/lib/api";

const MAKE = { receipt: [receiptPdf, "Payment receipt", "receipt"], lease_contract: [leaseContractDraftPdf, "Tenancy agreement (draft)", "contract"], owner_statement: [ownerStatementPdf, "Owner statement", "other"], offer_letter: [offerLetterPdf, "Offer letter", "other"] } as const;

/** Renders the PDF with the caller's own access, then stores it as an immutable document version. */
export const POST = api({ body: generateDocSchema }, async ({ ctx, sq, body }) => {
  const [make, title, kind] = MAKE[body.kind];
  const bytes = await make(sq, ctx, body.id);
  return { status: 201, data: await savePdfAsDocument(sq, ctx, `${title} ${new Date().toISOString().slice(0, 10)}`, bytes, [], kind) };
});

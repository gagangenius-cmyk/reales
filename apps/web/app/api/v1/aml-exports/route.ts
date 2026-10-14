import { exportReportedCases } from "@reales/domain";
import { amlExportSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: amlExportSchema }, async ({ ctx, sq, body }) => exportReportedCases(sq, ctx, body));

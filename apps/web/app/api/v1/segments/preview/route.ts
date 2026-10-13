import { previewSegment } from "@reales/domain";
import { segmentPreviewSchema } from "@reales/validation";
import { api } from "@/lib/api";

export const POST = api({ body: segmentPreviewSchema }, async ({ ctx, sq, body }) => previewSegment(sq, ctx, body.definition));

import {
  addClaimEvidence, addClaimItems, approveClaimBatch, cancelClaimBatch, getClaimBatch, rejectClaimBatch, releaseClaimBatch, removeClaimItem, reverseClaimBatch,
  scheduleClaimRelease, submitClaimBatch, verifyClaimBatch, verifyClaimItem,
} from "@reales/domain";
import { claimActionSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const idSchema = z.string().uuid();

export const GET = api<{ id: string }>({}, async ({ ctx, sq, params }) => getClaimBatch(sq, ctx, idSchema.parse(params.id)));

/** One endpoint for the whole workflow: { action: submit | verify | approve | schedule | release | reverse | reject | cancel | add_items | remove_item | verify_item | evidence }. */
export const POST = api<{ id: string }, typeof claimActionSchema>({ body: claimActionSchema, idempotent: true }, async ({ ctx, sq, params, body }) => {
  const id = idSchema.parse(params.id);
  switch (body.action) {
    case "submit": return submitClaimBatch(sq, ctx, id);
    case "verify": return verifyClaimBatch(sq, ctx, id);
    case "approve": return approveClaimBatch(sq, ctx, id);
    case "schedule": return scheduleClaimRelease(sq, ctx, id, body.date);
    case "release": return releaseClaimBatch(sq, ctx, id, body.reference);
    case "reverse": return reverseClaimBatch(sq, ctx, id, body.reason);
    case "reject": return rejectClaimBatch(sq, ctx, id, body.reason);
    case "cancel": return cancelClaimBatch(sq, ctx, id, body.reason);
    case "add_items": return addClaimItems(sq, ctx, id, body.calculationIds);
    case "remove_item": await removeClaimItem(sq, ctx, id, body.itemId); return { ok: true };
    case "verify_item": return verifyClaimItem(sq, ctx, id, body.itemId, { outcome: body.outcome, note: body.note });
    case "evidence": return addClaimEvidence(sq, ctx, id, { kind: body.kind, description: body.description, documentId: body.documentId, itemId: body.itemId });
  }
});

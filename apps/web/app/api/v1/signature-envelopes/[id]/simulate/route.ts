import { NextResponse } from "next/server";
import { buildMockSignatureWebhook, getEnvelope, ingestWebhook, processWebhookEvent } from "@reales/domain";
import { simulateSignSchema, z } from "@reales/validation";
import { api } from "@/lib/api";

const uuid = z.string().uuid();

/**
 * Development only: plays the part of the mock provider by posting a correctly signed callback through the real webhook
 * pipeline. Not available in production.
 */
export const POST = api<{ id: string }, typeof simulateSignSchema>({ body: simulateSignSchema }, async ({ ctx, sq, body, params }) => {
  if (process.env.NODE_ENV === "production") return NextResponse.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
  const env = await getEnvelope(sq, ctx, uuid.parse(params.id)); // also enforces access
  if (env.provider !== "mock") return NextResponse.json({ error: { code: "conflict", message: "Only the mock provider can be simulated" } }, { status: 409 });
  const w = buildMockSignatureWebhook({ type: body.action === "sign" ? "signer.signed" : "signer.declined", envelopeId: env.providerEnvelopeId, signerEmail: body.signerEmail });
  const r = await ingestWebhook(sq, { kind: "esign", provider: "mock", rawBody: w.rawBody, headers: w.headers });
  const processed = r.id && r.status === "queued" ? await processWebhookEvent(sq, r.id) : null;
  return { ingest: r.status, processed };
});

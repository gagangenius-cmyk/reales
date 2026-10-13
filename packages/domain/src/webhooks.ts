import { randomUUID } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, systemContext } from "@reales/database";
import { emitEvent } from "@reales/events";
import { logger } from "@reales/observability";
import { applyPaymentEvent } from "./finance";
import { applySignatureEvent } from "./esign";
import { getPaymentProvider, getSignatureProvider, WebhookSignatureError } from "./providers";

export type WebhookKind = "esign" | "payment";

export interface IncomingWebhook {
  kind: WebhookKind;
  provider: string;
  rawBody: string;
  headers: Record<string, string | null | undefined>;
}

export interface IngestResult { id: string | null; duplicate: boolean; tenantId: string | null; status: "queued" | "duplicate" | "ignored" }

function parse(w: IncomingWebhook) {
  if (w.kind === "esign") {
    const p = getSignatureProvider(w.provider);
    if (!p) throw new Error("Unknown signature provider");
    if (!p.verifyWebhook(w.rawBody, w.headers)) throw new WebhookSignatureError();
    const e = p.parseWebhook(w.rawBody);
    return { eventId: e.eventId, ref: e.providerEnvelopeId };
  }
  const p = getPaymentProvider(w.provider);
  if (!p) throw new Error("Unknown payment provider");
  if (!p.verifyWebhook(w.rawBody, w.headers)) throw new WebhookSignatureError();
  const e = p.parseWebhook(w.rawBody);
  return { eventId: e.eventId, ref: e.providerRef };
}

async function resolveTenant(sq: Sequelize, w: IncomingWebhook, ref: string): Promise<string | null> {
  const sql = w.kind === "esign"
    ? "SELECT DISTINCT tenant_id FROM signature_envelopes WHERE provider=:p AND provider_envelope_id=:r"
    : "SELECT DISTINCT tenant_id FROM payments WHERE provider=:p AND provider_ref=:r";
  const rows = await sq.query<{ tenant_id: string }>(sql, { replacements: { p: w.provider, r: ref }, type: QueryTypes.SELECT });
  return rows.length === 1 ? rows[0]!.tenant_id : null; // zero or ambiguous references are never guessed
}

/**
 * Webhook front door (blueprint): verify signature -> dedupe -> persist raw event -> acknowledge -> process asynchronously.
 * Only authenticated events are stored; a bad signature throws WebhookSignatureError and persists nothing.
 * Normalised processing happens in the worker via the `webhook.received` outbox event (or inline in dev).
 */
export async function ingestWebhook(sq: Sequelize, w: IncomingWebhook): Promise<IngestResult> {
  const { eventId, ref } = parse(w);
  const id = randomUUID();
  const now = new Date();
  try {
    await sq.query(
      "INSERT INTO webhook_events (id, tenant_id, provider, kind, event_id, raw_body, signature_valid, status, received_at) VALUES (:id, NULL, :p, :k, :e, :raw, 1, 'received', :now)",
      { replacements: { id, p: w.provider, k: w.kind, e: eventId, raw: w.rawBody, now: mysqlDate(now) } },
    );
  } catch (e: any) {
    if (e?.original?.code === "ER_DUP_ENTRY" || e?.parent?.code === "ER_DUP_ENTRY") return { id: null, duplicate: true, tenantId: null, status: "duplicate" };
    throw e;
  }
  const tenantId = await resolveTenant(sq, w, ref);
  if (!tenantId) {
    await sq.query("UPDATE webhook_events SET status='ignored', error='unknown or ambiguous reference', processed_at=:now WHERE id=:id", { replacements: { id, now: mysqlDate(new Date()) } });
    return { id, duplicate: false, tenantId: null, status: "ignored" };
  }
  await sq.transaction(async (tx) => {
    await sq.query("UPDATE webhook_events SET tenant_id=:t WHERE id=:id", { replacements: { t: tenantId, id }, transaction: tx });
    await emitEvent(sq, tx, systemContext(tenantId, `corr_${randomUUID()}`), { type: "webhook.received", aggregateType: "webhook", aggregateId: id, payload: { webhookEventId: id, kind: w.kind, provider: w.provider } });
  });
  return { id, duplicate: false, tenantId, status: "queued" };
}

export type ProcessResult = { status: "processed" | "failed" | "skipped"; outcome?: string; error?: string };

/** Worker entry point. Safe to run twice: only `received` events are processed, under a row lock. */
export async function processWebhookEvent(sq: Sequelize, id: string): Promise<ProcessResult> {
  const claimed = await sq.transaction(async (tx) => {
    const [row] = await sq.query<any>("SELECT * FROM webhook_events WHERE id=:id FOR UPDATE", { replacements: { id }, transaction: tx, type: QueryTypes.SELECT });
    if (!row || row.status !== "received" || !row.tenant_id) return null;
    return row;
  });
  if (!claimed) return { status: "skipped" };
  try {
    let outcome: string;
    if (claimed.kind === "esign") {
      const ev = getSignatureProvider(claimed.provider)!.parseWebhook(claimed.raw_body);
      outcome = await applySignatureEvent(sq, claimed.tenant_id, ev, claimed.provider);
    } else {
      const ev = getPaymentProvider(claimed.provider)!.parseWebhook(claimed.raw_body);
      outcome = await applyPaymentEvent(sq, claimed.tenant_id, ev, claimed.provider);
    }
    await sq.query("UPDATE webhook_events SET status='processed', processed_at=:now WHERE id=:id AND status='received'", { replacements: { id, now: mysqlDate(new Date()) } });
    return { status: "processed", outcome };
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 1000);
    logger.warn({ webhookEventId: id, error }, "webhook processing failed");
    await sq.query("UPDATE webhook_events SET status='failed', error=:error, processed_at=:now WHERE id=:id AND status='received'", { replacements: { id, error, now: mysqlDate(new Date()) } });
    return { status: "failed", error };
  }
}

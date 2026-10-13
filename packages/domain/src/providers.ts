import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------- shared webhook signing (HMAC-SHA256)
export class WebhookSignatureError extends Error {
  status = 401;
  constructor() {
    super("Invalid webhook signature");
    this.name = "WebhookSignatureError";
  }
}

function mockSecret(): string {
  const s = process.env.MOCK_WEBHOOK_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") throw new Error("MOCK_WEBHOOK_SECRET is required when mock providers are enabled in production");
  return "dev-mock-webhook-secret";
}

export const hmacHex = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

export function verifyHmac(secret: string, body: string, provided: string | null | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(hmacHex(secret, body), "hex");
  let b: Buffer;
  try { b = Buffer.from(provided, "hex"); } catch { return false; }
  return a.length === b.length && timingSafeEqual(a, b);
}

const mockAllowed = () => process.env.NODE_ENV !== "production" || process.env.ALLOW_MOCK_PROVIDERS === "1";

// ---------------------------------------------------------------- e-signature
export type SignatureStatus = "draft" | "sent" | "completed" | "declined" | "cancelled";

export interface SignerSpec { name: string; email: string; order: number }
export interface SignatureEvidence {
  provider: string; providerEnvelopeId: string; contentHash: string; completedAt: string;
  signers: Array<{ name: string; email: string; signedAt: string; ip: string | null }>;
}
export interface SignatureWebhookEvent {
  eventId: string; type: "signer.signed" | "signer.declined" | "envelope.cancelled";
  providerEnvelopeId: string; signerEmail?: string; occurredAt: string; ip?: string;
}

/**
 * Vendor-neutral e-signature contract (blueprint). Not every e-signature product is legally interchangeable: where a
 * qualified/government-recognised level is required, configure the workflow with an eligible provider.
 */
export interface SignatureProvider {
  readonly code: string;
  readonly label: string;
  createEnvelope(i: { subject: string; documentName: string; contentHash: string; bytes: Buffer }): Promise<{ providerEnvelopeId: string }>;
  addSigner(providerEnvelopeId: string, s: SignerSpec): Promise<{ providerSignerId: string }>;
  send(providerEnvelopeId: string): Promise<void>;
  getStatus(providerEnvelopeId: string): Promise<SignatureStatus>;
  downloadEvidence(providerEnvelopeId: string): Promise<SignatureEvidence | null>;
  cancel(providerEnvelopeId: string): Promise<void>;
  verifyWebhook(rawBody: string, headers: Record<string, string | null | undefined>): boolean;
  parseWebhook(rawBody: string): SignatureWebhookEvent;
}

const signatureRegistry = new Map<string, SignatureProvider>();
export const registerSignatureProvider = (p: SignatureProvider) => void signatureRegistry.set(p.code, p);
export const getSignatureProvider = (code: string) => signatureRegistry.get(code) ?? null;

/** Dev/demo provider: keeps state in memory and authenticates callbacks with an HMAC header. Disabled in production unless explicitly allowed. */
class MockSignatureProvider implements SignatureProvider {
  readonly code = "mock";
  readonly label = "Mock e-signature (development only)";
  private envelopes = new Map<string, { status: SignatureStatus; signers: SignerSpec[] }>();
  private guard() { if (!mockAllowed()) throw new Error("The mock signature provider is disabled in production"); }
  async createEnvelope() { this.guard(); const id = `mock_env_${randomUUID()}`; this.envelopes.set(id, { status: "draft", signers: [] }); return { providerEnvelopeId: id }; }
  async addSigner(id: string, s: SignerSpec) { this.guard(); this.envelopes.get(id)?.signers.push(s); return { providerSignerId: `mock_signer_${randomUUID()}` }; }
  async send(id: string) { this.guard(); const e = this.envelopes.get(id); if (e) e.status = "sent"; }
  async getStatus(id: string): Promise<SignatureStatus> { return this.envelopes.get(id)?.status ?? "sent"; }
  async downloadEvidence() { return null; } // evidence is assembled by us from verified callbacks
  async cancel(id: string) { const e = this.envelopes.get(id); if (e) e.status = "cancelled"; }
  verifyWebhook(rawBody: string, headers: Record<string, string | null | undefined>) { return mockAllowed() && verifyHmac(mockSecret(), rawBody, headers["x-mock-signature"]); }
  parseWebhook(rawBody: string): SignatureWebhookEvent {
    const j = JSON.parse(rawBody);
    if (!j?.eventId || !j?.type || !j?.envelopeId) throw new Error("Malformed signature webhook");
    return { eventId: String(j.eventId), type: j.type, providerEnvelopeId: String(j.envelopeId), signerEmail: j.signerEmail, occurredAt: j.occurredAt ?? new Date().toISOString(), ip: j.ip };
  }
}
registerSignatureProvider(new MockSignatureProvider());

/** Build a correctly signed mock callback (used by tests and the development "simulate signing" action). */
export function buildMockSignatureWebhook(e: { type: SignatureWebhookEvent["type"]; envelopeId: string; signerEmail?: string; eventId?: string; ip?: string }) {
  const rawBody = JSON.stringify({ eventId: e.eventId ?? `evt_${randomUUID()}`, type: e.type, envelopeId: e.envelopeId, signerEmail: e.signerEmail, occurredAt: new Date().toISOString(), ip: e.ip ?? "203.0.113.10" });
  return { rawBody, headers: { "x-mock-signature": hmacHex(mockSecret(), rawBody) } };
}

// ---------------------------------------------------------------- payments
export interface PaymentWebhookEvent {
  eventId: string; type: "payment.succeeded" | "payment.failed"; providerRef: string; amount: number; currency: string; occurredAt: string; failureReason?: string;
}

export interface PaymentProvider {
  readonly code: string;
  readonly label: string;
  createCheckout(i: { amount: number; currency: string; reference: string }): Promise<{ providerRef: string; checkoutUrl: string }>;
  verifyWebhook(rawBody: string, headers: Record<string, string | null | undefined>): boolean;
  parseWebhook(rawBody: string): PaymentWebhookEvent;
}

const paymentRegistry = new Map<string, PaymentProvider>();
export const registerPaymentProvider = (p: PaymentProvider) => void paymentRegistry.set(p.code, p);
export const getPaymentProvider = (code: string) => paymentRegistry.get(code) ?? null;

class MockPaymentProvider implements PaymentProvider {
  readonly code = "mock";
  readonly label = "Mock payment gateway (development only)";
  async createCheckout(i: { amount: number; currency: string; reference: string }) {
    if (!mockAllowed()) throw new Error("The mock payment provider is disabled in production");
    const providerRef = `mock_pay_${randomUUID()}`;
    return { providerRef, checkoutUrl: `https://pay.example.invalid/checkout/${providerRef}?ref=${encodeURIComponent(i.reference)}` };
  }
  verifyWebhook(rawBody: string, headers: Record<string, string | null | undefined>) { return mockAllowed() && verifyHmac(mockSecret(), rawBody, headers["x-mock-signature"]); }
  parseWebhook(rawBody: string): PaymentWebhookEvent {
    const j = JSON.parse(rawBody);
    if (!j?.eventId || !j?.type || !j?.providerRef || typeof j.amount !== "number") throw new Error("Malformed payment webhook");
    return { eventId: String(j.eventId), type: j.type, providerRef: String(j.providerRef), amount: j.amount, currency: j.currency ?? "AED", occurredAt: j.occurredAt ?? new Date().toISOString(), failureReason: j.failureReason };
  }
}
registerPaymentProvider(new MockPaymentProvider());

export function buildMockPaymentWebhook(e: { type: PaymentWebhookEvent["type"]; providerRef: string; amount: number; currency?: string; eventId?: string; failureReason?: string }) {
  const rawBody = JSON.stringify({ eventId: e.eventId ?? `evt_${randomUUID()}`, type: e.type, providerRef: e.providerRef, amount: e.amount, currency: e.currency ?? "AED", occurredAt: new Date().toISOString(), failureReason: e.failureReason });
  return { rawBody, headers: { "x-mock-signature": hmacHex(mockSecret(), rawBody) } };
}

import { createHmac, timingSafeEqual } from "node:crypto";
import { decryptField } from "@reales/auth";
import { MessagingError, registerMessagingProvider, type DeliveryStatusEvent, type InboundEvent, type MessagingProvider, type OutboundMessage } from "./messaging";

/**
 * WhatsApp Business Cloud API (Meta) as a messaging provider. Written from Meta's published webhook and send formats; it has NOT been run against a live
 * WhatsApp Business account (that needs a Meta app, a phone number and an access token), so treat the first live test as part of go-live.
 *
 *  - Credentials live on the channel account: `config.phoneNumberId` and `config.accessTokenEnc` (the token is encrypted when the account is created).
 *  - Meta signs every webhook with the app secret (`X-Hub-Signature-256`, set `META_APP_SECRET`); the GET handshake uses `META_VERIFY_TOKEN`.
 *  - A webhook can carry several messages and statuses. `splitWhatsAppWebhook` turns one delivery into one normalised event each, so none is lost.
 *  - Free-form text only works inside WhatsApp's 24-hour window (the CRM already enforces that). A CRM template whose components carry `meta: { name,
 *    language }` is sent as that Meta-approved template, with its body variables as {{1}}, {{2}}... in order of appearance; this is how business-initiated
 *    messages and broadcasts reach people outside the window. A template without `meta` is sent as plain text and Meta refuses it outside the window.
 */
export const WHATSAPP_PROVIDER = "whatsapp_cloud";
const apiBase = () => `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION ?? "v21.0"}`;
const digits = (s: string) => s.replace(/[^\d]/g, "");
const plus = (s: string) => `+${digits(s)}`;

export function verifyMetaSignature(rawBody: string, header: string | null | undefined, secret = process.env.META_APP_SECRET): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const given = header.slice(7);
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Answers Meta's subscription handshake: returns the challenge when the verify token matches, otherwise null. */
export function whatsappHandshake(q: URLSearchParams): string | null {
  const token = process.env.META_VERIFY_TOKEN;
  if (!token || q.get("hub.mode") !== "subscribe" || q.get("hub.verify_token") !== token) return null;
  return q.get("hub.challenge");
}

interface Normalised { kind: "inbound" | "status"; [k: string]: unknown }
function bodyOf(m: any): string {
  if (m.type === "text") return String(m.text?.body ?? "");
  const media = m[m.type];
  if (media?.caption) return `[${m.type}] ${media.caption}`;
  if (m.type === "button") return String(m.button?.text ?? "[button]");
  if (m.type === "interactive") return String(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "[interactive]");
  return `[${m.type ?? "message"}]`;
}

/** One normalised JSON body per message or status in a Meta delivery. */
export function splitWhatsAppWebhook(rawBody: string): string[] {
  let j: any;
  try { j = JSON.parse(rawBody); } catch { return [rawBody]; }
  if (j?.kind) return [rawBody]; // already normalised
  const out: Normalised[] = [];
  for (const entry of j?.entry ?? []) for (const ch of entry?.changes ?? []) {
    const v = ch?.value; if (!v) continue;
    const to = v.metadata?.display_phone_number ? plus(v.metadata.display_phone_number) : undefined;
    for (const m of v.messages ?? []) out.push({ kind: "inbound", eventId: String(m.id), channel: "whatsapp", from: plus(m.from), to, body: bodyOf(m), providerMessageId: String(m.id), occurredAt: new Date(Number(m.timestamp) * 1000).toISOString() });
    for (const s of v.statuses ?? []) {
      const st = String(s.status);
      if (!["sent", "delivered", "read", "failed"].includes(st)) continue;
      out.push({ kind: "status", eventId: `${s.id}:${st}`, providerMessageId: String(s.id), status: st, occurredAt: new Date(Number(s.timestamp) * 1000).toISOString(), ...(st === "failed" ? { error: String(s.errors?.[0]?.message ?? s.errors?.[0]?.title ?? "failed") } : {}) });
    }
  }
  return out.map((e) => JSON.stringify(e));
}

class WhatsAppCloudProvider implements MessagingProvider {
  readonly code = WHATSAPP_PROVIDER;
  constructor(private http: typeof fetch = (...a) => fetch(...a)) {}

  async send(m: OutboundMessage) {
    if (m.channel !== "whatsapp") throw new MessagingError("This provider only sends WhatsApp messages", false);
    const cfg = m.account?.config ?? {};
    const phoneNumberId = String(cfg.phoneNumberId ?? ""), tokenEnc = cfg.accessTokenEnc ? String(cfg.accessTokenEnc) : "";
    if (!phoneNumberId || !tokenEnc) throw new MessagingError("This WhatsApp account has no phone number id or access token", false);
    let token: string;
    try { token = decryptField(tokenEnc); } catch { throw new MessagingError("The stored WhatsApp access token could not be read", false); }
    let res: Response;
    try {
      res = await this.http(`${apiBase()}/${encodeURIComponent(phoneNumberId)}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(m.template
        ? { messaging_product: "whatsapp", recipient_type: "individual", to: digits(m.to), type: "template", template: { name: m.template.name, language: { code: m.template.language }, ...(m.template.params.length ? { components: [{ type: "body", parameters: m.template.params.map((text) => ({ type: "text", text })) }] } : {}) } }
        : { messaging_product: "whatsapp", recipient_type: "individual", to: digits(m.to), type: "text", text: { preview_url: false, body: m.body } }) });
    } catch (e) { throw new MessagingError(`Could not reach WhatsApp: ${e instanceof Error ? e.message : "network error"}`, true); }
    const j: any = await res.json().catch(() => null);
    if (!res.ok) {
      const err = j?.error, msg = `WhatsApp refused the message${err?.message ? `: ${err.message}` : ` (HTTP ${res.status})`}`;
      // 429, 5xx and Meta's transient codes are worth retrying; bad numbers, closed windows and expired tokens are not.
      throw new MessagingError(msg, res.status === 429 || res.status >= 500 || [1, 2, 4, 17, 80007].includes(Number(err?.code)));
    }
    const id = j?.messages?.[0]?.id;
    if (!id) throw new MessagingError("WhatsApp accepted the request but returned no message id", true);
    return { providerMessageId: String(id) };
  }

  splitWebhook(rawBody: string) { return splitWhatsAppWebhook(rawBody); }

  verifyWebhook(rawBody: string, headers: Record<string, string | null | undefined>) { return verifyMetaSignature(rawBody, headers["x-hub-signature-256"]); }

  parseWebhook(rawBody: string) {
    const first = JSON.parse(splitWhatsAppWebhook(rawBody)[0] ?? "null");
    if (!first) throw new Error("Malformed messaging webhook");
    if (first.kind === "inbound") return { kind: "inbound" as const, event: first as InboundEvent };
    if (first.kind === "status") return { kind: "status" as const, event: first as DeliveryStatusEvent };
    throw new Error("Malformed messaging webhook");
  }
}

export const whatsappCloud = new WhatsAppCloudProvider();
registerMessagingProvider(whatsappCloud);
export { WhatsAppCloudProvider };

import nodemailer from "nodemailer";
import { logger } from "@reales/observability";

export interface Mail { to: string; subject: string; text: string; html?: string; attachments?: { filename: string; content: Buffer; contentType?: string }[] }
export interface Mailer { code: string; send(m: Mail): Promise<void> }

/** Test/dev mailer: keeps messages in memory. It never delivers anything. */
export const mockMailer: Mailer & { sent: Mail[]; reset(): void; last(to?: string): Mail | undefined } = {
  code: "mock",
  sent: [],
  async send(m) {
    this.sent.push(m);
    // Local development only: there is no inbox, so show the mail (and its links) in the server log.
    if (process.env.NODE_ENV === "development") logger.info({ to: m.to, subject: m.subject }, `MOCK MAIL
${m.text}`);
  },
  reset() { this.sent.length = 0; },
  last(to) { return [...this.sent].reverse().find((m) => !to || m.to.toLowerCase() === to.toLowerCase()); },
};

/** SMTP via nodemailer. Configure with SMTP_URL (e.g. smtps://user:pass@smtp.example.com:465) and MAIL_FROM. */
export function smtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(url);
  return {
    code: "smtp",
    async send(m) {
      await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), ...(m.attachments?.length ? { attachments: m.attachments } : {}) });
    },
  };
}

let override: Mailer | null = null;
export const setMailer = (m: Mailer | null) => void (override = m);

/** SMTP when configured; otherwise the in-memory mock outside production. Production without SMTP fails loudly rather than pretending to send. */
export function getMailer(): Mailer {
  if (override) return override;
  const url = process.env.SMTP_URL;
  if (url) return smtpMailer(url, process.env.MAIL_FROM ?? "Reales CRM <no-reply@localhost>");
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_MOCK_PROVIDERS !== "1") throw new Error("SMTP_URL is required in production");
  return mockMailer;
}

/** Send, never throw to the caller: account flows must not reveal (through errors) whether an address exists. Failures are logged. */
export async function sendMailSafely(m: Mail): Promise<boolean> {
  if (/[\r\n]/.test(m.subject) || /[\r\n]/.test(m.to)) { logger.error("refusing mail with a line break in subject or recipient"); return false; }
  try {
    await getMailer().send(m);
    return true;
  } catch (e) {
    logger.error({ err: e }, "mail delivery failed");
    return false;
  }
}

export const escapeMailHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

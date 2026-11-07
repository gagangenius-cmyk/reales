import * as Sentry from "@sentry/nextjs";

/** Server-side error tracking. Does nothing unless SENTRY_DSN is set, so local and test runs are unaffected. */
export async function register() {
  if (!process.env.SENTRY_DSN) return;
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.05),
    // Request bodies and headers can hold passwords, tokens and client data: never send them.
    beforeSend(event) {
      if (event.request) { delete event.request.data; delete event.request.cookies; delete event.request.headers; }
      return event;
    },
  });
}

/** Next.js calls this for every unhandled server error (pages, route handlers, server actions). */
export const onRequestError = Sentry.captureRequestError;

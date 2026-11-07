import * as Sentry from "@sentry/nextjs";

/** Browser-side error tracking, same rules: off without a DSN, no personal data. */
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
    tracesSampleRate: 0.02,
    beforeSend(event) { if (event.request) { delete event.request.cookies; delete event.request.headers; } return event; },
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

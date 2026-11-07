"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/** Last resort when even the root layout fails. Plain HTML, no dependencies that could fail again. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { Sentry.captureException(error); }, [error]);
  return (
    <html lang="en"><body style={{ fontFamily: "system-ui, sans-serif", display: "grid", placeItems: "center", minHeight: "100vh", margin: 0, background: "#f3f5fb", color: "#0f172a" }}>
      <div style={{ maxWidth: 420, textAlign: "center", padding: 24 }}>
        <h1 style={{ fontSize: 22 }}>Reales CRM is temporarily unavailable</h1>
        <p style={{ color: "#64748b", fontSize: 14 }}>Please try again in a moment.{error.digest ? ` Reference: ${error.digest}` : ""}</p>
        <button onClick={reset} style={{ marginTop: 12, padding: "8px 16px", borderRadius: 8, border: 0, background: "#4f46e5", color: "#fff", fontWeight: 600, cursor: "pointer" }}>Try again</button>
      </div>
    </body></html>
  );
}

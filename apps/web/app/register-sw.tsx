"use client";

import { useEffect } from "react";

/** Registers the service worker that makes the CRM installable. Skipped in development so it never serves stale files while coding. */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => { /* installability is optional */ });
  }, []);
  return null;
}

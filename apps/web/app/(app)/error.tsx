"use client";

import { useEffect } from "react";

/** Any error inside a CRM page lands here instead of a blank screen. The message is generic on purpose; the reference lets support find the server log entry. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("page error", error.digest ?? "", error); }, [error]);
  return (
    <section className="card mx-auto mt-10 max-w-xl p-8 text-center" role="alert">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="muted mt-2 text-sm">This page could not be shown. Your data is safe. Try again, and if it keeps happening send the reference below to support.</p>
      {error.digest && <p className="mt-3 text-xs"><span className="muted">Reference: </span><code>{error.digest}</code></p>}
      <div className="mt-5 flex justify-center gap-2"><button className="btn" onClick={reset}>Try again</button><a className="btn-ghost" href="/dashboard">Go to dashboard</a></div>
    </section>
  );
}

"use client";

import { useState } from "react";
import { errMsg, postJson } from "@/lib/client";

/** Shows the user's private calendar link so Google Calendar, Outlook or Apple Calendar can subscribe and stay in sync. */
export function Subscribe() {
  const [url, setUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function load(rotate: boolean) {
    setBusy(true); setMsg(null);
    const r = rotate ? await postJson("/api/v1/calendar/feed", {}) : await (await fetch("/api/v1/calendar/feed", { cache: "no-store" })).json().then((d) => ({ ok: !!d.url, data: d, status: 200 }));
    setBusy(false);
    if (!r.ok) return setMsg(errMsg(r as never));
    setUrl(r.data.url); if (rotate) setMsg("New link created. The old one no longer works.");
  }
  return (
    <details className="card p-3 text-sm">
      <summary className="cursor-pointer font-medium" onClick={() => { if (!url) void load(false); }}>Sync with Google Calendar, Outlook or Apple Calendar</summary>
      <div className="mt-3 flex flex-col gap-2">
        <p className="muted">Subscribe once with your private link and your CRM tasks, viewings and deadlines appear in your own calendar, read-only. Calendar apps refresh it every few hours. Treat the link like a password.</p>
        {url ? (
          <>
            <input className="input font-mono text-xs" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Calendar subscription link" />
            <div className="flex flex-wrap gap-2">
              <button className="btn-ghost" onClick={() => navigator.clipboard?.writeText(url)}>Copy link</button>
              <a className="btn-ghost" target="_blank" rel="noopener noreferrer" href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(url.replace(/^https?:/, "webcal:"))}`}>Add to Google Calendar</a>
              <a className="btn-ghost" href={url.replace(/^https?:/, "webcal:")}>Open in Outlook / Apple Calendar</a>
              <button className="btn-ghost err" disabled={busy} onClick={() => confirm("Create a new link? The current one will stop working.") && load(true)}>Create a new link</button>
            </div>
          </>
        ) : <p className="muted">{busy ? "Loading..." : "Open to show your link."}</p>}
        {msg && <p role="status" className="muted">{msg}</p>}
      </div>
    </details>
  );
}

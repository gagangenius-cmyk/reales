"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

const fmt = (v?: string | null) => (v ? new Date(v).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "not yet");

interface Account { email: string; status: "active" | "revoked" | "error"; syncCalendar: boolean; syncGmail: boolean; lastCalendarSyncAt: string | null; lastGmailSyncAt: string | null; lastError: string | null; scopes: string[] }

export function GooglePanel({ configured, account }: { configured: boolean; account: Account | null }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connected = account && account.status !== "revoked";
  const hasGmail = !!account?.scopes?.some((s) => s.endsWith("/gmail.metadata"));

  async function connect() {
    setBusy(true); setMsg(null);
    const r = await postJson("/api/v1/google/connect");
    if (!r.ok) { setBusy(false); return setMsg(errMsg(r)); }
    window.location.href = r.data.url;
  }
  async function toggle(patch: object) { setMsg(null); const r = await postJson("/api/v1/google/settings", patch); if (!r.ok) setMsg(errMsg(r)); router.refresh(); }
  async function sync() {
    setBusy(true); setMsg(null);
    const r = await postJson("/api/v1/google/sync");
    setBusy(false);
    setMsg(r.ok ? (r.data?.error ? `Sync finished with a problem: ${r.data.error}` : "Synced.") : errMsg(r));
    router.refresh();
  }
  async function disconnect() {
    if (!window.confirm("Disconnect Google? Synced e-mail links and busy times are removed; events already in your calendar stay.")) return;
    setBusy(true); await postJson("/api/v1/google", undefined, "DELETE"); setBusy(false); router.refresh();
  }

  if (!configured) return <div className="card p-5 text-sm"><p className="font-medium">Google is not set up on this installation.</p><p className="muted mt-1">An administrator needs to create a Google Cloud OAuth client and set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and PUBLIC_BASE_URL.</p></div>;
  return (
    <div className="card flex flex-col gap-4 p-5">
      {!connected ? (
        <>
          <div><h2 className="font-semibold">Connect your Google account</h2>
            <ul className="muted mt-1 list-disc pl-5 text-sm"><li>Your open tasks and scheduled viewings appear in your primary Google calendar and stay up to date.</li><li>Your other Google events are read only as busy times (no titles are stored) so nobody books you over them.</li><li>Gmail is optional and read-only to message headers: sender, recipients, subject and date. Bodies are never read.</li><li>Your Google tokens are kept encrypted on the server and are never sent to your browser.</li></ul></div>
          <div className="flex items-center gap-3"><button className="btn" disabled={busy} onClick={connect}>Connect Google</button><p role="alert" className="err text-sm">{msg}</p></div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="font-semibold">{account!.email}</h2><p className="muted text-xs">Calendar synced {fmt(account!.lastCalendarSyncAt)}{account!.syncGmail ? ` - Gmail synced ${fmt(account!.lastGmailSyncAt)}` : ""}</p>
              {account!.status === "error" && account!.lastError && <p className="err text-sm">{account!.lastError}</p>}</div>
            <div className="flex gap-2"><button className="btn" disabled={busy} onClick={sync}>Sync now</button><button className="btn-ghost" disabled={busy} onClick={disconnect}>Disconnect</button></div>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={account!.syncCalendar} onChange={(e) => toggle({ syncCalendar: e.target.checked })} /> Sync tasks and viewings with Google Calendar</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!hasGmail} checked={account!.syncGmail} onChange={(e) => toggle({ syncGmail: e.target.checked })} /> Link e-mail with my contacts (headers only){!hasGmail && <span className="muted text-xs"> - reconnect and tick the Gmail permission to use this</span>}</label>
          <p role="alert" className="text-sm">{msg}</p>
        </>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { errMsg, postJson } from "@/lib/client";

/** Start a call through the company phone line: the phone system rings the agent's mobile first, then connects the lead. */
export function CallButton({ leadId }: { leadId: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function go() {
    setBusy(true); setMsg(null);
    const r = await postJson("/api/v1/calls/dial", { leadId });
    setBusy(false);
    setMsg(r.ok ? `Calling you on ${r.data.ringing}. Pick up and the lead will be connected.` : errMsg(r));
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" className="btn-ghost" disabled={busy} onClick={go}>{busy ? "Calling..." : "Call"}</button>
      {msg && <span role="status" className="muted text-xs">{msg}</span>}
    </span>
  );
}

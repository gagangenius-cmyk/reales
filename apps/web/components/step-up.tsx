"use client";

import { useState, type ReactNode } from "react";
import { errMsg, postJson, type ApiResult } from "@/lib/client";

/**
 * Sensitive actions need a recent second factor. Wrap the call in `guard`: if the server answers "step_up_required" the returned `form` asks for the
 * authenticator code, verifies it, and then repeats the original call automatically.
 */
export function useStepUp() {
  const [retry, setRetry] = useState<null | (() => Promise<unknown>)>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function guard<T = any>(fn: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
    const r = await fn();
    if ((r.data as any)?.error?.code === "step_up_required") setRetry(() => fn);
    return r;
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault();
    if (!retry) return;
    setBusy(true); setErr(null);
    const v = await postJson("/api/v1/auth/step-up", { code: code.trim() });
    if (!v.ok) { setBusy(false); return setErr(errMsg(v)); }
    const again = retry;
    setRetry(null); setCode(""); setBusy(false);
    await again();
  }
  const form: ReactNode = retry ? (
    <form onSubmit={verify} className="card flex flex-wrap items-end gap-3 p-4" role="dialog" aria-label="Confirm with your authenticator">
      <label className="flex flex-col gap-1.5 text-sm"><span className="muted text-xs font-medium">Authenticator code to confirm this action</span>
        <input className="input w-44" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus /></label>
      <button className="btn" disabled={busy || !code.trim()}>Verify and continue</button>
      <button type="button" className="btn-ghost" onClick={() => { setRetry(null); setCode(""); setErr(null); }}>Cancel</button>
      {err && <p role="alert" className="err w-full text-sm">{err}</p>}
    </form>
  ) : null;
  return { guard, form };
}

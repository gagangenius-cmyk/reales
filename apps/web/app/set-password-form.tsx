"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

/** Shared by "reset password" and "accept invitation": both exchange a one-time token for a new password. */
export function SetPasswordForm({ endpoint, title, intro, cta }: { endpoint: string; title: string; intro: string; cta: string }) {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("The two passwords do not match");
    setBusy(true);
    setError(null);
    const r = await postJson(endpoint, { token, password });
    setBusy(false);
    if (!r.ok) return setError(errMsg(r));
    setDone(true);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="muted text-sm">{intro}</p>
      </div>
      {!token ? (
        <p role="alert" className="err card p-5 text-sm">This link is incomplete. Open the link from your email again.</p>
      ) : done ? (
        <div className="card p-5 text-sm" role="status">Done. You can now <Link className="underline" href="/login">sign in</Link>.</div>
      ) : (
        <form onSubmit={submit} className="card flex flex-col gap-3 p-5">
          <label className="text-sm">New password<input className="input mt-1" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={12} /></label>
          <label className="text-sm">Confirm password<input className="input mt-1" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required /></label>
          <p className="muted text-xs">At least 12 characters with upper and lower case letters and a digit.</p>
          {error && <p role="alert" className="err text-sm">{error}</p>}
          <button className="btn" disabled={busy}>{busy ? "Please wait..." : cta}</button>
        </form>
      )}
    </main>
  );
}


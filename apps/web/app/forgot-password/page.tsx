"use client";

import { useState } from "react";
import Link from "next/link";
import { errMsg, postJson } from "@/lib/client";

export default function ForgotPassword() {
  const [tenant, setTenant] = useState("");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await postJson("/api/v1/auth/password/forgot", { tenant, email });
    setBusy(false);
    if (!r.ok) return setError(errMsg(r));
    setSent(true);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-2xl font-semibold">Reset your password</h1>
        <p className="muted text-sm">Enter your workspace and email. If an account exists we will send a reset link.</p>
      </div>
      {sent ? (
        <div className="card p-5 text-sm" role="status">If an account exists for that address, a reset link is on its way. It is valid for one hour and can be used once.</div>
      ) : (
        <form onSubmit={submit} className="card flex flex-col gap-3 p-5">
          <label className="text-sm">Workspace<input className="input mt-1" value={tenant} onChange={(e) => setTenant(e.target.value.toLowerCase())} required /></label>
          <label className="text-sm">Email<input className="input mt-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" /></label>
          {error && <p role="alert" className="err text-sm">{error}</p>}
          <button className="btn" disabled={busy}>{busy ? "Please wait..." : "Send reset link"}</button>
        </form>
      )}
      <Link className="muted text-sm underline" href="/login">Back to sign in</Link>
    </main>
  );
}

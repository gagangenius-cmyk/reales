"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { errMsg, postJson } from "@/lib/client";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<"password" | "mfa">(params.get("mfa") ? "mfa" : "password");
  const [tenant, setTenant] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (step === "password") {
      const r = await postJson("/api/v1/auth/login", { tenant, email, password });
      setBusy(false);
      if (!r.ok) return setError(errMsg(r));
      if (r.data.status === "mfa_required") return setStep("mfa");
      if (r.data.status === "mfa_enrollment_required") return router.push("/mfa/setup");
      router.push("/dashboard");
    } else {
      const r = await postJson("/api/v1/auth/mfa/verify", { code });
      setBusy(false);
      if (!r.ok) return setError(errMsg(r));
      router.push("/dashboard");
    }
  }

  async function sso() {
    setBusy(true);
    setError(null);
    const r = await postJson("/api/v1/auth/sso/begin", { tenant, email });
    setBusy(false);
    if (!r.ok) return setError("Single sign-on is not available for this workspace and email");
    window.location.href = r.data.authorizationUrl;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="muted text-sm">Reales CRM for UAE real estate</p>
      </div>
      <form onSubmit={submit} className="card flex flex-col gap-3 p-5">
        {step === "password" ? (
          <>
            <label className="text-sm">Workspace<input className="input mt-1" value={tenant} onChange={(e) => setTenant(e.target.value.toLowerCase())} placeholder="your-company" autoComplete="organization" required /></label>
            <label className="text-sm">Email<input className="input mt-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></label>
            <label className="text-sm">Password<input className="input mt-1" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
          </>
        ) : (
          <label className="text-sm">Authenticator code or recovery code<input className="input mt-1" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus required /></label>
        )}
        {error && <p role="alert" className="err text-sm">{error}</p>}
        <button className="btn" disabled={busy}>{busy ? "Please wait..." : step === "password" ? "Continue" : "Verify"}</button>
        {step === "password" && <button type="button" className="btn-ghost" disabled={busy || !tenant || !email} onClick={sso}>Sign in with single sign-on</button>}
      </form>
      <Link className="muted text-sm underline" href="/forgot-password">Forgot your password?</Link>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}

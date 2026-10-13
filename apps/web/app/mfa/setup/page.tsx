"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export default function MfaSetup() {
  const router = useRouter();
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    postJson("/api/v1/auth/mfa/enroll").then((r) => {
      if (r.status === 401) return router.push("/login");
      if (!r.ok) return setError(errMsg(r));
      setQr(r.data.qrSvg);
      setSecret(r.data.secret);
    });
  }, [router]);

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await postJson("/api/v1/auth/mfa/enroll/confirm", { code });
    if (!r.ok) return setError(errMsg(r));
    setRecovery(r.data.recoveryCodes);
  }

  if (recovery) {
    return (
      <main className="mx-auto max-w-md px-4 py-12">
        <h1 className="text-2xl font-semibold">Save your recovery codes</h1>
        <p className="muted mt-1 text-sm">Each code works once if you lose your authenticator. They are shown only now.</p>
        <pre className="card mt-4 p-4 text-sm">{recovery.join("\n")}</pre>
        <button className="btn mt-4" onClick={() => router.push("/dashboard")}>I saved them, continue</button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-2xl font-semibold">Set up two-factor authentication</h1>
      <p className="muted mt-1 text-sm">Your role requires a second factor. Scan the code with an authenticator app, then enter the 6-digit code.</p>
      {qr && <div className="card mt-4 flex justify-center bg-white p-4" aria-label="QR code" dangerouslySetInnerHTML={{ __html: qr }} />}
      {secret && <p className="muted mt-2 break-all text-xs">Manual key: {secret}</p>}
      <form onSubmit={confirm} className="mt-4 flex flex-col gap-3">
        <input className="input" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" required />
        {error && <p role="alert" className="err text-sm">{error}</p>}
        <button className="btn">Confirm</button>
      </form>
    </main>
  );
}

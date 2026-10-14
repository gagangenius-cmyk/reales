"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function InviteForm({ roles }: { roles: Array<{ key: string; name: string }> }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [roleKey, setRoleKey] = useState(roles[0]?.key ?? "agent");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const r = await postJson("/api/v1/users/invite", { email, roleKeys: [roleKey] });
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    setMsg({ ok: true, text: r.data.delivered ? `Invitation sent to ${email}.` : `User created, but the email could not be delivered. Use "Resend" once mail is configured.` });
    setEmail("");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="card flex flex-wrap items-end gap-3 p-4">
      <label className="grow text-sm">Invite by email<input className="input mt-1 w-full" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
      <label className="text-sm">Role<select className="input mt-1" value={roleKey} onChange={(e) => setRoleKey(e.target.value)}>{roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</select></label>
      <button className="btn" disabled={busy}>{busy ? "Sending..." : "Send invitation"}</button>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`w-full text-sm ${msg.ok ? "" : "err"}`}>{msg.text}</p>}
    </form>
  );
}

export function ResendInvite({ userId }: { userId: string }) {
  const router = useRouter();
  const [state, setState] = useState<string | null>(null);
  async function go() {
    setState("Sending...");
    const r = await postJson(`/api/v1/users/${userId}/resend-invite`);
    setState(r.ok ? (r.data.delivered ? "Sent" : "Not delivered") : errMsg(r));
    router.refresh();
  }
  return <span><button className="btn-ghost text-xs" onClick={go}>Resend invite</button>{state && <span className="muted ml-2 text-xs">{state}</span>}</span>;
}

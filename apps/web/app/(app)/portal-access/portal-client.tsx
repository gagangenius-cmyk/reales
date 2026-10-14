"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function InvitePortal({ contacts }: { contacts: Array<{ id: string; label: string }> }) {
  const router = useRouter();
  const [contactId, setContactId] = useState(contacts[0]?.id ?? "");
  const [kind, setKind] = useState<"owner" | "tenant">("tenant");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const r = await postJson("/api/v1/portal-users", { contactId, kind });
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    setMsg({ ok: true, text: r.data.delivered ? "Invitation sent." : "Access created, but the email could not be delivered." });
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="card flex flex-wrap items-end gap-3 p-4">
      <label className="grow text-sm">Person<select className="input mt-1 w-full" value={contactId} onChange={(e) => setContactId(e.target.value)}>{contacts.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
      <label className="text-sm">Portal<select className="input mt-1" value={kind} onChange={(e) => setKind(e.target.value as "owner" | "tenant")}><option value="tenant">Tenant</option><option value="owner">Owner</option></select></label>
      <button className="btn" disabled={!contactId}>Send invitation</button>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`w-full text-sm ${msg.ok ? "" : "err"}`}>{msg.text}</p>}
    </form>
  );
}

export function RevokePortal({ id }: { id: string }) {
  const router = useRouter();
  async function go() {
    if (!window.confirm("Remove this person's portal access and sign them out?")) return;
    await postJson(`/api/v1/portal-users/${id}/revoke`);
    router.refresh();
  }
  return <button className="btn-ghost text-xs" onClick={go}>Revoke</button>;
}

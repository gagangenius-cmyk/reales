"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

type Held = { userRoleId: string; roleKey: string; roleName: string };

export function UserRoles({ userId, held, roles, canManage }: { userId: string; held: Held[]; roles: { key: string; name: string }[]; canManage: boolean }) {
  const router = useRouter();
  const [add, setAdd] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const free = roles.filter((r) => !held.some((h) => h.roleKey === r.key));

  async function run(p: Promise<{ ok: boolean; data: any; status: number }>) {
    setMsg(null);
    const r = await p;
    if (!r.ok) return setMsg(errMsg(r as any));
    setAdd("");
    router.refresh();
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {held.map((h) => (
        <span key={h.userRoleId} className="badge">{h.roleName}
          {canManage && <button type="button" className="ml-1 opacity-70 hover:opacity-100" aria-label={`Remove ${h.roleName}`} onClick={() => run(postJson(`/api/v1/users/${userId}/roles/${h.userRoleId}`, undefined, "DELETE"))}>&times;</button>}
        </span>
      ))}
      {held.length === 0 && <span className="muted text-xs">No role</span>}
      {canManage && free.length > 0 && (
        <select className="input w-auto py-0.5 text-xs" value={add} aria-label="Add role" onChange={(e) => { setAdd(e.target.value); if (e.target.value) run(postJson(`/api/v1/users/${userId}/roles`, { roleKey: e.target.value })); }}>
          <option value="">+ role</option>{free.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
        </select>
      )}
      {msg && <span role="alert" className="err w-full text-xs">{msg}</span>}
    </div>
  );
}

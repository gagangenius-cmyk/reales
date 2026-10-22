"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

interface Member { id: string; userId: string; email: string; role: "leader" | "member" }
interface Team { id: string; name: string; branchId: string | null; branchName: string | null; parentTeamId: string | null; description: string | null; status: string; leaderEmail: string | null; members: Member[] }
interface Opt { id: string; name: string }

export function TeamsPanel({ teams, branches, users, canManage }: { teams: Team[]; branches: Opt[]; users: { id: string; email: string }[]; canManage: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [branchId, setBranchId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState<Record<string, { userId: string; role: string }>>({});

  async function run(p: Promise<{ ok: boolean; data: any; status: number }>) {
    setErr(null);
    const r = await p;
    if (!r.ok) return setErr(errMsg(r as any));
    router.refresh();
  }
  const byId = new Map(teams.map((t) => [t.id, t]));
  const roots = teams.filter((t) => !t.parentTeamId || !byId.has(t.parentTeamId));
  const childrenOf = (id: string) => teams.filter((t) => t.parentTeamId === id);

  const Card = ({ t, depth }: { t: Team; depth: number }) => {
    const draft = adding[t.id] ?? { userId: "", role: "member" };
    const free = users.filter((u) => !t.members.some((m) => m.userId === u.id));
    return (
      <div style={{ marginLeft: depth * 20 }} className="flex flex-col gap-2">
        <div className="card p-4" style={{ opacity: t.status === "archived" ? 0.6 : 1 }}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold">{t.name} {t.status === "archived" && <span className="badge badge-gray">archived</span>}</h3>
              <p className="muted text-xs">{t.branchName ?? "No branch"} &middot; Leader: {t.leaderEmail ?? "none"} &middot; {t.members.length} member(s){t.parentTeamId && byId.get(t.parentTeamId) ? ` · under ${byId.get(t.parentTeamId)!.name}` : ""}</p>
            </div>
            {canManage && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <select className="input w-auto py-1" value={t.parentTeamId ?? ""} aria-label="Parent team" onChange={(e) => run(postJson(`/api/v1/teams/${t.id}`, { parentTeamId: e.target.value || null }, "PATCH"))}>
                  <option value="">No parent team</option>{teams.filter((x) => x.id !== t.id).map((x) => <option key={x.id} value={x.id}>Under {x.name}</option>)}
                </select>
                <select className="input w-auto py-1" value={t.branchId ?? ""} aria-label="Branch" onChange={(e) => run(postJson(`/api/v1/teams/${t.id}`, { branchId: e.target.value || null }, "PATCH"))}>
                  <option value="">No branch</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <button className="btn-ghost" onClick={() => run(postJson(`/api/v1/teams/${t.id}`, { status: t.status === "active" ? "archived" : "active" }, "PATCH"))}>{t.status === "active" ? "Archive" : "Restore"}</button>
              </div>
            )}
          </div>
          <ul className="mt-3 flex flex-wrap gap-2">
            {t.members.map((m) => (
              <li key={m.id} className={`badge ${m.role === "leader" ? "badge-warn" : ""}`}>
                {m.role === "leader" && "★ "}{m.email}
                {canManage && (
                  <>
                    {m.role !== "leader" && <button className="ml-2 underline" title="Make team leader" onClick={() => run(postJson(`/api/v1/teams/${t.id}/members`, { userId: m.userId, role: "leader" }, "PUT"))}>lead</button>}
                    <button className="ml-2 opacity-70 hover:opacity-100" aria-label={`Remove ${m.email}`} onClick={() => run(postJson(`/api/v1/teams/${t.id}/members`, { userId: m.userId }, "DELETE"))}>&times;</button>
                  </>
                )}
              </li>
            ))}
            {t.members.length === 0 && <li className="muted text-sm">No members yet.</li>}
          </ul>
          {canManage && free.length > 0 && (
            <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (draft.userId) { void run(postJson(`/api/v1/teams/${t.id}/members`, { userId: draft.userId, role: draft.role }, "PUT")); setAdding({ ...adding, [t.id]: { userId: "", role: "member" } }); } }}>
              <select className="input w-auto py-1 text-sm" value={draft.userId} onChange={(e) => setAdding({ ...adding, [t.id]: { ...draft, userId: e.target.value } })} aria-label="Add member"><option value="">Add a person...</option>{free.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}</select>
              <select className="input w-auto py-1 text-sm" value={draft.role} onChange={(e) => setAdding({ ...adding, [t.id]: { ...draft, role: e.target.value } })} aria-label="Role"><option value="member">Member</option><option value="leader">Team leader</option></select>
              <button className="btn-ghost text-sm" disabled={!draft.userId}>Add</button>
            </form>
          )}
        </div>
        {childrenOf(t.id).map((c) => <Card key={c.id} t={c} depth={depth + 1} />)}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {canManage && (
        <form className="card flex flex-wrap items-end gap-3 p-4" onSubmit={(e) => { e.preventDefault(); void run(postJson("/api/v1/teams", { name, ...(branchId ? { branchId } : {}) })); setName(""); }}>
          <label className="grow text-sm"><span className="muted text-xs font-medium">New team</span><input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Marina Sales A" required /></label>
          <label className="text-sm"><span className="muted text-xs font-medium">Branch</span><select className="input mt-1" value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">None</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          <button className="btn">Create team</button>
        </form>
      )}
      {err && <p role="alert" className="err text-sm">{err}</p>}
      {roots.map((t) => <Card key={t.id} t={t} depth={0} />)}
      {teams.length === 0 && <p className="muted text-sm">No teams yet. A team groups agents under a leader so you can set shared targets and see their performance.</p>}
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

type Perm = { key: string; action: string; description: string };
type Mod = { module: string; title: string; permissions: Perm[] };
type Role = { id: string; key: string; name: string; isSystem: boolean; requiresMfa: boolean; grants: Record<string, string> };

const SCOPES: [string, string][] = [["", "No access"], ["own_records", "Own records"], ["branch", "Branch / team"], ["business_unit", "Business unit"], ["project", "Project"], ["portfolio", "Portfolio"], ["tenant", "Everything"]];

export function RoleEditor({ roles, modules, canManage }: { roles: Role[]; modules: Mod[]; canManage: boolean }) {
  const router = useRouter();
  const [sel, setSel] = useState(roles[0]?.id ?? "");
  const role = roles.find((r) => r.id === sel);
  const [draft, setDraft] = useState<Record<string, string>>(role?.grants ?? {});
  const [name, setName] = useState(role?.name ?? "");
  const [mfa, setMfa] = useState(role?.requiresMfa ?? false);
  const [filter, setFilter] = useState("");
  const [newName, setNewName] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const editable = canManage && !!role && !role.isSystem;

  function pick(id: string) {
    const r = roles.find((x) => x.id === id)!;
    setSel(id); setDraft(r.grants); setName(r.name); setMfa(r.requiresMfa); setMsg(null);
  }
  const visible = useMemo(() => modules.map((m) => ({ ...m, permissions: m.permissions.filter((p) => !filter || (m.title + p.action + p.key + p.description).toLowerCase().includes(filter.toLowerCase())) })).filter((m) => m.permissions.length), [modules, filter]);
  const granted = Object.values(draft).filter(Boolean).length;

  async function run(p: Promise<{ ok: boolean; data: any; status: number }>, ok: string, after?: (d: any) => void) {
    setBusy(true); setMsg(null);
    const r = await p;
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r as any) });
    setMsg({ ok: true, text: ok });
    after?.(r.data);
    router.refresh();
  }
  const save = () => run(postJson(`/api/v1/roles/${sel}/grants`, { name, requiresMfa: mfa, grants: Object.entries(draft).filter(([, s]) => s).map(([permission, scope]) => ({ permission, scope })) }, "PUT"), "Saved. Users with this role get the change on their next request.");
  const duplicate = (copyFromRoleId: string, as: string) => run(postJson("/api/v1/roles", { name: as, copyFromRoleId }), "Role created.", (d) => d?.id && setSel(d.id));
  const create = () => run(postJson("/api/v1/roles", { name: newName, grants: [] }), "Role created: tick the permissions it should have.", () => setNewName(""));
  const remove = () => confirm(`Delete role "${role?.name}"?`) && run(postJson(`/api/v1/roles/${sel}/grants`, undefined, "DELETE"), "Role deleted.", () => setSel(roles.find((r) => r.id !== sel)?.id ?? ""));

  return (
    <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
      <aside className="flex flex-col gap-3">
        <div className="card p-2">
          <ul className="flex flex-col gap-0.5">
            {roles.map((r) => (
              <li key={r.id}><button type="button" onClick={() => pick(r.id)} className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${r.id === sel ? "btn" : "hover:opacity-80"}`}>
                <span className="truncate">{r.name}</span>{r.isSystem ? <span className="badge badge-gray">system</span> : <span className="badge">custom</span>}
              </button></li>
            ))}
          </ul>
        </div>
        {canManage && (
          <form className="card flex flex-col gap-2 p-3" onSubmit={(e) => { e.preventDefault(); create(); }}>
            <p className="text-sm font-semibold">New custom role</p>
            <input className="input" placeholder="e.g. Senior Agent" value={newName} onChange={(e) => setNewName(e.target.value)} required />
            <button className="btn" disabled={busy}>Create</button>
          </form>
        )}
      </aside>

      {role ? (
        <div className="flex min-w-0 flex-col gap-4">
          <div className="card flex flex-wrap items-end justify-between gap-3 p-4">
            <div className="min-w-[14rem] grow">
              {editable ? <input className="input text-lg font-semibold" value={name} onChange={(e) => setName(e.target.value)} aria-label="Role name" /> : <h2 className="text-lg font-semibold">{role.name}</h2>}
              <p className="muted mt-1 text-xs">{role.isSystem ? "System role: fixed by the seeder. Duplicate it to customise." : "Custom role."} {granted} permissions granted.</p>
              {editable && <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={mfa} onChange={(e) => setMfa(e.target.checked)} /> Require MFA for users with this role</label>}
            </div>
            <div className="flex flex-wrap gap-2">
              {canManage && role.isSystem && <button className="btn" disabled={busy} onClick={() => duplicate(role.id, `${role.name} (custom)`)}>Duplicate to customise</button>}
              {editable && <><button className="btn" disabled={busy} onClick={save}>{busy ? "Saving..." : "Save changes"}</button><button className="btn-ghost" disabled={busy} onClick={remove}>Delete</button></>}
            </div>
          </div>
          {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "" : "err"}`}>{msg.text}</p>}
          <input className="input" placeholder="Filter modules and actions..." value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter permissions" />
          <div className="grid gap-4 xl:grid-cols-2">
            {visible.map((m) => (
              <section key={m.module} className="card overflow-hidden">
                <header className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: "var(--border)", background: "var(--card-2)" }}>
                  <h3 className="font-semibold">{m.title}</h3>
                  <span className="badge badge-gray">{m.permissions.filter((p) => draft[p.key]).length}/{m.permissions.length}</span>
                </header>
                <ul>
                  {m.permissions.map((p) => (
                    <li key={p.key} className="flex items-center justify-between gap-3 border-b px-4 py-2 last:border-0" style={{ borderColor: "var(--border)" }}>
                      <span className="min-w-0 text-sm"><span className="font-medium">{p.action}</span><br /><span className="muted text-xs">{p.description}</span></span>
                      <select className="input w-40 shrink-0 py-1 text-sm" disabled={!editable} value={draft[p.key] ?? ""} onChange={(e) => setDraft({ ...draft, [p.key]: e.target.value })} aria-label={`${p.key} scope`}>
                        {SCOPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      ) : <p className="muted">No roles.</p>}
    </div>
  );
}

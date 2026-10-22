"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

interface Mod { key: string; label: string; group: string; description: string; core: boolean; requires: string[]; enabled: boolean; effective: boolean }
interface Setting { key: string; label: string; group: string; description: string; type: "boolean" | "number" | "choice"; value: boolean | number | string; min?: number; max?: number; choices?: string[]; module?: string }

export function ConfigClient({ modules, settings }: { modules: Mod[]; settings: Setting[] }) {
  const router = useRouter();
  const [mods, setMods] = useState(() => Object.fromEntries(modules.map((m) => [m.key, m.enabled])));
  const [vals, setVals] = useState(() => Object.fromEntries(settings.map((s) => [s.key, s.value])));
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const label = (k: string) => modules.find((m) => m.key === k)?.label ?? k;
  const groups = [...new Set(modules.map((m) => m.group))];
  const setGroups = [...new Set(settings.map((s) => s.group))];

  async function saveModule(key: string, on: boolean) {
    setBusy(key); setMsg(null);
    const r = await postJson("/api/v1/config/modules", { modules: { [key]: on } }, "PUT");
    setBusy(null);
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    setMods({ ...mods, [key]: on }); setMsg({ ok: true, text: `${label(key)} turned ${on ? "on" : "off"}.` }); router.refresh();
  }
  async function saveSettings(group: string) {
    setBusy(group); setMsg(null);
    const body = Object.fromEntries(settings.filter((s) => s.group === group).map((s) => [s.key, vals[s.key]]));
    const r = await postJson("/api/v1/config/settings", { settings: body }, "PUT");
    setBusy(null);
    setMsg(r.ok ? { ok: true, text: `${group} saved.` } : { ok: false, text: errMsg(r) });
  }

  return (
    <div className="flex flex-col gap-8">
      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "muted" : "err"}`}>{msg.text}</p>}
      {groups.map((g) => (
        <div key={g} className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">{g}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {modules.filter((m) => m.group === g).map((m) => {
              const blocked = m.requires.find((r) => !mods[r]);
              return (
                <label key={m.key} className="card flex cursor-pointer items-start gap-3 p-4">
                  <input type="checkbox" className="mt-1 h-4 w-4" checked={!!mods[m.key]} disabled={m.core || busy === m.key || (!mods[m.key] && !!blocked)} onChange={(e) => saveModule(m.key, e.target.checked)} />
                  <span className="text-sm">
                    <b>{m.label}</b>{m.core && <span className="badge badge-gray ml-2">always on</span>}
                    <span className="muted block">{m.description}</span>
                    {blocked && !mods[m.key] && <span className="err block text-xs">Needs {label(blocked)}.</span>}
                    {m.requires.length > 0 && !blocked && <span className="muted block text-xs">Works with {m.requires.map(label).join(", ")}.</span>}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
      <h2 className="-mb-4 text-lg font-semibold">Automation settings</h2>
      {setGroups.map((g) => (
        <div key={g} className="card flex flex-col gap-4 p-4">
          <h3 className="font-semibold">{g}</h3>
          {settings.filter((s) => s.group === g).map((s) => (
            <label key={s.key} className="flex flex-wrap items-start justify-between gap-3 text-sm">
              <span className="max-w-xl"><b>{s.label}</b><span className="muted block">{s.description}</span>{s.module && mods[s.module] === false && <span className="err block text-xs">{label(s.module)} is off, so this has no effect.</span>}</span>
              {s.type === "boolean" && <input type="checkbox" className="mt-1 h-4 w-4" checked={!!vals[s.key]} onChange={(e) => setVals({ ...vals, [s.key]: e.target.checked })} />}
              {s.type === "number" && <input className="input w-28" type="number" min={s.min} max={s.max} value={Number(vals[s.key])} onChange={(e) => setVals({ ...vals, [s.key]: Number(e.target.value) })} />}
              {s.type === "choice" && <select className="input w-40" value={String(vals[s.key])} onChange={(e) => setVals({ ...vals, [s.key]: e.target.value })}>{s.choices!.map((c) => <option key={c} value={c}>{c === "none" ? "No quiet hours" : c.replace("-", ":00 to ") + ":00"}</option>)}</select>}
            </label>
          ))}
          <div><button className="btn" disabled={busy === g} onClick={() => saveSettings(g)}>{busy === g ? "Saving..." : `Save ${g.toLowerCase()}`}</button></div>
        </div>
      ))}
    </div>
  );
}

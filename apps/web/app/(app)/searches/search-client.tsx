"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

const num = (v: string) => (v.trim() === "" ? undefined : Number(v));

export function SearchForm() {
  const router = useRouter();
  const [f, setF] = useState({ name: "", purpose: "sale", minPrice: "", maxPrice: "", bedrooms: "", communities: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const communities = f.communities.split(",").map((x) => x.trim()).filter(Boolean);
    const r = await postJson("/api/v1/saved-searches", {
      name: f.name, criteria: { purpose: f.purpose, minPrice: num(f.minPrice), maxPrice: num(f.maxPrice), bedrooms: num(f.bedrooms), ...(communities.length ? { communities } : {}) },
    });
    setBusy(false);
    if (!r.ok) return setError(errMsg(r));
    setF({ ...f, name: "" });
    router.refresh();
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <form onSubmit={submit} className="card flex flex-wrap items-end gap-3 p-4">
      <label className="grow text-sm">Name<input className="input mt-1 w-full" value={f.name} onChange={set("name")} required maxLength={160} placeholder="2BR Marina under 2.5M" /></label>
      <label className="text-sm">For<select className="input mt-1" value={f.purpose} onChange={set("purpose")}><option value="sale">Sale</option><option value="rent">Rent</option></select></label>
      <label className="text-sm">Min price<input className="input mt-1 w-28" inputMode="numeric" value={f.minPrice} onChange={set("minPrice")} /></label>
      <label className="text-sm">Max price<input className="input mt-1 w-28" inputMode="numeric" value={f.maxPrice} onChange={set("maxPrice")} /></label>
      <label className="text-sm">Bedrooms<input className="input mt-1 w-20" inputMode="numeric" value={f.bedrooms} onChange={set("bedrooms")} /></label>
      <label className="text-sm">Areas (comma separated)<input className="input mt-1" value={f.communities} onChange={set("communities")} placeholder="Marina, Downtown" /></label>
      <button className="btn" disabled={busy}>{busy ? "Saving..." : "Save search"}</button>
      {error && <p role="alert" className="err w-full text-sm">{error}</p>}
    </form>
  );
}

export function SearchRow({ id, name, status, criteria, canManage }: { id: string; name: string; status: string; criteria: any; canManage: boolean }) {
  const router = useRouter();
  const [results, setResults] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    const res = await fetch(`/api/v1/saved-searches/${id}/run`);
    const j = await res.json().catch(() => null);
    if (!res.ok) return setError(j?.error?.message ?? "Failed");
    setResults(j.results);
  }
  async function toggle() {
    const r = await postJson(`/api/v1/saved-searches/${id}/status`, { status: status === "active" ? "paused" : "active" });
    if (!r.ok) return setError(errMsg(r));
    router.refresh();
  }
  const summary = [criteria.purpose, criteria.bedrooms != null && `${criteria.bedrooms} bed`, criteria.maxPrice != null && `up to ${Number(criteria.maxPrice).toLocaleString("en-US")}`, criteria.communities?.join(", ")].filter(Boolean).join(" - ");

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><p className="font-medium">{name} <span className="muted text-xs">({status})</span></p><p className="muted text-xs">{summary || "Any listing"}</p></div>
        <div className="flex gap-2"><button className="btn-ghost text-sm" onClick={run}>Run now</button>{canManage && <button className="btn-ghost text-sm" onClick={toggle}>{status === "active" ? "Pause alerts" : "Resume alerts"}</button>}</div>
      </div>
      {error && <p role="alert" className="err text-sm">{error}</p>}
      {results && (
        <ul className="mt-3 space-y-1 text-sm">
          {results.map((r) => <li key={r.listingId}><strong>{r.score}%</strong> {r.title} - {r.currency} {Number(r.price).toLocaleString("en-US")} ({r.community ?? "-"}, {r.bedrooms ?? "-"} bed)</li>)}
          {results.length === 0 && <li className="muted">No published listing fits right now.</li>}
        </ul>
      )}
    </div>
  );
}

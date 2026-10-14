"use client";

import { useState } from "react";
import { errMsg, postJson } from "@/lib/client";

const aed = (n: number) => `AED ${Number(n).toLocaleString("en-US")}`;

export function ValuationForm({ units }: { units: Array<{ id: string; label: string }> }) {
  const [unitId, setUnitId] = useState(units[0]?.id ?? "");
  const [result, setResult] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    const r = await postJson(`/api/v1/units/${unitId}/valuation`);
    setBusy(false);
    if (!r.ok) return setError(errMsg(r));
    setResult(r.data);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="card flex flex-wrap items-end gap-3 p-4">
        <label className="grow text-sm">Unit<select className="input mt-1 w-full" value={unitId} onChange={(e) => setUnitId(e.target.value)}>{units.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}</select></label>
        <button className="btn" onClick={run} disabled={busy || !unitId}>{busy ? "Working..." : "Estimate value"}</button>
      </div>
      {error && <p role="alert" className="err text-sm">{error}</p>}
      {result && (
        <div className="card p-4">
          {result.sufficient ? (
            <>
              <p className="text-3xl font-semibold">{aed(result.estimate)}</p>
              <p className="muted text-sm">Range {aed(result.low)} to {aed(result.high)} - {aed(result.pricePerSqft)} per sq ft - confidence {result.confidence}</p>
            </>
          ) : <p className="font-medium">No estimate: {result.note}</p>}
          <p className="muted mt-1 text-xs">{result.note}</p>
          <table className="t mt-3">
            <thead><tr><th>Type</th><th>Unit</th><th>Beds</th><th>Area</th><th>Price</th><th>Per sq ft</th><th>Date</th></tr></thead>
            <tbody>{result.comps.map((c: any) => <tr key={c.ref}><td>{c.kind === "sold" ? "Closed deal" : "Asking"}</td><td>{c.unitNumber}</td><td>{c.bedrooms ?? "-"}</td><td>{c.areaSqft}</td><td>{aed(c.price)}</td><td>{Math.round(c.pricePerSqft).toLocaleString("en-US")}</td><td>{c.date}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

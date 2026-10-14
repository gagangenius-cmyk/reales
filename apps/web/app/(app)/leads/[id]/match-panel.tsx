"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export interface MatchRow { listingId: string; title: string; price: number; currency: string; bedrooms: number | null; community: string | null; unitNumber: string; score: number; reasons: string[]; status: string }

export function MatchPanel({ leadId, matches, canManage }: { leadId: string; matches: MatchRow[]; canManage: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function mark(listingId: string, status: "shared" | "dismissed") {
    setError(null);
    const r = await postJson(`/api/v1/leads/${leadId}/matches/${listingId}`, { status });
    if (!r.ok) return setError(errMsg(r));
    router.refresh();
  }

  return (
    <div className="card overflow-x-auto p-2">
      <h2 className="p-2 font-semibold">Matching listings</h2>
      <table className="t">
        <thead><tr><th>Match</th><th>Listing</th><th>Price</th><th>Beds</th><th>Area</th><th>Why</th><th /></tr></thead>
        <tbody>
          {matches.map((m) => (
            <tr key={m.listingId}>
              <td><strong>{m.score}%</strong></td><td>{m.title}<br /><span className="muted text-xs">Unit {m.unitNumber}</span></td>
              <td>{m.currency} {Number(m.price).toLocaleString("en-US")}</td><td>{m.bedrooms ?? "-"}</td><td>{m.community ?? "-"}</td>
              <td className="text-xs">{m.reasons.join("; ")}</td>
              <td className="whitespace-nowrap">
                {m.status === "shared" ? <span className="muted text-xs">Shared</span> : canManage && <button className="btn-ghost text-xs" onClick={() => mark(m.listingId, "shared")}>Mark shared</button>}
                {canManage && <button className="btn-ghost text-xs" onClick={() => mark(m.listingId, "dismissed")}>Dismiss</button>}
              </td>
            </tr>
          ))}
          {matches.length === 0 && <tr><td colSpan={7} className="muted">No published listing matches this lead's requirements yet.</td></tr>}
        </tbody>
      </table>
      {error && <p role="alert" className="err p-2 text-sm">{error}</p>}
    </div>
  );
}

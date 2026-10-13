"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function UnitStatusSelect({ unitId, status }: { unitId: string; status: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <select className="input py-1" value={status} aria-label="Unit status" onChange={async (e) => {
        setError(null);
        const r = await postJson(`/api/v1/units/${unitId}/status`, { status: e.target.value });
        if (!r.ok) setError(errMsg(r));
        router.refresh();
      }}>
        {["available", "reserved", "sold", "rented", "blocked"].map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      {error && <span role="alert" className="err block text-xs">{error}</span>}
    </span>
  );
}

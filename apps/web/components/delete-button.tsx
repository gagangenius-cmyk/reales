"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

/** Moves a record to Trash (soft delete) after a confirmation; it can be restored from /trash. */
export function DeleteButton({ entity, id, name, redirectTo, small = true }: { entity: string; id: string; name: string; redirectTo?: string; small?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    if (!confirm(`Move "${name}" to Trash? You can restore it later from Trash.`)) return;
    setBusy(true); setError(null);
    const r = await postJson("/api/v1/trash", { entity, id });
    setBusy(false);
    if (!r.ok) return setError(errMsg(r));
    if (redirectTo) router.push(redirectTo); else router.refresh();
  }
  return (
    <span className="inline-flex flex-col">
      <button type="button" className={`btn-ghost err ${small ? "text-xs" : ""}`} disabled={busy} onClick={go}>{busy ? "Deleting..." : "Delete"}</button>
      {error && <span role="alert" className="err text-xs">{error}</span>}
    </span>
  );
}

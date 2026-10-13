"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function ViewingActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  async function act(path: string, body?: unknown) {
    setError(null);
    const r = await postJson(`/api/v1/viewings/${id}/${path}`, body);
    if (!r.ok) return setError(errMsg(r));
    router.refresh();
  }
  return (
    <div className="flex flex-wrap gap-2">
      {status === "scheduled" && <button className="btn-ghost text-xs" onClick={() => act("check-in")}>Check in</button>}
      <button className="btn text-xs" onClick={() => act("complete", { rating: 4, interest: "medium" })}>Complete</button>
      <button className="btn-ghost text-xs" onClick={() => { const reason = window.prompt("Reason for cancelling?"); if (reason) act("cancel", { reason }); }}>Cancel</button>
      {error && <p role="alert" className="err w-full text-xs">{error}</p>}
    </div>
  );
}

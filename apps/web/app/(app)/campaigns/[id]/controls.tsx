"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function CampaignControls({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  async function act(path: string, body: unknown = {}) {
    setError(null);
    const r = await postJson(`/api/v1/campaigns/${id}/${path}`, body);
    if (!r.ok) return setError(errMsg(r));
    router.refresh();
  }
  return (
    <div className="card flex flex-wrap items-center gap-3 p-4">
      {status === "draft" && <button className="btn" onClick={() => act("schedule")}>Schedule now</button>}
      {status === "running" && <button className="btn-ghost" onClick={() => act("pause")}>Pause</button>}
      {status === "paused" && <button className="btn" onClick={() => act("resume")}>Resume</button>}
      {["draft", "scheduled", "running", "paused", "preparing"].includes(status) && <button className="btn-ghost" onClick={() => { const reason = window.prompt("Why is this campaign being cancelled?"); if (reason) act("cancel", { reason }); }}>Cancel</button>}
      {error && <p role="alert" className="err text-sm">{error}</p>}
    </div>
  );
}

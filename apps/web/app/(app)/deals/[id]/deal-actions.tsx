"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

interface Props { dealId: string; nextStage?: string | null; milestoneKey?: string; needsReason?: boolean; canUpdate?: boolean; canClose?: boolean }

export function DealActions({ dealId, nextStage, milestoneKey, needsReason, canUpdate, canClose }: Props) {
  const router = useRouter();
  const [msgs, setMsgs] = useState<string[]>([]);

  async function run(path: string, body: unknown) {
    setMsgs([]);
    const r = await postJson(`/api/v1/deals/${dealId}/${path}`, body);
    if (r.status === 422 && r.data?.error?.reasons) return setMsgs(r.data.error.reasons);
    if (!r.ok) return setMsgs([errMsg(r)]);
    router.refresh();
  }

  if (milestoneKey) {
    return (
      <span>
        <button className="btn-ghost text-xs" onClick={() => {
          const reason = needsReason ? window.prompt("Reason for completing this manually (audited)?") : undefined;
          if (needsReason && !reason) return;
          run(`milestones/${milestoneKey}/complete`, reason ? { reason } : {});
        }}>{needsReason && !canClose ? "Needs manager" : "Mark done"}</button>
        {msgs.map((m) => <span key={m} role="alert" className="err block text-xs">{m}</span>)}
      </span>
    );
  }
  return (
    <div className="card flex flex-wrap items-center gap-3 p-4">
      {nextStage && canUpdate && <button className="btn" onClick={() => run("stage", { to: nextStage })}>Advance to {nextStage}</button>}
      {canClose && <button className="btn-ghost" onClick={() => { const reason = window.prompt("Reason for cancelling this deal?"); if (reason) run("cancel", { reason }); }}>Cancel deal</button>}
      {msgs.length > 0 && <ul role="alert" className="err list-disc pl-4 text-sm">{msgs.map((m) => <li key={m}>{m}</li>)}</ul>}
    </div>
  );
}

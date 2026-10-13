"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function ApproveButtons({ id }: { id: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  async function act(outcome: "approved" | "rejected") {
    setError(null);
    const r = await postJson(`/api/v1/templates/${id}/approve`, { outcome });
    if (!r.ok) return setError(errMsg(r));
    router.refresh();
  }
  return <span className="flex gap-2"><button className="btn text-xs" onClick={() => act("approved")}>Approve</button><button className="btn-ghost text-xs" onClick={() => act("rejected")}>Reject</button>{error && <span role="alert" className="err text-xs">{error}</span>}</span>;
}

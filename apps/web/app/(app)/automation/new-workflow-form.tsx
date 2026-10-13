"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function NewWorkflowForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await postJson("/api/v1/workflows", { name });
    if (!r.ok) return setError(errMsg(r));
    router.push(`/automation/${r.data.id}`);
  }
  return (
    <form onSubmit={submit} className="card mt-4 flex flex-wrap items-center gap-3 p-4">
      <input className="input max-w-sm" placeholder="Workflow name" value={name} onChange={(e) => setName(e.target.value)} required aria-label="Workflow name" />
      <button className="btn">Create</button>
      {error && <p role="alert" className="err text-sm">{error}</p>}
    </form>
  );
}

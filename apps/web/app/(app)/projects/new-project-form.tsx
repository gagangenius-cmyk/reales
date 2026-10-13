"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function NewProjectForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("project");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await postJson("/api/v1/projects", { code, name, kind });
    if (!r.ok) return setError(errMsg(r));
    setCode(""); setName("");
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="card mt-4 grid gap-3 p-4 md:grid-cols-5">
      <input className="input" placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} required aria-label="Code" />
      <input className="input md:col-span-2" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required aria-label="Name" />
      <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
        <option value="project">Project</option><option value="portfolio">Portfolio</option><option value="workspace">Workspace</option>
      </select>
      <button className="btn">Add</button>
      {error && <p role="alert" className="err text-sm md:col-span-5">{error}</p>}
    </form>
  );
}

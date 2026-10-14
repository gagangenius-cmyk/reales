"use client";

import { useState } from "react";
import { errMsg, postJson } from "@/lib/client";

/** Open the generated PDF, or keep a copy in the document store (immutable, hashed, access-controlled). */
export function PdfActions({ href, kind, id, label }: { href: string; kind: "receipt" | "lease_contract" | "owner_statement" | "offer_letter"; id: string; label: string }) {
  const [state, setState] = useState<string | null>(null);
  async function save() {
    setState("Saving...");
    const r = await postJson("/api/v1/documents/generate", { kind, id });
    setState(r.ok ? "Saved to documents" : errMsg(r));
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <a className="btn-ghost text-xs" href={href} target="_blank" rel="noopener">{label}</a>
      <button className="btn-ghost text-xs" onClick={save}>Save to documents</button>
      {state && <span className="muted text-xs" role="status">{state}</span>}
    </span>
  );
}

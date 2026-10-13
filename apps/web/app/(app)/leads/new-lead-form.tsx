"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function NewLeadForm() {
  const router = useRouter();
  const [f, setF] = useState({ firstName: "", phone: "", email: "", purpose: "buy", budgetMax: "" });
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const contact = Object.fromEntries(Object.entries({ firstName: f.firstName, phone: f.phone, email: f.email }).filter(([, v]) => v.trim()));
    const r = await postJson("/api/v1/leads", { contact, purpose: f.purpose, sourceCode: "walk_in", ...(f.budgetMax ? { budgetMax: Number(f.budgetMax) } : {}) });
    if (!r.ok) return setMsg({ text: errMsg(r), ok: false });
    setMsg({ ok: true, text: r.data.duplicate ? "Repeat enquiry: added to the existing open lead." : r.data.assignedUserId ? "Lead created and routed." : "Lead created (no agent was eligible, so it is unassigned)." });
    setF({ firstName: "", phone: "", email: "", purpose: "buy", budgetMax: "" });
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="card mt-4 grid gap-3 p-4 md:grid-cols-6">
      <input className="input" placeholder="Name" value={f.firstName} onChange={set("firstName")} aria-label="Name" />
      <input className="input" placeholder="Phone" value={f.phone} onChange={set("phone")} aria-label="Phone" />
      <input className="input" type="email" placeholder="Email" value={f.email} onChange={set("email")} aria-label="Email" />
      <select className="input" value={f.purpose} onChange={set("purpose")} aria-label="Purpose">
        <option value="buy">Buy</option><option value="rent">Rent</option><option value="invest">Invest</option><option value="off_plan">Off-plan</option>
      </select>
      <input className="input" type="number" min="0" placeholder="Max budget (AED)" value={f.budgetMax} onChange={set("budgetMax")} aria-label="Max budget" />
      <button className="btn">Add lead</button>
      {msg && <p role={msg.ok ? "status" : "alert"} className={`${msg.ok ? "muted" : "err"} text-sm md:col-span-6`}>{msg.text}</p>}
    </form>
  );
}

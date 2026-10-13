"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function NewContactForm() {
  const router = useRouter();
  const [f, setF] = useState({ firstName: "", lastName: "", phone: "", email: "" });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body = Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim()));
    const r = await postJson("/api/v1/contacts", body);
    if (r.status === 409 && r.data?.error?.code === "duplicate_contact") {
      const m = r.data.error;
      return setError(m.matches.length ? `Already exists: ${m.matches.map((x: any) => x.name).join(", ")}` : `A contact with this phone or email already exists (${m.matchCount}).`);
    }
    if (!r.ok) return setError(errMsg(r));
    setF({ firstName: "", lastName: "", phone: "", email: "" });
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="card mt-4 grid gap-3 p-4 md:grid-cols-5">
      <input className="input" placeholder="First name" value={f.firstName} onChange={set("firstName")} aria-label="First name" />
      <input className="input" placeholder="Last name" value={f.lastName} onChange={set("lastName")} aria-label="Last name" />
      <input className="input" placeholder="Phone (05x...)" value={f.phone} onChange={set("phone")} aria-label="Phone" />
      <input className="input" type="email" placeholder="Email" value={f.email} onChange={set("email")} aria-label="Email" />
      <button className="btn">Add contact</button>
      {error && <p role="alert" className="err text-sm md:col-span-5">{error}</p>}
    </form>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function TaskForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await postJson("/api/v1/tasks", { title, ...(due ? { dueAt: new Date(due).toISOString() } : {}) });
    if (!r.ok) return setError(errMsg(r));
    setTitle(""); setDue("");
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="card flex flex-wrap items-end gap-3 p-4">
      <label className="grow text-sm">New task<input className="input mt-1 w-full" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={255} placeholder="Call back the buyer about the Marina 2BR" /></label>
      <label className="text-sm">Due<input className="input mt-1" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></label>
      <button className="btn">Add task</button>
      {error && <p role="alert" className="err w-full text-sm">{error}</p>}
    </form>
  );
}

export function TaskRow({ id, title, dueAt, overdue, leadId }: { id: string; title: string; dueAt: string | null; overdue: boolean; leadId: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  async function complete() {
    const r = await postJson(`/api/v1/tasks/${id}/complete`);
    if (!r.ok) return setError(errMsg(r));
    router.refresh();
  }
  async function reschedule() {
    const v = window.prompt("New due date and time (YYYY-MM-DD HH:MM), empty to clear");
    if (v === null) return;
    const when = v.trim() ? new Date(v.trim().replace(" ", "T")) : null;
    if (when && isNaN(+when)) return setError("That is not a valid date");
    const r = await postJson(`/api/v1/tasks/${id}/reschedule`, { dueAt: when ? when.toISOString() : null });
    if (!r.ok) return setError(errMsg(r));
    router.refresh();
  }
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
      <div>
        <p className={overdue ? "err font-medium" : "font-medium"}>{title}</p>
        <p className="muted text-xs">{dueAt ? `Due ${new Date(dueAt).toISOString().slice(0, 16).replace("T", " ")}${overdue ? " - overdue" : ""}` : "No due date"}{leadId && <> - <Link className="underline" href={`/leads/${leadId}`}>lead</Link></>}</p>
        {error && <p role="alert" className="err text-xs">{error}</p>}
      </div>
      <div className="flex gap-2"><button className="btn-ghost text-xs" onClick={reschedule}>Reschedule</button><button className="btn text-xs" onClick={complete}>Done</button></div>
    </li>
  );
}

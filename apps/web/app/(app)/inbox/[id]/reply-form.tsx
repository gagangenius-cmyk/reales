"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

const REASONS: Record<string, string> = {
  no_consent: "This person has not consented to this kind of message.",
  no_destination: "There is no address for this channel.",
  contact_archived: "This contact is archived.",
};

export function ReplyForm({ contactId, channel }: { contactId: string; channel: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Replies inside an open conversation are service messages (contract basis), still subject to suppression.
    const r = await postJson("/api/v1/messages", { contactId, channel, purposeCode: "service", body });
    if (r.status === 422 && r.data?.blockedReasons) return setError(r.data.blockedReasons.map((x: string) => (x.startsWith("suppressed:") ? "This person has opted out." : REASONS[x] ?? x)).join(" "));
    if (!r.ok) return setError(errMsg(r));
    setBody("");
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="card flex flex-col gap-2 p-4">
      <textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a reply" required aria-label="Reply" />
      <div className="flex items-center gap-3"><button className="btn">Send</button>{error && <p role="alert" className="err text-sm">{error}</p>}</div>
    </form>
  );
}

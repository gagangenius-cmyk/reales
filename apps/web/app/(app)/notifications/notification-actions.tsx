"use client";

import { useRouter } from "next/navigation";
import { postJson } from "@/lib/client";

/** With `id`: mark one read. Without: mark everything read. */
export function NotificationActions({ id, unread }: { id?: string; unread?: number }) {
  const router = useRouter();
  async function go() {
    await postJson(id ? `/api/v1/notifications/${id}/read` : "/api/v1/notifications/read-all");
    router.refresh();
  }
  if (!id && !unread) return null;
  return <button className="btn-ghost text-xs" onClick={go}>{id ? "Mark read" : `Mark all read (${unread})`}</button>;
}

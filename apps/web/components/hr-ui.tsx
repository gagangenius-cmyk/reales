"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(call: () => Promise<{ ok: boolean; data: any; status: number }>, done: string, then?: (d: any) => void) {
    setBusy(true); setMsg(null);
    const r = await call();
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: errMsg(r as never) }); return false; }
    setMsg({ ok: true, text: done }); router.refresh(); then?.(r.data);
    return true;
  }
  const Msg = () => (msg ? <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "muted" : "err"}`}>{msg.text}</p> : null);
  return { busy, msg, run, Msg, router, post: postJson };
}

export const Lbl = ({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) => <label className={`flex flex-col gap-1.5 text-sm ${wide ? "sm:col-span-2" : ""}`}><span className="muted text-xs font-medium">{label}</span>{children}</label>;
export const hm = (min: number) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
export const timeDubai = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" }) : "-");
export const dayDubai = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });

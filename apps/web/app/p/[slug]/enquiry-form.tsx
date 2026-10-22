"use client";

import { useState } from "react";
import { st, type SiteLang } from "@/lib/site-i18n";

/** Public enquiry form. A hidden `website` field is a honeypot for bots; the server also rate-limits per IP. */
export function EnquiryForm({ token, lang }: { token: string; lang: SiteLang }) {
  const [f, setF] = useState({ name: "", phone: "", email: "", message: "", website: "" });
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!f.name.trim() || (!f.phone.trim() && !f.email.trim())) { setState("error"); return setMsg(st(lang, "required")); }
    setState("busy");
    try {
      const r = await fetch("/api/v1/public/enquiry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, ...f }) });
      if (!r.ok) { const j = await r.json().catch(() => null); setState("error"); return setMsg(j?.error?.message ?? st(lang, "failed")); }
      setState("done");
    } catch { setState("error"); setMsg(st(lang, "failed")); }
  }
  if (state === "done") return <p role="status" style={{ padding: 16, borderRadius: 12, background: "color-mix(in srgb, var(--pf) 10%, #fff)", fontSize: ".92rem" }}>{st(lang, "sent")}</p>;
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
      <input className="pf-in" placeholder={st(lang, "yourName")} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} aria-label={st(lang, "yourName")} autoComplete="name" />
      <input className="pf-in" placeholder={st(lang, "phone")} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" maxLength={40} aria-label={st(lang, "phone")} autoComplete="tel" />
      <input className="pf-in" type="email" placeholder={st(lang, "email")} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={254} aria-label={st(lang, "email")} autoComplete="email" />
      <textarea className="pf-in" style={{ minHeight: 96 }} placeholder={st(lang, "message")} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} maxLength={2000} aria-label={st(lang, "message")} />
      <input tabIndex={-1} autoComplete="off" aria-hidden="true" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} style={{ position: "absolute", left: "-9999px", height: 0, width: 0, opacity: 0 }} name="website" />
      <button className="pf-btn" disabled={state === "busy"}>{st(lang, "send")}</button>
      {state === "error" && <p role="alert" style={{ color: "#dc2626", fontSize: ".88rem" }}>{msg}</p>}
    </form>
  );
}

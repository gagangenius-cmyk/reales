"use client";

import { useState } from "react";

const T = {
  en: { name: "Your name", phone: "Phone", email: "Email", message: "How can we help?", purpose: "I want to", buy: "Buy", rent: "Rent", invest: "Invest", off_plan: "Buy off-plan", send: "Send", sent: "Thank you. We will be in touch shortly.", required: "Please give your name and a phone number or email.", failed: "Something went wrong. Please try again." },
  ar: { name: "الاسم", phone: "الهاتف", email: "البريد الإلكتروني", message: "كيف يمكننا مساعدتك؟", purpose: "أرغب في", buy: "الشراء", rent: "الإيجار", invest: "الاستثمار", off_plan: "الشراء على الخارطة", send: "إرسال", sent: "شكراً لك. سنتواصل معك قريباً.", required: "يرجى إدخال الاسم ورقم الهاتف أو البريد الإلكتروني.", failed: "حدث خطأ. يرجى المحاولة مرة أخرى." },
};

/** Public lead form. A hidden `website` field is a honeypot for bots; the server also rate-limits per IP. */
export function LeadForm({ publicId, lang, defaultPurpose }: { publicId: string; lang: "en" | "ar"; defaultPurpose: string }) {
  const t = T[lang];
  const [f, setF] = useState({ name: "", phone: "", email: "", message: "", purpose: defaultPurpose, website: "" });
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!f.name.trim() || (!f.phone.trim() && !f.email.trim())) { setState("error"); return setMsg(t.required); }
    setState("busy");
    try {
      const r = await fetch("/api/v1/public/lead-form", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicId, ...f }) });
      if (!r.ok) { const j = await r.json().catch(() => null); setState("error"); return setMsg(j?.error?.message ?? t.failed); }
      setState("done");
    } catch { setState("error"); setMsg(t.failed); }
  }
  if (state === "done") return <p role="status" style={{ padding: 16, borderRadius: 12, background: "color-mix(in srgb, var(--pf) 10%, #fff)" }}>{t.sent}</p>;
  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
      <input className="pf-in" placeholder={t.name} aria-label={t.name} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} autoComplete="name" />
      <input className="pf-in" placeholder={t.phone} aria-label={t.phone} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" maxLength={40} autoComplete="tel" />
      <input className="pf-in" type="email" placeholder={t.email} aria-label={t.email} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={254} autoComplete="email" />
      <select className="pf-in" aria-label={t.purpose} value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}>{(["buy", "rent", "invest", "off_plan"] as const).map((p) => <option key={p} value={p}>{t[p]}</option>)}</select>
      <textarea className="pf-in" style={{ minHeight: 90 }} placeholder={t.message} aria-label={t.message} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} maxLength={2000} />
      <input tabIndex={-1} autoComplete="off" aria-hidden="true" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} style={{ position: "absolute", left: "-9999px", height: 0, width: 0, opacity: 0 }} name="website" />
      <button className="pf-btn" disabled={state === "busy"}>{t.send}</button>
      {state === "error" && <p role="alert" style={{ color: "#dc2626", fontSize: ".88rem" }}>{msg}</p>}
    </form>
  );
}

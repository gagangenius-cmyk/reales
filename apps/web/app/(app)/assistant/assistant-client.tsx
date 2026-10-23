"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { errMsg, postJson } from "@/lib/client";

interface Reply { answer: string; items: { title: string; subtitle?: string; href: string }[]; link?: { label: string; href: string }; suggestions: string[] }
interface Turn { q: string; a?: Reply; error?: string }

export function AssistantClient() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const last = turns[turns.length - 1]?.a;
  async function ask(message: string) {
    if (!message.trim() || busy) return;
    setBusy(true); setText("");
    setTurns((t) => [...t, { q: message.trim() }]);
    const r = await postJson("/api/v1/assistant", { message: message.trim() });
    setTurns((t) => t.map((x, i) => (i === t.length - 1 ? (r.ok ? { ...x, a: r.data as Reply } : { ...x, error: errMsg(r) }) : x)));
    setBusy(false);
    setTimeout(() => end.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4">
        {turns.length === 0 && <p className="muted text-sm">Try one of the suggestions below, or type your own question.</p>}
        {turns.map((t, i) => (
          <div key={i} className="flex flex-col gap-2">
            <p className="ml-auto max-w-xl rounded-2xl rounded-br-sm px-4 py-2 text-sm text-white" style={{ background: "var(--accent)" }}>{t.q}</p>
            {t.a && (
              <div className="card max-w-2xl p-4 text-sm">
                <p>{t.a.answer}</p>
                {t.a.items.length > 0 && <ul className="mt-2 flex flex-col gap-1.5">{t.a.items.map((x, j) => <li key={j}><Link href={x.href} className="font-medium">{x.title}</Link>{x.subtitle && <span className="muted"> {x.subtitle}</span>}</li>)}</ul>}
                {t.a.link && <Link href={t.a.link.href} className="btn-ghost mt-3 inline-block text-xs">{t.a.link.label}</Link>}
              </div>
            )}
            {t.error && <p role="alert" className="err text-sm">{t.error}</p>}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="flex flex-wrap gap-2">{(last?.suggestions ?? ["hot leads", "follow-ups overdue", "new leads today", "listings expiring this week", "who is on leave today"]).map((s) => <button key={s} className="btn-ghost text-xs" onClick={() => ask(s)} disabled={busy}>{s}</button>)}</div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
        <input className="input grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about leads, listings or your team" maxLength={200} aria-label="Ask the assistant" autoFocus />
        <button className="btn" disabled={busy || !text.trim()}>Ask</button>
      </form>
    </div>
  );
}

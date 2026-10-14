"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

export const STARTER = {
  nodes: [
    { id: "start", type: "bot.start", config: {} },
    { id: "hello", type: "bot.message", config: { text: "Hi! I can help you find a property." } },
    { id: "name", type: "bot.ask", config: { variable: "name", prompt: "What is your name?", validate: "text" } },
    { id: "intent", type: "bot.ask", config: { variable: "intent", prompt: "Are you looking to buy or rent?", validate: "choice", choices: ["buy", "rent"] } },
    { id: "bye", type: "bot.end", config: { text: "Thanks {{name}}, an agent will contact you shortly." } },
  ],
  edges: [{ source: "start", target: "hello" }, { source: "hello", target: "name" }, { source: "name", target: "intent" }, { source: "intent", target: "bye" }],
};

export function NewBotForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [channel, setChannel] = useState("whatsapp");
  const [error, setError] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const r = await postJson("/api/v1/bots", { name, channel, graph: STARTER });
    if (!r.ok) return setError(errMsg(r));
    router.push(`/bots/${r.data.id}`);
  }
  return (
    <form onSubmit={submit} className="card flex flex-wrap items-end gap-3 p-4">
      <label className="grow text-sm">New bot<input className="input mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} required maxLength={160} /></label>
      <label className="text-sm">Channel<select className="input mt-1" value={channel} onChange={(e) => setChannel(e.target.value)}><option>whatsapp</option><option>sms</option><option>email</option></select></label>
      <button className="btn">Create from starter flow</button>
      {error && <p role="alert" className="err w-full text-sm">{error}</p>}
    </form>
  );
}

export function BotEditor({ bot, contacts, canManage }: { bot: any; contacts: Array<{ id: string; label: string }>; canManage: boolean }) {
  const router = useRouter();
  const [text, setText] = useState(JSON.stringify(bot.draftGraph ?? STARTER, null, 2));
  const [issues, setIssues] = useState<Array<{ message: string; nodeId?: string }>>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [contactId, setContactId] = useState(contacts[0]?.id ?? "");
  const [chat, setChat] = useState<Array<{ who: "bot" | "you" | "system"; text: string }>>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");

  function parse() { try { return JSON.parse(text); } catch (e) { setMsg({ ok: false, text: `That is not valid JSON: ${(e as Error).message}` }); return null; } }
  async function save() {
    const graph = parse(); if (!graph) return;
    setMsg(null);
    const r = await postJson(`/api/v1/bots/${bot.id}`, { graph }, "PUT");
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    setIssues(r.data.issues);
    setMsg({ ok: r.data.issues.length === 0, text: r.data.issues.length ? `Saved as a draft with ${r.data.issues.length} problem(s) to fix before publishing.` : "Saved. No problems found." });
  }
  async function publish() {
    const r = await postJson(`/api/v1/bots/${bot.id}/publish`);
    if (!r.ok) { setIssues(r.data?.error?.issues ?? []); return setMsg({ ok: false, text: errMsg(r) }); }
    setIssues([]); setMsg({ ok: true, text: `Published version ${r.data.currentVersion}.` }); router.refresh();
  }
  async function toggle() {
    const r = await postJson(`/api/v1/bots/${bot.id}/status`, { status: bot.status === "published" ? "disabled" : "published" });
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    router.refresh();
  }
  const push = (replies: string[]) => setChat((c) => [...c, ...replies.map((t) => ({ who: "bot" as const, text: t }))]);
  async function start() {
    setChat([]);
    const r = await postJson("/api/v1/bot-sessions", { botId: bot.id, contactId });
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    setSessionId(r.data.status === "active" ? r.data.sessionId : null);
    push(r.data.replies);
    if (r.data.status !== "active") setChat((c) => [...c, { who: "system", text: `Session ${r.data.status}${r.data.handoffReason ? `: ${r.data.handoffReason}` : ""}` }]);
  }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!sessionId || !input.trim()) return;
    const t = input; setInput("");
    setChat((c) => [...c, { who: "you", text: t }]);
    const r = await postJson(`/api/v1/bot-sessions/${sessionId}/messages`, { text: t });
    if (!r.ok) return setMsg({ ok: false, text: errMsg(r) });
    push(r.data.replies);
    if (r.data.status !== "active") { setSessionId(null); setChat((c) => [...c, { who: "system", text: `Session ${r.data.status}${r.data.handoffReason ? `: ${r.data.handoffReason}` : ""}` }]); }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="card flex flex-col gap-3 p-4">
        <h2 className="font-semibold">Flow definition</h2>
        <textarea className="input h-96 w-full font-mono text-xs" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} readOnly={!canManage} aria-label="Bot flow JSON" />
        {canManage && <div className="flex flex-wrap gap-2"><button className="btn-ghost" onClick={save}>Save draft</button><button className="btn" onClick={publish}>Publish</button>{bot.currentVersion > 0 && <button className="btn-ghost" onClick={toggle}>{bot.status === "published" ? "Disable" : "Enable"}</button>}</div>}
        {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "" : "err"}`}>{msg.text}</p>}
        {issues.length > 0 && <ul className="err list-disc pl-5 text-xs">{issues.map((i, k) => <li key={k}>{i.nodeId ? `${i.nodeId}: ` : ""}{i.message}</li>)}</ul>}
        <p className="muted text-xs">Nodes: bot.start, bot.message, bot.ask (text/number/phone/email/choice), bot.branch, bot.ai_answer, bot.handoff, bot.end. A loop must pass through a question.</p>
      </div>
      {canManage && (
        <div className="card flex flex-col gap-3 p-4">
          <h2 className="font-semibold">Test console (published version)</h2>
          <p className="muted text-xs">Runs the real flow against a contact. A handoff creates a real task for the contact's owner.</p>
          <div className="flex gap-2"><select className="input grow" value={contactId} onChange={(e) => setContactId(e.target.value)}>{contacts.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select><button className="btn" onClick={start} disabled={bot.status !== "published" || !contactId}>Start</button></div>
          <div className="h-64 overflow-auto rounded border p-2 text-sm" aria-live="polite">
            {chat.map((m, i) => <p key={i} className={m.who === "you" ? "text-right" : m.who === "system" ? "muted text-center text-xs" : ""}><span className={m.who === "bot" ? "inline-block rounded bg-gray-100 px-2 py-1 dark:bg-gray-800" : ""}>{m.text}</span></p>)}
            {chat.length === 0 && <p className="muted">Start a session to chat.</p>}
          </div>
          <form onSubmit={send} className="flex gap-2"><input className="input grow" value={input} onChange={(e) => setInput(e.target.value)} disabled={!sessionId} placeholder="Type as the customer" /><button className="btn" disabled={!sessionId}>Send</button></form>
        </div>
      )}
    </div>
  );
}

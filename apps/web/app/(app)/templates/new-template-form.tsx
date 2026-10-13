"use client";

import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { EditorRef } from "react-email-editor";
import { errMsg, postJson } from "@/lib/client";

// Unlayer's embedded editor (browser-only). Its design JSON is the editable source; the exported HTML is the immutable snapshot we send.
const EmailEditor = dynamic(() => import("react-email-editor"), { ssr: false });

export function NewTemplateForm() {
  const router = useRouter();
  const editor = useRef<EditorRef>(null);
  const [name, setName] = useState("");
  const [channel, setChannel] = useState("sms");
  const [purpose, setPurpose] = useState("marketing");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  async function exportEmail(): Promise<{ html: string; designJson: unknown } | null> {
    return new Promise((resolve) => {
      if (!editor.current?.editor) return resolve(null);
      editor.current.editor.exportHtml((d: any) => resolve({ html: d.html, designJson: d.design }));
    });
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setIssues([]);
    const base = { name, channel, purpose };
    let body: Record<string, unknown>;
    if (channel === "email") {
      const ex = await exportEmail();
      body = { ...base, subject, html: ex?.html ?? text, designJson: ex?.designJson, text: text || undefined };
    } else if (channel === "whatsapp") body = { ...base, components: { body: { text } } };
    else body = { ...base, text };
    const r = await postJson("/api/v1/templates", body);
    if (r.status === 422 && r.data?.error?.issues) return setIssues(r.data.error.issues.map((i: any) => i.message));
    if (!r.ok) return setError(errMsg(r));
    setName(""); setText(""); setSubject("");
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="card mt-4 flex flex-col gap-3 p-4">
      <div className="grid gap-3 md:grid-cols-4">
        <input className="input" placeholder="Template name" value={name} onChange={(e) => setName(e.target.value)} required aria-label="Name" />
        <select className="input" value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel"><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option><option value="email">Email</option></select>
        <input className="input" placeholder="Consent purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-label="Consent purpose" />
        {channel === "email" && <input className="input" placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />}
      </div>
      {channel === "email" ? (
        <div style={{ height: 520 }} aria-label="Email designer"><EmailEditor ref={editor} minHeight="500px" /></div>
      ) : (
        <textarea className="input" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Message text. Use variables like {{ contact.first_name }}" required aria-label="Message text" />
      )}
      <p className="muted text-xs">Variables: contact.first_name, contact.last_name, agent.name, listing.title, listing.price, unit.number, project.name ...</p>
      <div><button className="btn">Save template</button></div>
      {error && <p role="alert" className="err text-sm">{error}</p>}
      {issues.length > 0 && <ul role="alert" className="err list-disc pl-4 text-sm">{issues.map((i) => <li key={i}>{i}</li>)}</ul>}
    </form>
  );
}

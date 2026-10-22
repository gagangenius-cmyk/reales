"use client";

import { useState } from "react";
import { Lbl, useAction } from "@/components/hr-ui";

interface Tpl { id: string; kind: string; name: string; subject: string; body: string; active: boolean }
interface Letter { id: string; number: string; employeeName: string; employeeNo: string; kind: string; subject: string; body: string; status: string; emailedTo: string | null; emailError: string | null; createdAt: string }
interface Emp { id: string; name: string; no: string; email: string | null }

export function LettersClient({ templates, letters, employees, kinds, variables, preselect, canSalary, canTemplates }: { templates: Tpl[]; letters: Letter[]; employees: Emp[]; kinds: { kind: string; label: string }[]; variables: string[]; preselect?: string; canSalary: boolean; canTemplates: boolean }) {
  const { busy, run, Msg, post } = useAction();
  const label = (k: string) => kinds.find((x) => x.kind === k)?.label ?? k;
  const [f, setF] = useState({ employeeId: preselect ?? employees[0]?.id ?? "", templateId: templates.find((t) => t.active)?.id ?? "", reason: "", purpose: "", effective_date: "", signatory: "" });
  const tpl = templates.find((t) => t.id === f.templateId);
  const needs = (k: string) => !!tpl && new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`).test(tpl.subject + tpl.body);
  const salaryTpl = !!tpl && /\{\{\s*salary\./.test(tpl.subject + tpl.body);
  const [edit, setEdit] = useState<Letter | null>(null);
  const [draft, setDraft] = useState({ subject: "", body: "" });
  const [mail, setMail] = useState<{ id: string; to: string } | null>(null);
  const [t, setT] = useState<Tpl | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const vars = Object.fromEntries(Object.entries({ reason: f.reason, purpose: f.purpose, effective_date: f.effective_date, signatory: f.signatory }).filter(([, v]) => v.trim()));
    await run(() => post("/api/v1/hr/letters", { employeeId: f.employeeId, templateId: f.templateId, vars }), "Draft created. Review it below.", (d) => { setEdit({ ...d, employeeName: "", employeeNo: "" }); setDraft({ subject: d.subject, body: d.body }); });
  }
  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={create} className="card grid gap-3 p-4 sm:grid-cols-3">
        <h2 className="font-semibold sm:col-span-3">New letter</h2>
        <Lbl label="Employee"><select className="input" value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}>{employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.no})</option>)}</select></Lbl>
        <Lbl label="Letter" wide><select className="input" value={f.templateId} onChange={(e) => setF({ ...f, templateId: e.target.value })}>{templates.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{label(x.kind)}: {x.name}</option>)}</select></Lbl>
        {needs("reason") && <Lbl label="Reason / details of the matter" wide><textarea className="input" required rows={3} maxLength={1000} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Lbl>}
        {needs("purpose") && <Lbl label="Purpose (for example: bank loan, visa application)" wide><input className="input" required value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></Lbl>}
        {needs("effective_date") && <Lbl label="Effective date (as written in the letter)"><input className="input" required placeholder="1 March 2026" value={f.effective_date} onChange={(e) => setF({ ...f, effective_date: e.target.value })} /></Lbl>}
        <Lbl label="Signed by"><input className="input" placeholder="Human Resources" value={f.signatory} onChange={(e) => setF({ ...f, signatory: e.target.value })} /></Lbl>
        {salaryTpl && !canSalary && <p className="err text-sm sm:col-span-3">This letter includes salary details. You need the salary permission to create it.</p>}
        <div className="sm:col-span-3"><button className="btn" disabled={busy || !f.employeeId || !f.templateId}>Create draft</button></div>
      </form>
      <Msg />
      {edit && edit.status === "draft" && (
        <div className="card flex flex-col gap-3 p-4">
          <h2 className="font-semibold">Review draft</h2>
          <Lbl label="Subject"><input className="input" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></Lbl>
          <Lbl label="Letter text"><textarea className="input font-mono text-xs" rows={18} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></Lbl>
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost" disabled={busy} onClick={() => run(() => post(`/api/v1/hr/letters/${edit.id}`, draft, "PATCH"), "Draft saved.")}>Save draft</button>
            <button className="btn" disabled={busy} onClick={async () => { if (await run(() => post(`/api/v1/hr/letters/${edit.id}`, draft, "PATCH"), "Saved.")) await run(() => post(`/api/v1/hr/letters/${edit.id}/issue`, {}), "Issued and numbered. You can download or e-mail it now.", () => setEdit(null)); }}>Save and issue</button>
            <a className="btn-ghost" href={`/api/v1/hr/letters/${edit.id}/pdf`}>Preview PDF</a>
            <button className="btn-ghost err" disabled={busy} onClick={() => run(() => post(`/api/v1/hr/letters/${edit.id}`, undefined, "DELETE"), "Draft deleted.", () => setEdit(null))}>Delete draft</button>
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Letters</h2>
        {mail && (
          <form className="card flex flex-wrap items-end gap-3 p-3 text-sm" onSubmit={(e) => { e.preventDefault(); void run(() => post(`/api/v1/hr/letters/${mail.id}/email`, mail.to ? { to: mail.to } : {}), "E-mail sent with the PDF attached.", () => setMail(null)); }}>
            <Lbl label="Send to (blank = the employee's e-mail on file)"><input className="input w-72" type="email" value={mail.to} onChange={(e) => setMail({ ...mail, to: e.target.value })} /></Lbl>
            <button className="btn" disabled={busy}>Send</button><button type="button" className="btn-ghost" onClick={() => setMail(null)}>Cancel</button>
          </form>
        )}
        <div className="card overflow-x-auto">
          <table className="t"><thead><tr><th>Ref</th><th>Employee</th><th>Letter</th><th>Status</th><th>Created</th><th /></tr></thead>
            <tbody>
              {letters.map((l) => (
                <tr key={l.id}><td>{l.number.startsWith("DRAFT") ? "Draft" : l.number}</td><td className="font-medium">{l.employeeName}<div className="muted text-xs font-normal">{l.employeeNo}</div></td><td>{l.subject}<div className="muted text-xs">{label(l.kind)}</div></td>
                  <td><span className={`badge ${l.status === "emailed" ? "badge-ok" : l.status === "issued" ? "" : "badge-warn"}`}>{l.status}</span>{l.emailedTo && <div className="muted text-xs">to {l.emailedTo}</div>}{l.emailError && <div className="err text-xs">{l.emailError}</div>}</td><td>{l.createdAt.slice(0, 10)}</td>
                  <td className="text-right"><div className="flex justify-end gap-2">
                    {l.status === "draft" ? <button className="btn-ghost text-xs" onClick={() => { setEdit(l); setDraft({ subject: l.subject, body: l.body }); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Edit</button> : <><a className="btn-ghost text-xs" href={`/api/v1/hr/letters/${l.id}/pdf`}>PDF</a><button className="btn text-xs" onClick={() => setMail({ id: l.id, to: "" })}>E-mail</button></>}
                  </div></td></tr>
              ))}
              {letters.length === 0 && <tr><td colSpan={6} className="muted">No letters yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {canTemplates && (
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Templates</h2>
          <p className="muted text-sm">Placeholders you can use: {variables.map((v) => `{{${v}}}`).join(", ")}</p>
          <div className="card overflow-x-auto"><table className="t"><thead><tr><th>Type</th><th>Name</th><th>Active</th><th /></tr></thead><tbody>
            {templates.map((x) => <tr key={x.id}><td>{label(x.kind)}</td><td>{x.name}</td><td>{x.active ? "Yes" : "No"}</td><td className="text-right"><button className="btn-ghost text-xs" onClick={() => setT(x)}>Edit</button></td></tr>)}
          </tbody></table></div>
          <button className="btn-ghost self-start" onClick={() => setT({ id: "", kind: "noc", name: "", subject: "", body: "", active: true })}>+ New template</button>
          {t && (
            <form className="card grid gap-3 p-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void run(() => post("/api/v1/hr/letter-templates", { ...(t.id ? { id: t.id } : {}), kind: t.kind, name: t.name, subject: t.subject, body: t.body, active: t.active }), "Template saved.", () => setT(null)); }}>
              <Lbl label="Letter type"><select className="input" value={t.kind} onChange={(e) => setT({ ...t, kind: e.target.value })}>{kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select></Lbl>
              <Lbl label="Template name"><input className="input" required value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></Lbl>
              <Lbl label="Subject" wide><input className="input" required value={t.subject} onChange={(e) => setT({ ...t, subject: e.target.value })} /></Lbl>
              <Lbl label="Body" wide><textarea className="input font-mono text-xs" rows={14} required value={t.body} onChange={(e) => setT({ ...t, body: e.target.value })} /></Lbl>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={t.active} onChange={(e) => setT({ ...t, active: e.target.checked })} />Active</label>
              <div className="flex gap-2 sm:col-span-2"><button className="btn" disabled={busy}>Save template</button><button type="button" className="btn-ghost" onClick={() => setT(null)}>Cancel</button></div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

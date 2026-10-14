"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

interface Props { contactId: string; isEntity: boolean; profile: any | null; ubo: any | null; can: { manage: boolean; review: boolean; screen: boolean; dispose: boolean } }
const DOC_TYPES = ["passport", "emirates_id", "visa", "trade_licence", "proof_of_address", "source_of_funds", "other"];

export function KycPanel({ contactId, isEntity, profile, ubo, can }: Props) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [f, setF] = useState({ idType: profile?.idType ?? "passport", idNumber: "", dateOfBirth: "", nationality: profile?.nationality ?? "", countryOfResidence: profile?.countryOfResidence ?? "", sourceOfFunds: profile?.sourceOfFunds ?? "", occupation: profile?.occupation ?? "" });
  const [doc, setDoc] = useState({ documentId: "", docType: "passport", expiresOn: "" });
  const [ubl, setUbl] = useState({ ownerContactId: "", ownershipPct: "" });

  const done = async (r: { ok: boolean; data: any; status: number }, ok = "Done.") => {
    if (!r.ok) return setMsg({ ok: false, text: r.data?.error?.code === "step_up_required" ? "Re-verify your second factor first (step-up), then try again." : errMsg(r as any) });
    setMsg({ ok: true, text: ok });
    router.refresh();
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(f)) if (v !== "") body[k] = v;
    await done(await postJson(`/api/v1/contacts/${contactId}/kyc`, body, "PUT"), "Profile saved. Any earlier approval is reset until it is reviewed again.");
  };
  const api = (p: string, body?: unknown) => `/api/v1/${p}`;
  const askReason = (q: string, min = 3) => { const r = window.prompt(q)?.trim(); return r && r.length >= min ? r : null; };

  return (
    <div className="flex flex-col gap-4">
      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "" : "err"}`}>{msg.text}</p>}
      {can.manage && (
        <form onSubmit={save} className="card flex flex-wrap items-end gap-3 p-4">
          <h2 className="w-full font-semibold">Identity details</h2>
          <label className="text-sm">ID type<input className="input mt-1" value={f.idType} onChange={(e) => setF({ ...f, idType: e.target.value })} /></label>
          <label className="text-sm">ID number{profile?.idNumberLast4 && <span className="muted"> (stored: ...{profile.idNumberLast4})</span>}<input className="input mt-1" value={f.idNumber} onChange={(e) => setF({ ...f, idNumber: e.target.value })} autoComplete="off" placeholder={profile?.hasIdNumber ? "leave blank to keep" : ""} /></label>
          <label className="text-sm">Date of birth<input className="input mt-1" type="date" value={f.dateOfBirth} onChange={(e) => setF({ ...f, dateOfBirth: e.target.value })} /></label>
          <label className="text-sm">Nationality<input className="input mt-1" value={f.nationality} onChange={(e) => setF({ ...f, nationality: e.target.value })} /></label>
          <label className="text-sm">Country of residence<input className="input mt-1" value={f.countryOfResidence} onChange={(e) => setF({ ...f, countryOfResidence: e.target.value })} /></label>
          <label className="text-sm">Source of funds<input className="input mt-1" value={f.sourceOfFunds} onChange={(e) => setF({ ...f, sourceOfFunds: e.target.value })} /></label>
          <label className="text-sm">Occupation<input className="input mt-1" value={f.occupation} onChange={(e) => setF({ ...f, occupation: e.target.value })} /></label>
          <button className="btn">{profile ? "Update profile" : "Create profile"}</button>
        </form>
      )}

      {profile && (
        <>
          <div className="card overflow-x-auto p-2">
            <h2 className="p-2 font-semibold">Documents</h2>
            <table className="t"><thead><tr><th>Type</th><th>Document</th><th>Expires</th></tr></thead>
              <tbody>{profile.documents.map((d: any) => <tr key={d.id}><td>{d.docType}</td><td>{String(d.documentId).slice(0, 8)}</td><td>{d.expiresOn ?? "-"}</td></tr>)}{profile.documents.length === 0 && <tr><td colSpan={3} className="muted">None attached.</td></tr>}</tbody></table>
            {can.manage && (
              <div className="flex flex-wrap items-end gap-2 p-2">
                <label className="text-sm">Document id (uploaded in Documents)<input className="input mt-1" value={doc.documentId} onChange={(e) => setDoc({ ...doc, documentId: e.target.value })} /></label>
                <label className="text-sm">Type<select className="input mt-1" value={doc.docType} onChange={(e) => setDoc({ ...doc, docType: e.target.value })}>{DOC_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
                <label className="text-sm">Expires<input className="input mt-1" type="date" value={doc.expiresOn} onChange={(e) => setDoc({ ...doc, expiresOn: e.target.value })} /></label>
                <button className="btn-ghost" disabled={!doc.documentId} onClick={async () => done(await postJson(api(`kyc-profiles/${profile.id}/documents`), { documentId: doc.documentId.trim(), docType: doc.docType, ...(doc.expiresOn ? { expiresOn: doc.expiresOn } : {}) }), "Document attached.")}>Attach</button>
              </div>
            )}
          </div>

          {isEntity && (
            <div className="card overflow-x-auto p-2">
              <h2 className="p-2 font-semibold">Beneficial ownership</h2>
              <table className="t"><thead><tr><th>Owner</th><th>Direct %</th><th>Effective %</th><th>Beneficial owner</th></tr></thead>
                <tbody>{(ubo?.nodes ?? []).map((n: any) => <tr key={n.contactId}><td>{n.name} ({n.type})</td><td>{n.directPct}</td><td>{n.effectivePct}</td><td>{n.isBeneficialOwner ? "yes" : "no"}</td></tr>)}{(ubo?.nodes ?? []).length === 0 && <tr><td colSpan={4} className="muted">No ownership links recorded.</td></tr>}</tbody></table>
              {can.manage && (
                <div className="flex flex-wrap items-end gap-2 p-2">
                  <label className="text-sm">Owner contact id<input className="input mt-1" value={ubl.ownerContactId} onChange={(e) => setUbl({ ...ubl, ownerContactId: e.target.value })} /></label>
                  <label className="text-sm">Ownership %<input className="input mt-1 w-24" inputMode="decimal" value={ubl.ownershipPct} onChange={(e) => setUbl({ ...ubl, ownershipPct: e.target.value })} /></label>
                  <button className="btn-ghost" disabled={!ubl.ownerContactId || !(Number(ubl.ownershipPct) > 0)} onClick={async () => done(await postJson(api("ubo-links"), { parentContactId: contactId, ownerContactId: ubl.ownerContactId.trim(), ownershipPct: Number(ubl.ownershipPct) }), "Link added.")}>Add owner</button>
                </div>
              )}
            </div>
          )}

          <div className="card overflow-x-auto p-2">
            <div className="flex items-center justify-between p-2"><h2 className="font-semibold">Screening</h2>
              {can.screen && <button className="btn-ghost" onClick={async () => done(await postJson(api(`kyc-profiles/${profile.id}/screening`)), "Screening run.")}>Run screening</button>}</div>
            <p className="muted px-2 text-xs">Provider: mock watch-list for testing. Only a person can close a hit, with a written reason.</p>
            <table className="t"><thead><tr><th>List</th><th>Match</th><th>Score</th><th>Status</th><th /></tr></thead>
              <tbody>{profile.hits.map((h: any) => (
                <tr key={h.id}><td>{h.listName}</td><td>{h.matchedName}</td><td>{h.score}</td><td>{h.status}{h.disposedReason ? ` - ${h.disposedReason}` : ""}</td>
                  <td>{h.status === "open" && can.dispose && (
                    <span className="flex gap-1">
                      <button className="btn-ghost text-xs" onClick={async () => { const reason = askReason("Why is this NOT the same person? (min. 10 characters)", 10); if (reason) done(await postJson(api(`screening-hits/${h.id}/dispose`), { outcome: "false_positive", reason }), "Hit closed as false positive."); }}>False positive</button>
                      <button className="btn-ghost text-xs" onClick={async () => { const reason = askReason("Basis for confirming the match (min. 10 characters)", 10); if (reason) done(await postJson(api(`screening-hits/${h.id}/dispose`), { outcome: "true_match", reason }), "Match confirmed."); }}>Confirm match</button>
                    </span>)}</td></tr>))}
                {profile.hits.length === 0 && <tr><td colSpan={5} className="muted">No hits.</td></tr>}</tbody></table>
          </div>

          <div className="card overflow-x-auto p-2">
            <h2 className="p-2 font-semibold">Cases</h2>
            <table className="t"><thead><tr><th>Kind</th><th>Status</th><th>Summary</th><th /></tr></thead>
              <tbody>{profile.cases.map((c: any) => (
                <tr key={c.id}><td>{c.kind}</td><td>{c.status}{c.outcome ? ` (${c.outcome})` : ""}</td><td>{c.summary}</td>
                  <td>{c.status !== "closed" && (
                    <span className="flex gap-1">
                      {(["cleared", "reported", "rejected"] as const).map((o) => <button key={o} className="btn-ghost text-xs" onClick={async () => { const resolution = askReason(`Resolution for "${o}" (min. 10 characters)`, 10); if (resolution) done(await postJson(api(`compliance-cases/${c.id}/close`), { outcome: o, resolution }), "Case closed."); }}>{o}</button>)}
                    </span>)}</td></tr>))}
                {profile.cases.length === 0 && <tr><td colSpan={4} className="muted">No cases.</td></tr>}</tbody></table>
          </div>

          <div className="card flex flex-wrap items-center gap-2 p-4">
            {can.manage && ["draft", "rejected", "expired"].includes(profile.status) && <button className="btn" onClick={async () => done(await postJson(api(`kyc-profiles/${profile.id}/submit`)), "Submitted for review.")}>Submit for review</button>}
            {can.review && profile.status === "in_review" && (
              <>
                <button className="btn" onClick={async () => { const reason = askReason("Reason for approval"); if (reason) done(await postJson(api(`kyc-profiles/${profile.id}/review`), { outcome: "approved", reason }), "Approved."); }}>Approve</button>
                <button className="btn-ghost" onClick={async () => { const reason = askReason("Reason for rejection"); if (reason) done(await postJson(api(`kyc-profiles/${profile.id}/review`), { outcome: "rejected", reason }), "Rejected."); }}>Reject</button>
                <span className="muted text-xs">The person who submitted a profile cannot approve it.</span>
              </>
            )}
            {profile.status === "approved" && <span className="text-sm">Approved{profile.expiresAt ? ` until ${profile.expiresAt}` : ""}.</span>}
          </div>
        </>
      )}
    </div>
  );
}

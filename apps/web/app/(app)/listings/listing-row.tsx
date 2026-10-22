"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { DeleteButton } from "@/components/delete-button";
import { errMsg, postJson } from "@/lib/client";
import { ListingDrawer, type AgentOpt, type EditTarget } from "./listing-drawer";

interface Issue { code: string; message: string }

export interface ListingRowData { id: string; reference: string; title: string; purpose: string; price: string; jurisdiction: string; status: string; unit?: string; photos: number; views: number; enquiries: number; featured: boolean; web: boolean; expiresOn: string | null }

export function ListingRow({ listing, canPublish, edit, selected, onToggle }: { listing: ListingRowData; selected?: boolean; onToggle?: () => void; canPublish: boolean; edit?: { target: EditTarget; agents: AgentOpt[]; canReassign: boolean } }) {
  const router = useRouter();
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [ok, setOk] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function validate() {
    setBusy(true); setError(null);
    const r = await postJson(`/api/v1/listings/${listing.id}/validate`);
    setBusy(false);
    if (!r.ok) return setError(errMsg(r));
    setIssues(r.data.issues); setOk(r.data.publishable);
  }
  async function publish() {
    setBusy(true); setError(null);
    const r = await postJson(`/api/v1/listings/${listing.id}/publish`);
    setBusy(false);
    if (r.status === 422) { setIssues(r.data.error.evaluation.issues); setOk(false); return; }
    if (!r.ok) return setError(errMsg(r));
    setIssues([]); setOk(true);
    router.refresh();
  }
  async function unpublish() {
    setBusy(true); setError(null);
    const r = await postJson(`/api/v1/listings/${listing.id}/unpublish`, {});
    setBusy(false);
    if (!r.ok) return setError(errMsg(r));
    router.refresh();
  }
  return (
    <tr className={selected ? "bg-[var(--accent-soft)]" : ""}>
      {onToggle && <td><input type="checkbox" aria-label={`Select ${listing.title}`} checked={!!selected} onChange={onToggle} /></td>}
      <td className="font-medium"><Link href={`/listings/${listing.id}`}>{listing.title}</Link><div className="muted text-xs font-normal">{listing.reference}{listing.featured && " - featured"}{listing.web && " - on website"}</div></td><td>{listing.unit ?? "-"}</td><td><span className="badge badge-gray">{listing.purpose}</span></td><td>{listing.price}</td><td className="text-xs">{listing.photos === 0 ? <span className="err">No photos</span> : `${listing.photos} photos`}<div className="muted">{listing.views} views - {listing.enquiries} enquiries</div></td><td><span className={`badge ${listing.status === "published" ? "badge-ok" : listing.status === "draft" || listing.status === "expired" ? "badge-warn" : "badge-gray"}`}>{listing.status}</span></td>
      <td>
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost text-xs" onClick={validate} disabled={busy}>Check</button>
          {canPublish && ["draft", "unpublished", "expired"].includes(listing.status) && <button className="btn text-xs" onClick={publish} disabled={busy}>Publish</button>}
          {canPublish && listing.status === "published" && <button className="btn-ghost text-xs" onClick={unpublish} disabled={busy}>Unpublish</button>}
        </div>
        {ok === true && <p role="status" className="muted mt-1 text-xs">Meets all publication requirements.</p>}
        {issues && issues.length > 0 && (
          <ul role="alert" className="err mt-1 list-disc pl-4 text-xs">{issues.map((i) => <li key={i.code + i.message}>{i.message}</li>)}</ul>
        )}
        {error && <p role="alert" className="err mt-1 text-xs">{error}</p>}
      </td>
      <td className="text-right">{edit && listing.status !== "published" && <DeleteButton entity="listing" id={listing.id} name={listing.title} />}{edit && <ListingDrawer mode="edit" target={edit.target} agents={edit.agents} canReassign={edit.canReassign} />}</td>
    </tr>
  );
}

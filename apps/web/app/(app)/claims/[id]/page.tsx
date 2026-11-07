import Link from "next/link";
import { notFound } from "next/navigation";
import { getSequelize } from "@reales/database";
import { NotFoundError, getClaimBatch } from "@reales/domain";
import { ForbiddenError, widestScope } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { BatchActions } from "../claims-client";

export const metadata = { title: "Claim batch | Reales CRM" };

const when = (v?: string | null) => (v ? new Date(v).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "-");

export default async function ClaimBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  const { id } = await params;
  let b: any;
  try { b = await getClaimBatch(getSequelize(), ctx, id); } catch (e) { if (e instanceof NotFoundError || e instanceof ForbiddenError) notFound(); throw e; }
  const can = (p: string) => widestScope(ctx, p) === "tenant";
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head">
        <div><p className="muted text-xs"><Link href="/claims">Commission claims</Link></p><h1>Batch #{b.number}: {b.title}</h1>
          <p className="muted text-sm">{b.currency} {Number(b.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })} + VAT {Number(b.vatAmount).toLocaleString("en-US", { minimumFractionDigits: 2 })} - {b.itemCount} commission(s) - <b>{b.status}</b>{b.scheduledFor ? ` - release ${b.scheduledFor}` : ""}{b.releaseReference ? ` - ref ${b.releaseReference}` : ""}</p>
          {(b.rejectionReason || b.reversalReason) && <p className="err text-sm">{b.rejectionReason ?? b.reversalReason}</p>}</div>
      </div>
      <BatchActions batch={{ id: b.id, status: b.status, mine: b.createdBy === ctx.userId, itemCount: b.itemCount }} can={{ create: can("claim.create"), verify: can("claim.verify"), approve: can("claim.approve"), release: can("claim.release"), reverse: can("claim.reverse") }} items={b.items} />
      <div className="card overflow-x-auto p-0">
        <table className="t w-full text-sm"><thead><tr><th>Payee</th><th>Amount</th><th>VAT</th><th>Check</th><th /></tr></thead>
          <tbody>{b.items.filter((i: any) => i.live || b.status === "released" || b.status === "reversed").map((i: any) => (
            <tr key={i.id}><td>{i.payeeEmail ?? "Company"}</td><td>{i.currency} {Number(i.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td><td>{Number(i.vatAmount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>
              <td><span className={`badge ${i.verification === "verified" ? "badge-ok" : i.verification === "flagged" ? "badge-danger" : "badge-warn"}`}>{i.verification}</span>{i.verificationNote && <span className="muted text-xs"> {i.verificationNote}</span>}</td><td /></tr>))}</tbody></table>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <div className="card p-4"><h2 className="font-semibold">Evidence</h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm">{b.evidence.map((e: any) => <li key={e.id}><span className="badge">{e.kind.replace("_", " ")}</span> {e.description}{e.documentId && <> - <Link className="underline" href={`/documents`}>document</Link></>}</li>)}{b.evidence.length === 0 && <li className="muted">Nothing attached yet.</li>}</ul></div>
        <div className="card p-4"><h2 className="font-semibold">Decision log</h2>
          <ol className="mt-2 flex flex-col gap-1 text-sm">{b.decisions.map((d: any) => <li key={d.id}><b>{d.stage}</b> by {d.actorEmail ?? "?"} <span className="muted text-xs">{when(d.createdAt)}</span>{d.reason && <span className="muted"> - {d.reason}</span>}</li>)}{b.decisions.length === 0 && <li className="muted">No decisions yet.</li>}</ol></div>
      </div>
    </section>
  );
}

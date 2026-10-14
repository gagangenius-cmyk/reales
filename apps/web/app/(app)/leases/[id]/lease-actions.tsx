"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errMsg, postJson } from "@/lib/client";

interface Props { leaseId: string; status: string; canManage: boolean; canRecordRent: boolean; canTerminate: boolean; hasDeposit: boolean; depositStatus?: string }

/** Lease lifecycle actions. Every rule (activation gate, overpayment, overlap) is enforced by the API; this only reports its answer. */
export function LeaseActions({ leaseId, status, canManage, canRecordRent, canTerminate, hasDeposit, depositStatus }: Props) {
  const router = useRouter();
  const [msgs, setMsgs] = useState<string[]>([]);
  const [amount, setAmount] = useState("");

  async function run(path: string, body: unknown = {}) {
    setMsgs([]);
    const r = await postJson(`/api/v1/leases/${leaseId}/${path}`, body);
    if (r.status === 422 && r.data?.error?.reasons) return setMsgs(r.data.error.reasons);
    if (!r.ok) return setMsgs([errMsg(r)]);
    router.refresh();
  }
  const ask = (q: string) => window.prompt(q)?.trim() || null;

  return (
    <div className="card flex flex-wrap items-center gap-3 p-4">
      {canManage && status === "draft" && (
        <>
          <button className="btn-ghost" onClick={() => { const ref = ask("Registration reference (Ejari/Tawtheeq)"); const documentId = ref && ask("Contract document id"); if (ref && documentId) run("document", { documentId, registrationRef: ref }); }}>Attach contract</button>
          <button className="btn" onClick={() => run("activate")}>Activate</button>
        </>
      )}
      {canManage && hasDeposit && depositStatus === "pending" && <button className="btn-ghost" onClick={() => run("deposit/collect", { method: "bank_transfer" })}>Collect deposit</button>}
      {canRecordRent && status === "active" && (
        <span className="flex items-center gap-2">
          <input className="input w-32" inputMode="decimal" placeholder="Rent amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <button className="btn-ghost" disabled={!(Number(amount) > 0)} onClick={() => run("rent-payments", { amount: Number(amount), method: "bank_transfer" }).then(() => setAmount(""))}>Record rent</button>
        </span>
      )}
      {canManage && status === "active" && (
        <button className="btn-ghost" onClick={() => { const rent = Number(ask("New annual rent for the renewal")); if (rent > 0) run("renew", { newAnnualRent: rent }); }}>Renew</button>
      )}
      {canTerminate && status === "active" && (
        <button className="btn-ghost" onClick={() => { const effectiveOn = ask("Termination date (YYYY-MM-DD)"); const reason = effectiveOn && ask("Reason"); if (effectiveOn && reason) run("terminate", { effectiveOn, reason }); }}>Terminate</button>
      )}
      {msgs.length > 0 && <ul role="alert" className="err list-disc pl-4 text-sm">{msgs.map((m) => <li key={m}>{m}</li>)}</ul>}
    </div>
  );
}

import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listOrg, listPools, listRepoolRules, poolLeads } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { ClaimButton, PoolForm, RuleActions, RuleForm } from "./pool-client";

export const metadata = { title: "Lead pools | Reales CRM" };

const ACTION: Record<string, string> = { reassign: "give to the next agent", to_pool: "put back in a pool", notify_manager: "alert managers" };

export default async function Pools({ searchParams }: { searchParams: Promise<{ pool?: string }> }) {
  const ctx = await requireContext();
  const manage = hasPermission(ctx, "pool.manage");
  if (!manage && !hasPermission(ctx, "pool.claim")) return <NoAccess />;
  const sp = await searchParams;
  const sq = getSequelize();
  const pools: any[] = await listPools(sq, ctx);
  const current = pools.find((p) => p.id === sp.pool) ?? pools.find((p) => p.waiting > 0) ?? pools[0];
  const [leads, rules, org]: [any[], any[], any] = await Promise.all([
    current ? poolLeads(sq, ctx, current.id) : Promise.resolve([]),
    manage ? listRepoolRules(sq, ctx) : Promise.resolve([]),
    manage && hasPermission(ctx, "org.read") ? (listOrg(sq, ctx) as Promise<any>) : Promise.resolve({ branches: [] }),
  ]);
  const poolName = new Map(pools.map((p) => [p.id, p.name as string]));
  const canClaim = hasPermission(ctx, "pool.claim");
  return (
    <section className="flex flex-col gap-6">
      <div className="page-head"><div><h1>Lead pools</h1><p className="muted text-sm">Unassigned leads wait here until an agent claims one. Leads an agent does not work in time come back automatically.</p></div></div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {pools.map((p) => (
          <Link key={p.id} href={`/pools?pool=${p.id}`} className="card stat" style={{ boxShadow: current?.id === p.id ? "0 0 0 2px var(--accent)" : undefined, opacity: p.active ? 1 : 0.6 }}>
            <span className="muted text-xs">{p.name}{!p.active && " (paused)"}</span><b>{p.waiting}</b><span className="muted text-xs">waiting{p.dailyClaimLimit ? ` · ${p.dailyClaimLimit} claims/agent/day` : ""}</span>
          </Link>
        ))}
        {pools.length === 0 && <p className="muted text-sm">No pools yet.{manage ? " Create one below." : ""}</p>}
      </div>
      {current && (
        <div className="card overflow-x-auto">
          <h2 className="p-4 pb-2 font-semibold">{current.name}</h2>
          <table className="t"><thead><tr><th>Waiting since</th><th>Contact</th><th>Purpose</th><th>Budget (max)</th><th>Nationality</th><th>Times repooled</th><th /></tr></thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id}><td>{l.pooledAt ? new Date(l.pooledAt).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" }) : "-"}</td><td className="font-medium">{l.isHot && <span className="err">&#9650; </span>}{l.contactName}</td><td>{l.purpose}</td>
                  <td>{l.budgetMax ? `${l.currency} ${Number(l.budgetMax).toLocaleString("en-US")}` : "-"}</td><td>{l.nationality ?? "-"}</td><td>{l.repoolCount}</td>
                  <td className="text-right">{canClaim && current.active && <ClaimButton leadId={l.id} />}</td></tr>
              ))}
              {leads.length === 0 && <tr><td colSpan={7} className="muted">Nothing waiting in this pool.</td></tr>}
            </tbody></table>
        </div>
      )}
      {manage && (
        <>
          <div className="flex flex-col gap-3"><h2 className="text-lg font-semibold">Pools</h2><PoolForm branches={org.branches.map((b: any) => ({ id: b.id, name: b.name }))} />
            {pools.map((p) => <details key={p.id} className="card"><summary className="cursor-pointer px-4 py-3 text-sm font-medium">Edit {p.name}</summary><div className="p-2"><PoolForm pool={{ id: p.id, name: p.name, description: p.description, dailyClaimLimit: p.dailyClaimLimit, active: !!p.active, branchId: p.branchId }} branches={org.branches.map((b: any) => ({ id: b.id, name: b.name }))} /></div></details>)}
          </div>
          <div className="flex flex-col gap-3">
            <div><h2 className="text-lg font-semibold">Repool rules</h2><p className="muted text-sm">The clock runs from the moment a lead was last assigned, so a lead just handed over is never taken straight back. Rules run every few minutes.</p></div>
            <div className="card overflow-x-auto"><table className="t"><thead><tr><th>Rule</th><th>When</th><th>Then</th><th>Pool</th><th>Max</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id} style={{ opacity: r.active ? 1 : 0.6 }}><td className="font-medium">{r.name}{r.hotOnly && <span className="badge badge-danger ml-2">hot only</span>}</td>
                    <td>no {r.triggerKind === "no_first_response" ? "first response" : "activity"} in {r.afterMinutes} min</td><td>{ACTION[r.action]}</td><td>{r.poolId ? poolName.get(r.poolId) ?? "-" : "-"}</td><td>{r.maxRepools}</td>
                    <td><span className={`badge ${r.active ? "badge-ok" : "badge-gray"}`}>{r.active ? "active" : "paused"}</span></td>
                    <td className="text-right"><RuleActions id={r.id} active={!!r.active} rule={{ name: r.name, triggerKind: r.triggerKind, afterMinutes: r.afterMinutes, action: r.action, poolId: r.poolId, maxRepools: r.maxRepools, hotOnly: !!r.hotOnly }} /></td></tr>
                ))}
                {rules.length === 0 && <tr><td colSpan={7} className="muted">No rules. Leads stay with their agent until someone moves them.</td></tr>}
              </tbody></table></div>
            <RuleForm pools={pools.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name }))} />
          </div>
        </>
      )}
    </section>
  );
}

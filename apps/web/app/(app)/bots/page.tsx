import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listBots } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { NewBotForm } from "./bot-client";

export const metadata = { title: "Bots | Reales CRM" };

export default async function Bots() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "bot.read")) return <NoAccess />;
  const bots: any[] = await listBots(getSequelize(), ctx);
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Conversation bots</h1>
      <p className="muted text-sm">Qualify enquiries automatically, then hand over to a person. The AI step is a mock until a model provider is connected.</p>
      {hasPermission(ctx, "bot.manage") && <NewBotForm />}
      <div className="card overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>Name</th><th>Channel</th><th>Status</th><th>Version</th><th /></tr></thead>
          <tbody>
            {bots.map((b) => <tr key={b.id}><td>{b.name}</td><td>{b.channel}</td><td>{b.status}</td><td>{b.currentVersion || "-"}</td><td><Link className="btn-ghost text-sm" href={`/bots/${b.id}`}>Open</Link></td></tr>)}
            {bots.length === 0 && <tr><td colSpan={5} className="muted">No bots yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

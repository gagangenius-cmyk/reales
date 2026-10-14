import Link from "next/link";
import { getSequelize } from "@reales/database";
import { getBot, listContacts } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";
import { BotEditor } from "../bot-client";

export const metadata = { title: "Bot | Reales CRM" };

export default async function BotPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "bot.read")) return <NoAccess />;
  const { id } = await params;
  const sq = getSequelize();
  let bot: any;
  try { bot = await getBot(sq, ctx, id); } catch {
    return <section><h1 className="text-2xl font-semibold">Bot not found</h1><Link className="btn-ghost mt-3 inline-block" href="/bots">Back</Link></section>;
  }
  const manage = hasPermission(ctx, "bot.manage");
  const contacts: any[] = manage ? ((await listContacts(sq, ctx, { limit: 100, offset: 0 }).catch(() => [])) as any[]) : [];
  return (
    <section className="flex flex-col gap-4">
      <div>
        <Link className="muted text-sm" href="/bots">Back to bots</Link>
        <h1 className="text-2xl font-semibold">{bot.name}</h1>
        <p className="muted text-sm">{bot.channel} - {bot.status}{bot.currentVersion ? ` - version ${bot.currentVersion}` : " - never published"}</p>
      </div>
      <BotEditor bot={bot} canManage={manage} contacts={contacts.map((c) => ({ id: c.id, label: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || c.email || c.id }))} />
    </section>
  );
}

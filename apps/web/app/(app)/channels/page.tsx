import { getSequelize } from "@reales/database";
import { listChannelAccounts } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { ChannelsClient } from "./channels-client";

export const metadata = { title: "Messaging accounts | Reales CRM" };

export default async function Channels() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "channel.manage")) return <NoAccess />;
  const data = await listChannelAccounts(getSequelize(), ctx);
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Messaging accounts</h1><p className="muted text-sm">The WhatsApp numbers and other senders your inbox and broadcasts use. Credentials are stored encrypted and never shown again.</p></div></div>
      <ChannelsClient data={data as never} />
    </section>
  );
}

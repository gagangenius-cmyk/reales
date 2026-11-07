import { getSequelize } from "@reales/database";
import { listApiKeys, listWebhookEndpoints } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { ApiKeysPanel, WebhooksPanel } from "./integrations-client";

export const metadata = { title: "API and webhooks | Reales CRM" };

export default async function Integrations() {
  const ctx = await requireContext();
  const sq = getSequelize();
  const keys = hasPermission(ctx, "apikey.manage"), hooks = hasPermission(ctx, "webhook.manage");
  if (!keys && !hooks) return <section className="card p-6"><h1 className="text-lg font-semibold">API and webhooks</h1><p className="muted mt-2 text-sm">You do not have access. Ask an administrator for the API key or webhook permission.</p></section>;
  const [k, w]: [any, any] = await Promise.all([keys ? listApiKeys(sq, ctx) : null, hooks ? listWebhookEndpoints(sq, ctx) : null]);
  return (
    <section className="flex flex-col gap-6">
      <div className="page-head"><div><h1>API and webhooks</h1><p className="muted text-sm">Let other systems read and write CRM data with a key, and be told when things happen.</p></div></div>
      {keys && <ApiKeysPanel keys={k.keys} scopes={k.availableScopes} />}
      {hooks && <WebhooksPanel endpoints={w} />}
    </section>
  );
}

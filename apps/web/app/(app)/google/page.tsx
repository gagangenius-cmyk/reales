import { getSequelize } from "@reales/database";
import { getGoogleStatus } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { GooglePanel } from "./google-client";

export const metadata = { title: "Google Workspace | Reales CRM" };

export default async function Google({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  if (!hasPermission(ctx, "google.connect")) return <section className="card p-6"><h1 className="text-lg font-semibold">Google Workspace</h1><p className="muted mt-2 text-sm">You do not have access to connect Google.</p></section>;
  const status = await getGoogleStatus(getSequelize(), ctx);
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Google Workspace</h1><p className="muted text-sm">Keep your CRM tasks and viewings in Google Calendar, and see your e-mail with clients on their contact page.</p></div></div>
      {sp.connected && <p className="card p-3 text-sm" role="status">Google is connected.</p>}
      {sp.error && <p className="card err p-3 text-sm" role="alert">{sp.error}</p>}
      <GooglePanel configured={status.configured} account={status.account} />
    </section>
  );
}

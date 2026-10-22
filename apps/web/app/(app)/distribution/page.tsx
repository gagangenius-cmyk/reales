import { getSequelize } from "@reales/database";
import { portalOverview } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { AccountCard, NewAccount } from "./distribution-client";

export const metadata = { title: "Distribution | Reales CRM" };

export default async function Distribution() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "portal.manage")) return <NoAccess />;
  const o = await portalOverview(getSequelize(), ctx);
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>Distribution</h1><p className="muted text-sm">Where your listings are published. Bayut and Property Finder both read an XML feed from your private feed address; Property Finder can also be fed live through its API once you add credentials.</p></div></div>
      {!o.baseUrlConfigured && <p className="card p-4 text-sm" style={{ borderColor: "var(--warn)" }}>Set <code>PUBLIC_BASE_URL</code> (your site&apos;s public address, e.g. https://crm.example.com) so feed addresses and photo links can be built. Until then feeds cannot point portals at your photos.</p>}
      <div className="grid gap-5 xl:grid-cols-2">{o.accounts.map((a: any) => <AccountCard key={a.id} a={JSON.parse(JSON.stringify(a))} />)}</div>
      {o.accounts.length === 0 && <p className="muted text-sm">No portal accounts yet.</p>}
      <NewAccount providers={o.providers} />
      <div className="card p-5 text-sm"><h2 className="mb-2 font-semibold">How to connect</h2>
        <ol className="muted list-decimal space-y-1 pl-5">
          <li><b>Bayut / dubizzle:</b> create the account here, copy the feed address, and send it to Bayut support (support@bayut.com) with a request to start the XML import. Bayut sends you its current XML documentation: compare it with the tags we send and tell us about any difference.</li>
          <li><b>Property Finder:</b> ask your account manager for Enterprise API access. Paste the API address, key and secret under &ldquo;Live API&rdquo;, press <b>Test connection</b>, and only then switch the account to live mode. The XML feed works in the meantime.</li>
          <li>Every listing needs a verified advertising permit and photos reachable at your public address before a portal will accept it.</li>
        </ol></div>
    </section>
  );
}

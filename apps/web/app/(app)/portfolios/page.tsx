import { getSequelize } from "@reales/database";
import { listOwnerStatements, listPortfolios } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../no-access";
import { PdfActions } from "../pdf-actions";

export const metadata = { title: "Portfolios | Reales CRM" };

const money = (v: unknown, c = "AED") => `${c} ${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

export default async function Portfolios() {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "portfolio.read")) return <NoAccess />;
  const sq = getSequelize();
  const portfolios: any[] = await listPortfolios(sq, ctx);
  const statements: any[] = hasPermission(ctx, "statement.read") ? await listOwnerStatements(sq, ctx, { limit: 50, offset: 0 }) : [];
  const names = new Map(portfolios.map((p) => [p.id, p.name]));
  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Portfolios</h1>
      <div className="card overflow-x-auto p-2">
        <table className="t">
          <thead><tr><th>Name</th><th>Status</th></tr></thead>
          <tbody>
            {portfolios.map((p) => <tr key={p.id}><td>{p.name}</td><td>{p.status}</td></tr>)}
            {portfolios.length === 0 && <tr><td colSpan={2} className="muted">No portfolios visible to you.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card overflow-x-auto p-2">
        <h2 className="p-2 font-semibold">Owner statements</h2>
        <table className="t">
          <thead><tr><th>Period</th><th>Portfolio</th><th>Rent collected</th><th>Management fee</th><th>Maintenance</th><th>Net payable</th><th>Status</th><th /></tr></thead>
          <tbody>
            {statements.map((s) => (
              <tr key={s.id}><td>{s.period}</td><td>{names.get(s.portfolioId) ?? "-"}</td><td>{money(s.rentCollected, s.currency)}</td><td>{money(s.managementFee, s.currency)}</td><td>{money(s.maintenanceCost, s.currency)}</td><td>{money(s.netPayable, s.currency)}</td><td>{s.status}</td><td><PdfActions href={`/api/v1/statements/${s.id}/pdf`} kind="owner_statement" id={s.id} label="PDF" /></td></tr>
            ))}
            {statements.length === 0 && <tr><td colSpan={8} className="muted">No statements.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

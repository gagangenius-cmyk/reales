import { getSequelize } from "@reales/database";
import { myPayslips } from "@reales/domain";
import { requireContext } from "@/lib/page-context";

export const metadata = { title: "My payslips | Reales CRM" };
const money = (n: number, c: string) => `${c} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default async function Payslips() {
  const ctx = await requireContext();
  const slips: any[] = await myPayslips(getSequelize(), ctx);
  return (
    <section className="flex flex-col gap-4">
      <div className="page-head"><div><h1>My payslips</h1><p className="muted text-sm">Payslips appear here once payroll for the month has been paid.</p></div></div>
      <div className="card overflow-x-auto" data-server-table>
        <table className="t"><thead><tr><th>Month</th><th>Payslip</th><th>Paid on</th><th>Gross</th><th>Deductions</th><th>Net pay</th><th /></tr></thead>
          <tbody>
            {slips.map((s) => <tr key={s.id}><td className="font-medium">{s.period}</td><td>{s.number}</td><td>{s.payDate ?? "-"}</td><td>{money(s.gross, s.currency)}</td><td>{s.deductionsTotal ? money(s.deductionsTotal, s.currency) : "-"}</td><td className="font-semibold">{money(s.net, s.currency)}</td><td className="text-right"><a className="btn-ghost text-xs" href={`/api/v1/hr/payslips/${s.id}/pdf`}>Download PDF</a></td></tr>)}
            {slips.length === 0 && <tr><td colSpan={7} className="muted">No payslips yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

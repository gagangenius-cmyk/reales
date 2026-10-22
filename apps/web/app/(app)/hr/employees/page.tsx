import Link from "next/link";
import { getSequelize } from "@reales/database";
import { listEmployees, listShifts, listAssignableUsers } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { Field, Sel, qs } from "@/components/filter-bits";
import { LiveSearch } from "@/components/live-search";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";
import { EmployeeForm } from "./employee-form";

export const metadata = { title: "Employees | Reales CRM" };
const PAGE = 50;

export default async function Employees({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; department?: string; page?: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "hr.read")) return <NoAccess />;
  const sp = await searchParams;
  const sq = getSequelize();
  const page = Math.max(1, Number(sp.page) || 1);
  const status = ["active", "on_notice", "exited"].includes(sp.status ?? "") ? sp.status : undefined;
  const manage = hasPermission(ctx, "hr.manage");
  const [res, shifts, users, all] = await Promise.all([
    listEmployees(sq, ctx, { q: sp.q, status, department: sp.department, limit: PAGE, offset: (page - 1) * PAGE }),
    listShifts(sq, ctx), manage ? listAssignableUsers(sq, ctx).catch(() => []) : Promise.resolve([]), manage ? listEmployees(sq, ctx, { limit: 200 }) : Promise.resolve(null),
  ]);
  const pages = Math.max(1, Math.ceil(res.total / PAGE));
  const href = (o: Record<string, string | undefined>) => `/hr/employees${qs({ q: sp.q, status, department: sp.department, ...o })}`;
  return (
    <section className="flex flex-col gap-4">
      <div className="page-head"><div><h1>Employees</h1><p className="muted text-sm">{res.total} employee{res.total === 1 ? "" : "s"}.</p></div>
        {manage && <EmployeeForm shifts={(shifts as any[]).map((s) => ({ id: s.id, name: s.name }))} users={users.map((u: any) => ({ id: u.id, email: u.email }))} managers={(all?.rows ?? []).map((e: any) => ({ id: e.id, name: e.fullName }))} />}
      </div>
      <form className="card flex flex-wrap items-end gap-3 p-3" action="/hr/employees">
        <Field label="Search" wide><LiveSearch placeholder="Name, number, e-mail or title" /></Field>
        <Field label="Status"><Sel name="status" value={status} any="All" options={[["active", "Active"], ["on_notice", "On notice"], ["exited", "Exited"]]} /></Field>
        <Field label="Department"><Sel name="department" value={sp.department} any="All" options={res.departments} /></Field>
        <button className="btn">Filter</button>
      </form>
      <div className="card overflow-x-auto">
        <table className="t"><thead><tr><th>No.</th><th>Name</th><th>Title</th><th>Department</th><th>Joined</th><th>Status</th></tr></thead>
          <tbody>
            {res.rows.map((e: any) => <tr key={e.id}><td>{e.employeeNo}</td><td className="font-medium"><Link href={`/hr/employees/${e.id}`}>{e.fullName}</Link><div className="muted text-xs font-normal">{e.email}</div></td><td>{e.designation ?? "-"}</td><td>{e.department ?? "-"}</td><td>{String(e.joinedOn).slice(0, 10)}</td><td><span className={`badge ${e.status === "active" ? "badge-ok" : e.status === "on_notice" ? "badge-warn" : "badge-gray"}`}>{e.status.replace("_", " ")}</span></td></tr>)}
            {res.rows.length === 0 && <tr><td colSpan={6} className="muted">No employees yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {pages > 1 && <nav className="flex items-center justify-between text-sm" aria-label="Pagination"><span className="muted">Page {page} of {pages}</span><div className="flex gap-2">{page > 1 && <Link className="btn-ghost" href={href({ page: String(page - 1) })}>Previous</Link>}{page < pages && <Link className="btn-ghost" href={href({ page: String(page + 1) })}>Next</Link>}</div></nav>}
    </section>
  );
}

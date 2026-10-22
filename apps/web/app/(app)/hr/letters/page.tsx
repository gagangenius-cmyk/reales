import { getSequelize } from "@reales/database";
import { LETTER_KINDS, listEmployees, listLetterTemplates, listLetters, VARIABLES } from "@reales/domain";
import { hasPermission } from "@reales/rbac";
import { requireContext } from "@/lib/page-context";
import { NoAccess } from "../../no-access";
import { LettersClient } from "./letters-client";

export const metadata = { title: "HR letters | Reales CRM" };

export default async function Letters({ searchParams }: { searchParams: Promise<{ employee?: string }> }) {
  const ctx = await requireContext();
  if (!hasPermission(ctx, "hr.letters")) return <NoAccess />;
  const sp = await searchParams;
  const sq = getSequelize();
  const [templates, letters, emps] = await Promise.all([listLetterTemplates(sq, ctx), listLetters(sq, ctx), listEmployees(sq, ctx, { limit: 200 })]);
  return (
    <section className="flex flex-col gap-5">
      <div className="page-head"><div><h1>HR letters</h1><p className="muted text-sm">Offer, appointment, confirmation, warning, NOC, salary certificate, experience and relieving letters. Write a draft, issue it to give it a number, then download the PDF or e-mail it.</p></div></div>
      <LettersClient templates={templates as never} letters={letters as never} employees={emps.rows.map((e: any) => ({ id: e.id, name: e.fullName, no: e.employeeNo, email: e.email }))} kinds={LETTER_KINDS as never} variables={VARIABLES} preselect={sp.employee} canSalary={hasPermission(ctx, "hr.salary")} canTemplates={hasPermission(ctx, "hr.manage")} />
    </section>
  );
}

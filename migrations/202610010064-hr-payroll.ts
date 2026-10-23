import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk, step } from "./_helpers";

/** Monthly payroll: a run per month (draft, approved, paid) with one payslip per employee, adjustments, and numbered payslips employees can open. */
export async function up({ context: qi, sequelize }: Ctx) {
  const num = (p = 14, s = 2) => ({ type: DataTypes.DECIMAL(p, s), allowNull: false, defaultValue: 0 });
  await step(() => qi.createTable("hr_payroll_runs", {
    id: id(), tenant_id: tenantId(), period: str(7), status: { type: DataTypes.ENUM("draft", "approved", "paid"), allowNull: false, defaultValue: "draft" }, pay_date: { type: DataTypes.DATEONLY, allowNull: true }, payment_reference: str(120, true),
    employees_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }, total_gross: num(16), total_deductions: num(16), total_net: num(16), created_by: uuid(), approved_by: uuid(), approved_at: dt(), paid_at: dt(), ...ts(),
  }));
  await step(() => tenantKey(qi, "hr_payroll_runs"));
  await step(() => qi.addIndex("hr_payroll_runs", ["tenant_id", "period"], { unique: true, name: "uq_hr_payroll_period" }));
  await step(() => qi.createTable("hr_payslips", {
    id: id(), tenant_id: tenantId(), run_id: uuid(false), employee_id: uuid(false), number: str(24), period: str(7), currency: str(3), days_in_period: { type: DataTypes.INTEGER, allowNull: false }, days_payable: num(6, 1), unpaid_days: num(6, 1), absent_days: num(6, 1),
    basic: num(), housing: num(), transport: num(), other_allowance: num(), earnings: json(), deductions: json(), gross: num(), deductions_total: num(), net: num(), notes: str(300, true), ...ts(),
  }));
  await step(() => tenantKey(qi, "hr_payslips"));
  await step(() => qi.addIndex("hr_payslips", ["tenant_id", "run_id", "employee_id"], { unique: true, name: "uq_hr_payslip_emp" }));
  await step(() => qi.addIndex("hr_payslips", ["tenant_id", "number"], { unique: true, name: "uq_hr_payslip_number" }));
  await step(() => tenantFk(sequelize, "hr_payslips", "run_id", "hr_payroll_runs", "CASCADE"));
  await step(() => tenantFk(sequelize, "hr_payslips", "employee_id", "hr_employees"));
}

export async function down({ context: qi }: Ctx) {
  await qi.dropTable("hr_payslips");
  await qi.dropTable("hr_payroll_runs");
}

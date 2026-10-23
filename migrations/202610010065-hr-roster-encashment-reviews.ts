import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk, step } from "./_helpers";

/** Shift rosters (per-day shift or day off), leave encashment, and performance reviews with cycles, goals and ratings. */
export async function up({ context: qi, sequelize }: Ctx) {
  const date = (allowNull = true) => ({ type: DataTypes.DATEONLY, allowNull });
  const money = { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 };

  await step(() => qi.createTable("hr_roster", { id: id(), tenant_id: tenantId(), employee_id: uuid(false), work_date: date(false), shift_id: uuid(), day_off: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }, note: str(200, true), created_by: uuid(), ...ts() }));
  await step(() => tenantKey(qi, "hr_roster"));
  await step(() => qi.addIndex("hr_roster", ["tenant_id", "employee_id", "work_date"], { unique: true, name: "uq_hr_roster_day" }));
  await step(() => qi.addIndex("hr_roster", ["tenant_id", "work_date"], { name: "ix_hr_roster_date" }));
  await step(() => tenantFk(sequelize, "hr_roster", "employee_id", "hr_employees", "CASCADE"));
  await step(() => tenantFk(sequelize, "hr_roster", "shift_id", "hr_shifts", "SET NULL"));

  await step(() => qi.addColumn("hr_leave_types", "encashable", { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }));
  await step(() => sequelize.query("UPDATE hr_leave_types SET encashable=1 WHERE code='ANNUAL'"));
  await step(() => qi.createTable("hr_encashments", {
    id: id(), tenant_id: tenantId(), employee_id: uuid(false), leave_type_id: uuid(false), year: { type: DataTypes.INTEGER, allowNull: false }, days: { type: DataTypes.DECIMAL(6, 1), allowNull: false }, daily_rate: money, amount: money,
    status: { type: DataTypes.ENUM("pending", "paid", "cancelled"), allowNull: false, defaultValue: "pending" }, payroll_run_id: uuid(), reason: str(200, true), created_by: uuid(), ...ts(),
  }));
  await step(() => tenantKey(qi, "hr_encashments"));
  await step(() => qi.addIndex("hr_encashments", ["tenant_id", "employee_id", "status"], { name: "ix_hr_encash_emp" }));
  await step(() => tenantFk(sequelize, "hr_encashments", "employee_id", "hr_employees", "CASCADE"));
  await step(() => tenantFk(sequelize, "hr_encashments", "leave_type_id", "hr_leave_types"));

  await step(() => qi.createTable("hr_review_cycles", { id: id(), tenant_id: tenantId(), name: str(120), period_start: date(false), period_end: date(false), status: { type: DataTypes.ENUM("open", "closed"), allowNull: false, defaultValue: "open" }, rating_scale: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 }, created_by: uuid(), ...ts() }));
  await step(() => tenantKey(qi, "hr_review_cycles"));
  await step(() => qi.createTable("hr_reviews", {
    id: id(), tenant_id: tenantId(), cycle_id: uuid(false), employee_id: uuid(false), reviewer_employee_id: uuid(), goals: json(), self_rating: { type: DataTypes.INTEGER, allowNull: true }, self_comments: { type: DataTypes.TEXT, allowNull: true },
    manager_rating: { type: DataTypes.INTEGER, allowNull: true }, manager_comments: { type: DataTypes.TEXT, allowNull: true }, final_rating: { type: DataTypes.INTEGER, allowNull: true }, outcome: str(200, true),
    status: { type: DataTypes.ENUM("pending", "self_submitted", "manager_submitted", "finalised"), allowNull: false, defaultValue: "pending" }, finalised_by: uuid(), finalised_at: dt(), ...ts(),
  }));
  await step(() => tenantKey(qi, "hr_reviews"));
  await step(() => qi.addIndex("hr_reviews", ["tenant_id", "cycle_id", "employee_id"], { unique: true, name: "uq_hr_review_emp" }));
  await step(() => tenantFk(sequelize, "hr_reviews", "cycle_id", "hr_review_cycles", "CASCADE"));
  await step(() => tenantFk(sequelize, "hr_reviews", "employee_id", "hr_employees", "CASCADE"));
}

export async function down({ context: qi }: Ctx) {
  for (const t of ["hr_reviews", "hr_review_cycles", "hr_encashments", "hr_roster"]) await qi.dropTable(t);
  await qi.removeColumn("hr_leave_types", "encashable");
}

import { DataTypes } from "sequelize";
import { Ctx, id, ts, str, tenantId, uuid, dt, json, tenantKey, tenantFk, step } from "./_helpers";

/**
 * Human resources: employee records, salary history, configurable leave types and balances, attendance with live check-in/out and breaks, shifts, public
 * holidays, letter templates and issued letters, HR documents with expiry, announcements and occasions.
 */
export async function up({ context: qi, sequelize }: Ctx) {
  const date = (allowNull = true) => ({ type: DataTypes.DATEONLY, allowNull });
  const num = (allowNull = true, p = 14, s = 2) => ({ type: DataTypes.DECIMAL(p, s), allowNull });
  const bool = (def: boolean) => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue: def });
  const int = (def = 0) => ({ type: DataTypes.INTEGER, allowNull: false, defaultValue: def });
  const mk = async (name: string, cols: Record<string, unknown>, indexes: { cols: string[]; unique?: boolean; name: string }[] = []) => {
    await step(() => qi.createTable(name, { id: id(), tenant_id: tenantId(), ...cols } as never));
    await step(() => tenantKey(qi, name));
    for (const i of indexes) await step(() => qi.addIndex(name, i.cols, { unique: i.unique, name: i.name }));
  };

  await mk("hr_shifts", { name: str(80), start_time: str(5), end_time: str(5), break_minutes: int(60), grace_minutes: int(10), half_day_minutes: int(240), weekly_off: json(), active: bool(true), ...ts() }, [{ cols: ["tenant_id", "name"], unique: true, name: "uq_hr_shifts_name" }]);
  await mk("hr_employees", {
    user_id: uuid(), employee_no: str(30), full_name: str(160), email: str(254, true), phone: str(40, true), designation: str(120, true), department: str(120, true), branch_id: uuid(),
    manager_employee_id: uuid(), employment_type: { type: DataTypes.ENUM("full_time", "part_time", "contract", "intern"), allowNull: false, defaultValue: "full_time" },
    status: { type: DataTypes.ENUM("active", "on_notice", "exited"), allowNull: false, defaultValue: "active" }, joined_on: date(false), probation_ends_on: date(), exit_on: date(), exit_reason: str(300, true),
    date_of_birth: date(), gender: { type: DataTypes.ENUM("male", "female", "other"), allowNull: true }, nationality: str(60, true), work_location: str(120, true), shift_id: uuid(),
    passport_expires_on: date(), visa_expires_on: date(), emirates_id_expires_on: date(), labour_card_no: str(40, true), notes: str(500, true), deleted_at: dt(), deleted_by: uuid(), ...ts(),
  }, [{ cols: ["tenant_id", "employee_no"], unique: true, name: "uq_hr_employee_no" }, { cols: ["tenant_id", "user_id"], unique: true, name: "uq_hr_employee_user" }, { cols: ["tenant_id", "status"], name: "ix_hr_employee_status" }]);
  await step(() => tenantFk(sequelize, "hr_employees", "shift_id", "hr_shifts", "SET NULL"));
  await step(() => tenantFk(sequelize, "hr_employees", "manager_employee_id", "hr_employees", "SET NULL"));

  await mk("hr_salaries", {
    employee_id: uuid(false), effective_from: date(false), currency: str(3), basic: num(false), housing: num(false), transport: num(false), other_allowance: num(false), components: json(),
    gross: num(false), payment_method: { type: DataTypes.ENUM("bank_transfer", "cash", "cheque"), allowNull: false, defaultValue: "bank_transfer" }, iban_enc: { type: DataTypes.TEXT, allowNull: true },
    reason: str(200, true), created_by: uuid(), created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  }, [{ cols: ["tenant_id", "employee_id", "effective_from"], name: "ix_hr_salary_emp" }]);
  await step(() => tenantFk(sequelize, "hr_salaries", "employee_id", "hr_employees", "CASCADE"));

  await mk("hr_leave_types", {
    code: str(30), name: str(80), annual_days: num(false, 6, 1), accrual: { type: DataTypes.ENUM("upfront", "monthly"), allowNull: false, defaultValue: "upfront" }, carry_forward_max: num(false, 6, 1), paid: bool(true),
    requires_document_after_days: int(0), max_consecutive_days: int(0), min_notice_days: int(0), gender: { type: DataTypes.ENUM("any", "male", "female"), allowNull: false, defaultValue: "any" }, counts_weekends: bool(false),
    min_service_months: int(0), active: bool(true), color: str(9, true), ...ts(),
  }, [{ cols: ["tenant_id", "code"], unique: true, name: "uq_hr_leave_type_code" }]);
  await mk("hr_leave_balances", { employee_id: uuid(false), leave_type_id: uuid(false), year: int(), entitled: num(false, 6, 1), carried: num(false, 6, 1), adjusted: num(false, 6, 1), note: str(200, true), ...ts() },
    [{ cols: ["tenant_id", "employee_id", "leave_type_id", "year"], unique: true, name: "uq_hr_leave_balance" }]);
  await step(() => tenantFk(sequelize, "hr_leave_balances", "employee_id", "hr_employees", "CASCADE"));
  await step(() => tenantFk(sequelize, "hr_leave_balances", "leave_type_id", "hr_leave_types", "CASCADE"));
  await mk("hr_leave_requests", {
    employee_id: uuid(false), leave_type_id: uuid(false), from_date: date(false), to_date: date(false), half_day: { type: DataTypes.ENUM("none", "first", "second"), allowNull: false, defaultValue: "none" },
    days: num(false, 6, 1), reason: str(500, true), status: { type: DataTypes.ENUM("pending", "approved", "rejected", "cancelled"), allowNull: false, defaultValue: "pending" },
    approver_user_id: uuid(), decided_at: dt(), decision_note: str(300, true), attachment_key: str(300, true), ...ts(),
  }, [{ cols: ["tenant_id", "employee_id", "from_date"], name: "ix_hr_leave_emp" }, { cols: ["tenant_id", "status"], name: "ix_hr_leave_status" }]);
  await step(() => tenantFk(sequelize, "hr_leave_requests", "employee_id", "hr_employees", "CASCADE"));
  await step(() => tenantFk(sequelize, "hr_leave_requests", "leave_type_id", "hr_leave_types"));
  await mk("hr_holidays", { on_date: date(false), name: str(120), ...ts() }, [{ cols: ["tenant_id", "on_date"], unique: true, name: "uq_hr_holiday_date" }]);

  await mk("hr_attendance", {
    employee_id: uuid(false), work_date: date(false), check_in_at: dt(), check_out_at: dt(), status: { type: DataTypes.ENUM("present", "late", "half_day", "absent", "on_leave", "holiday", "weekly_off"), allowNull: false, defaultValue: "present" },
    worked_minutes: int(), break_minutes: int(), late_minutes: int(), source: { type: DataTypes.ENUM("web", "mobile", "manual"), allowNull: false, defaultValue: "web" }, ip: str(64, true), note: str(300, true), edited_by: uuid(), ...ts(),
  }, [{ cols: ["tenant_id", "employee_id", "work_date"], unique: true, name: "uq_hr_attendance_day" }, { cols: ["tenant_id", "work_date"], name: "ix_hr_attendance_date" }]);
  await step(() => tenantFk(sequelize, "hr_attendance", "employee_id", "hr_employees", "CASCADE"));
  await mk("hr_breaks", { attendance_id: uuid(false), kind: { type: DataTypes.ENUM("lunch", "tea", "prayer", "other"), allowNull: false, defaultValue: "lunch" }, started_at: dt(false), ended_at: dt(), ...ts() }, [{ cols: ["tenant_id", "attendance_id"], name: "ix_hr_breaks_att" }]);
  await step(() => tenantFk(sequelize, "hr_breaks", "attendance_id", "hr_attendance", "CASCADE"));

  await mk("hr_letter_templates", { kind: str(30), name: str(120), subject: str(200), body: { type: DataTypes.TEXT, allowNull: false }, active: bool(true), ...ts() }, [{ cols: ["tenant_id", "kind", "name"], unique: true, name: "uq_hr_letter_template" }]);
  await mk("hr_letters", {
    number: str(20), employee_id: uuid(false), template_id: uuid(), kind: str(30), subject: str(200), body: { type: DataTypes.TEXT, allowNull: false }, status: { type: DataTypes.ENUM("draft", "issued", "emailed"), allowNull: false, defaultValue: "draft" },
    issued_by: uuid(), issued_at: dt(), emailed_at: dt(), emailed_to: str(254, true), email_error: str(300, true), ...ts(),
  }, [{ cols: ["tenant_id", "number"], unique: true, name: "uq_hr_letter_number" }, { cols: ["tenant_id", "employee_id"], name: "ix_hr_letter_emp" }]);
  await step(() => tenantFk(sequelize, "hr_letters", "employee_id", "hr_employees", "CASCADE"));

  await mk("hr_documents", {
    employee_id: uuid(), title: str(160), category: str(40), storage_key: str(300), file_name: str(200), mime: str(100), size_bytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    expires_on: date(), visibility: { type: DataTypes.ENUM("hr_only", "employee", "company"), allowNull: false, defaultValue: "employee" }, uploaded_by: uuid(), ...ts(),
  }, [{ cols: ["tenant_id", "employee_id"], name: "ix_hr_doc_emp" }, { cols: ["tenant_id", "expires_on"], name: "ix_hr_doc_expiry" }]);
  await step(() => tenantFk(sequelize, "hr_documents", "employee_id", "hr_employees", "CASCADE"));
  await mk("hr_announcements", { title: str(200), body: { type: DataTypes.TEXT, allowNull: false }, pinned: bool(false), publish_at: dt(false), expires_at: dt(), created_by: uuid(), ...ts() }, [{ cols: ["tenant_id", "publish_at"], name: "ix_hr_announce" }]);
  await mk("hr_occasions", { title: str(160), on_date: date(false), kind: { type: DataTypes.ENUM("celebration", "event", "holiday_notice", "other"), allowNull: false, defaultValue: "celebration" }, message: str(500, true), yearly: bool(false), created_by: uuid(), ...ts() }, [{ cols: ["tenant_id", "on_date"], name: "ix_hr_occasion_date" }]);
}

export async function down({ context: qi }: Ctx) {
  for (const t of ["hr_occasions", "hr_announcements", "hr_documents", "hr_letters", "hr_letter_templates", "hr_breaks", "hr_attendance", "hr_holidays", "hr_leave_requests", "hr_leave_balances", "hr_leave_types", "hr_salaries", "hr_employees", "hr_shifts"]) await qi.dropTable(t);
}

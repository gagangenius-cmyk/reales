import { z } from "zod";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optDate = date.nullable().optional();
const text = (n: number) => z.string().trim().max(n);

export const employeeSchema = z.object({
  fullName: text(160).min(1), email: text(254).nullable().optional(), phone: text(40).nullable().optional(), designation: text(120).nullable().optional(), department: text(120).nullable().optional(),
  branchId: uuid.nullable().optional(), managerEmployeeId: uuid.nullable().optional(), userId: uuid.nullable().optional(), employmentType: z.enum(["full_time", "part_time", "contract", "intern"]).optional(),
  joinedOn: date, probationEndsOn: optDate, dateOfBirth: optDate, gender: z.enum(["male", "female", "other"]).nullable().optional(), nationality: text(60).nullable().optional(), workLocation: text(120).nullable().optional(),
  shiftId: uuid.nullable().optional(), passportExpiresOn: optDate, visaExpiresOn: optDate, emiratesIdExpiresOn: optDate, labourCardNo: text(40).nullable().optional(), notes: text(500).nullable().optional(),
  status: z.enum(["active", "on_notice", "exited"]).optional(), exitOn: optDate, exitReason: text(300).nullable().optional(),
}).strict();
export const employeePatchSchema = employeeSchema.partial().strict();

export const salarySchema = z.object({
  effectiveFrom: date, currency: z.string().length(3).optional(), basic: z.number().positive(), housing: z.number().min(0).optional(), transport: z.number().min(0).optional(), otherAllowance: z.number().min(0).optional(),
  components: z.array(z.object({ name: text(60).min(1), type: z.enum(["earning", "deduction"]), amount: z.number().min(0) }).strict()).max(20).optional(),
  paymentMethod: z.enum(["bank_transfer", "cash", "cheque"]).optional(), iban: text(40).nullable().optional(), reason: text(200).optional(),
}).strict();

export const shiftSchema = z.object({ id: uuid.optional(), name: text(80).min(1), startTime: z.string().regex(/^\d{2}:\d{2}$/), endTime: z.string().regex(/^\d{2}:\d{2}$/), breakMinutes: z.number().int().min(0).max(240), graceMinutes: z.number().int().min(0).max(120), halfDayMinutes: z.number().int().min(30).max(600), weeklyOff: z.array(z.enum(["sun", "mon", "tue", "wed", "thu", "fri", "sat"])).max(6), active: z.boolean().optional() }).strict();
export const holidaySchema = z.object({ onDate: date, name: text(120).min(1) }).strict();

export const leaveTypeSchema = z.object({
  id: uuid.optional(), code: z.string().regex(/^[A-Z0-9_]{2,30}$/), name: text(80).min(1), annualDays: z.number().min(0).max(365), accrual: z.enum(["upfront", "monthly"]), carryForwardMax: z.number().min(0).max(365), paid: z.boolean(),
  requiresDocumentAfterDays: z.number().int().min(0).max(365), maxConsecutiveDays: z.number().int().min(0).max(365), minNoticeDays: z.number().int().min(0).max(365), gender: z.enum(["any", "male", "female"]), countsWeekends: z.boolean(),
  minServiceMonths: z.number().int().min(0).max(120), active: z.boolean(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
}).strict();
export const leaveRequestSchema = z.object({ employeeId: uuid.optional(), leaveTypeId: uuid, fromDate: date, toDate: date, halfDay: z.enum(["none", "first", "second"]).optional(), reason: text(500).optional() }).strict();
export const leaveDecisionSchema = z.object({ approve: z.boolean(), note: text(300).optional() }).strict();
export const leaveBalanceAdjustSchema = z.object({ leaveTypeId: uuid, year: z.number().int().min(2000).max(2100), adjusted: z.number().min(-365).max(365).optional(), carried: z.number().min(0).max(365).optional(), note: text(200).min(1) }).strict();
export const leaveListQuery = z.object({ scope: z.enum(["mine", "team", "all"]).default("mine"), status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional() });
export const rangeQuery = z.object({ from: date, to: date, employeeId: uuid.optional() });

export const breakSchema = z.object({ kind: z.enum(["lunch", "tea", "prayer", "other"]).optional() }).strict();
export const noteSchema = z.object({ note: text(300).optional() }).strict();
export const correctionSchema = z.object({ employeeId: uuid, date, checkInAt: z.string().datetime().nullable().optional(), checkOutAt: z.string().datetime().nullable().optional(), status: z.enum(["present", "late", "half_day", "absent", "on_leave", "holiday", "weekly_off"]).optional(), note: text(300).optional(), reason: text(300).min(1) }).strict();

export const letterTemplateSchema = z.object({ id: uuid.optional(), kind: z.string().max(30), name: text(120).min(1), subject: text(200).min(1), body: z.string().min(1).max(20000), active: z.boolean().optional() }).strict();
export const letterCreateSchema = z.object({ employeeId: uuid, templateId: uuid, vars: z.record(z.string().max(40), z.string().max(1000)).optional() }).strict();
export const letterPatchSchema = z.object({ subject: text(200).optional(), body: z.string().max(20000).optional() }).strict();
export const letterEmailSchema = z.object({ to: z.string().email().max(254).optional() }).strict();

export const announcementSchema = z.object({ id: uuid.optional(), title: text(200).min(1), body: z.string().trim().min(1).max(5000), pinned: z.boolean().optional(), publishAt: z.string().datetime().optional(), expiresAt: z.string().datetime().nullable().optional() }).strict();
export const occasionSchema = z.object({ id: uuid.optional(), title: text(160).min(1), onDate: date, kind: z.enum(["celebration", "event", "holiday_notice", "other"]).optional(), message: text(500).nullable().optional(), yearly: z.boolean().optional() }).strict();
export const employeeListQuery = z.object({ q: z.string().max(100).optional(), status: z.enum(["active", "on_notice", "exited"]).optional(), department: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() });
export const docListQuery = z.object({ employeeId: uuid.optional(), category: z.string().max(40).optional(), expiringWithinDays: z.coerce.number().int().min(0).max(730).optional() });

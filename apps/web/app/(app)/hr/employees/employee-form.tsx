"use client";

import { useState } from "react";
import { Lbl, useAction } from "@/components/hr-ui";

export interface EmpValues {
  fullName: string; email: string; phone: string; designation: string; department: string; employmentType: string; joinedOn: string; probationEndsOn: string; dateOfBirth: string; gender: string; nationality: string; workLocation: string;
  shiftId: string; managerEmployeeId: string; userId: string; passportExpiresOn: string; visaExpiresOn: string; emiratesIdExpiresOn: string; labourCardNo: string; notes: string; status: string; exitOn: string; exitReason: string;
}
export const EMPTY: EmpValues = { fullName: "", email: "", phone: "", designation: "", department: "", employmentType: "full_time", joinedOn: "", probationEndsOn: "", dateOfBirth: "", gender: "", nationality: "", workLocation: "", shiftId: "", managerEmployeeId: "", userId: "", passportExpiresOn: "", visaExpiresOn: "", emiratesIdExpiresOn: "", labourCardNo: "", notes: "", status: "active", exitOn: "", exitReason: "" };

/** Create (no id) or edit (with id) an employee. Empty fields are sent as null so they can be cleared. */
export function EmployeeForm({ id, initial, shifts, users, managers }: { id?: string; initial?: Partial<EmpValues>; shifts: { id: string; name: string }[]; users: { id: string; email: string }[]; managers: { id: string; name: string }[] }) {
  const { busy, run, Msg, post } = useAction();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<EmpValues>({ ...EMPTY, ...initial });
  const set = (k: keyof EmpValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  const nul = (s: string) => (s.trim() === "" ? null : s.trim());
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      fullName: v.fullName.trim(), email: nul(v.email), phone: nul(v.phone), designation: nul(v.designation), department: nul(v.department), employmentType: v.employmentType, joinedOn: v.joinedOn, probationEndsOn: nul(v.probationEndsOn), dateOfBirth: nul(v.dateOfBirth),
      gender: nul(v.gender), nationality: nul(v.nationality), workLocation: nul(v.workLocation), shiftId: nul(v.shiftId), managerEmployeeId: nul(v.managerEmployeeId), userId: nul(v.userId), passportExpiresOn: nul(v.passportExpiresOn), visaExpiresOn: nul(v.visaExpiresOn),
      emiratesIdExpiresOn: nul(v.emiratesIdExpiresOn), labourCardNo: nul(v.labourCardNo), notes: nul(v.notes), ...(id ? { status: v.status, exitOn: nul(v.exitOn), exitReason: nul(v.exitReason) } : {}),
    };
    if (await run(() => post(id ? `/api/v1/hr/employees/${id}` : "/api/v1/hr/employees", body, id ? "PATCH" : "POST"), id ? "Saved." : "Employee added.")) { setOpen(false); if (!id) setV({ ...EMPTY }); }
  }
  return (
    <>
      <button className={id ? "btn-ghost" : "btn"} onClick={() => setOpen(true)}>{id ? "Edit profile" : "+ Add employee"}</button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={id ? "Edit employee" : "Add employee"}>
          <button className="absolute inset-0 bg-black/50" aria-label="Close" tabIndex={-1} onClick={() => setOpen(false)} />
          <form onSubmit={submit} className="relative flex h-full w-full max-w-3xl flex-col shadow-2xl" style={{ background: "var(--bg)" }}>
            <header className="border-b px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}><h2 className="text-xl font-semibold">{id ? "Edit employee" : "Add employee"}</h2></header>
            <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-6">
              <section className="card grid gap-4 p-4 sm:grid-cols-2"><h3 className="font-semibold sm:col-span-2">Job</h3>
                <Lbl label="Full name" wide><input className="input" required maxLength={160} value={v.fullName} onChange={set("fullName")} /></Lbl>
                <Lbl label="Designation"><input className="input" value={v.designation} onChange={set("designation")} /></Lbl>
                <Lbl label="Department"><input className="input" value={v.department} onChange={set("department")} /></Lbl>
                <Lbl label="Joining date"><input className="input" type="date" required value={v.joinedOn} onChange={set("joinedOn")} /></Lbl>
                <Lbl label="Probation ends"><input className="input" type="date" value={v.probationEndsOn} onChange={set("probationEndsOn")} /></Lbl>
                <Lbl label="Employment type"><select className="input" value={v.employmentType} onChange={set("employmentType")}><option value="full_time">Full time</option><option value="part_time">Part time</option><option value="contract">Contract</option><option value="intern">Intern</option></select></Lbl>
                <Lbl label="Shift"><select className="input" value={v.shiftId} onChange={set("shiftId")}><option value="">Default shift</option>{shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Lbl>
                <Lbl label="Reports to"><select className="input" value={v.managerEmployeeId} onChange={set("managerEmployeeId")}><option value="">Nobody</option>{managers.filter((m) => m.id !== id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Lbl>
                <Lbl label="Work location"><input className="input" value={v.workLocation} onChange={set("workLocation")} /></Lbl>
                <Lbl label="CRM login (so they can check in)" wide><select className="input" value={v.userId} onChange={set("userId")}><option value="">Not linked</option>{users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}</select></Lbl>
              </section>
              <section className="card grid gap-4 p-4 sm:grid-cols-2"><h3 className="font-semibold sm:col-span-2">Personal and documents</h3>
                <Lbl label="E-mail"><input className="input" type="email" value={v.email} onChange={set("email")} /></Lbl>
                <Lbl label="Phone"><input className="input" value={v.phone} onChange={set("phone")} /></Lbl>
                <Lbl label="Date of birth"><input className="input" type="date" value={v.dateOfBirth} onChange={set("dateOfBirth")} /></Lbl>
                <Lbl label="Gender"><select className="input" value={v.gender} onChange={set("gender")}><option value="">Not stated</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option></select></Lbl>
                <Lbl label="Nationality"><input className="input" value={v.nationality} onChange={set("nationality")} /></Lbl>
                <Lbl label="Labour card no."><input className="input" value={v.labourCardNo} onChange={set("labourCardNo")} /></Lbl>
                <Lbl label="Passport expires"><input className="input" type="date" value={v.passportExpiresOn} onChange={set("passportExpiresOn")} /></Lbl>
                <Lbl label="Visa expires"><input className="input" type="date" value={v.visaExpiresOn} onChange={set("visaExpiresOn")} /></Lbl>
                <Lbl label="Emirates ID expires"><input className="input" type="date" value={v.emiratesIdExpiresOn} onChange={set("emiratesIdExpiresOn")} /></Lbl>
                <Lbl label="Notes" wide><textarea className="input" maxLength={500} value={v.notes} onChange={set("notes")} /></Lbl>
              </section>
              {id && (
                <section className="card grid gap-4 p-4 sm:grid-cols-2"><h3 className="font-semibold sm:col-span-2">Status</h3>
                  <Lbl label="Employment status"><select className="input" value={v.status} onChange={set("status")}><option value="active">Active</option><option value="on_notice">On notice</option><option value="exited">Exited</option></select></Lbl>
                  <Lbl label="Last working day"><input className="input" type="date" value={v.exitOn} onChange={set("exitOn")} /></Lbl>
                  <Lbl label="Reason for leaving" wide><input className="input" maxLength={300} value={v.exitReason} onChange={set("exitReason")} /></Lbl>
                </section>
              )}
            </div>
            <footer className="flex items-center justify-between gap-3 border-t px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}><div className="min-w-0 flex-1"><Msg /></div><div className="flex gap-2"><button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button><button className="btn" disabled={busy}>{busy ? "Saving..." : "Save"}</button></div></footer>
          </form>
        </div>
      )}
    </>
  );
}

import { DataTypes } from "sequelize";
import { Ctx, str, dt } from "./_helpers";

/** The detail a brokerage actually records about a person and about their enquiry. All columns are optional so existing rows are untouched. */
export async function up({ context: qi }: Ctx) {
  const c = (name: string, def: Parameters<typeof qi.addColumn>[2]) => qi.addColumn("contacts", name, def);
  await c("salutation", str(20, true));
  await c("gender", { type: DataTypes.ENUM("male", "female", "other"), allowNull: true });
  await c("date_of_birth", { type: DataTypes.DATEONLY, allowNull: true });
  await c("job_title", str(120, true));
  await c("employer", str(160, true));
  await c("phone_secondary", str(32, true));
  await c("whatsapp_e164", str(32, true));
  await c("address_line", str(255, true));
  await c("city", str(80, true));
  await c("country", str(80, true));
  await c("residency", { type: DataTypes.ENUM("uae_resident", "non_resident"), allowNull: true });
  await c("preferred_channel", { type: DataTypes.ENUM("phone", "whatsapp", "email", "sms"), allowNull: true });
  await c("preferred_contact_time", str(60, true));
  await c("tags", { type: DataTypes.JSON, allowNull: true });
  await c("notes", { type: DataTypes.TEXT, allowNull: true });
  await c("last_contacted_at", dt());

  const l = (name: string, def: Parameters<typeof qi.addColumn>[2]) => qi.addColumn("leads", name, def);
  await l("financing", { type: DataTypes.ENUM("cash", "mortgage", "undecided"), allowNull: true });
  await l("purchase_timeline", { type: DataTypes.ENUM("immediate", "one_to_three_months", "three_to_six_months", "over_six_months", "exploring"), allowNull: true });
  await l("property_types", { type: DataTypes.JSON, allowNull: true });
  await l("tags", { type: DataTypes.JSON, allowNull: true });
  await l("notes", { type: DataTypes.TEXT, allowNull: true });
  await l("next_follow_up_at", dt());
  await l("last_contacted_at", dt());
  await l("expected_close_date", { type: DataTypes.DATEONLY, allowNull: true });
  await qi.addIndex("leads", ["tenant_id", "assigned_user_id", "next_follow_up_at"], { name: "ix_leads_tenant_followup" });
}

export async function down({ context: qi }: Ctx) {
  await qi.removeIndex("leads", "ix_leads_tenant_followup");
  for (const col of ["expected_close_date", "last_contacted_at", "next_follow_up_at", "notes", "tags", "property_types", "purchase_timeline", "financing"]) await qi.removeColumn("leads", col);
  for (const col of ["last_contacted_at", "notes", "tags", "preferred_contact_time", "preferred_channel", "residency", "country", "city", "address_line", "whatsapp_e164", "phone_secondary", "employer", "job_title", "date_of_birth", "gender", "salutation"]) await qi.removeColumn("contacts", col);
}

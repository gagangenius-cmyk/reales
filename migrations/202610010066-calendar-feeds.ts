import { Ctx, id, ts, str, tenantId, uuid, tenantKey, step } from "./_helpers";

/** One secret subscription link per user so Google Calendar, Outlook and Apple Calendar can follow their CRM agenda. */
export async function up({ context: qi }: Ctx) {
  await step(() => qi.createTable("calendar_feeds", { id: id(), tenant_id: tenantId(), user_id: uuid(false), token: str(48), ...ts() }));
  await step(() => tenantKey(qi, "calendar_feeds"));
  await step(() => qi.addIndex("calendar_feeds", ["token"], { unique: true, name: "uq_calendar_feeds_token" }));
  await step(() => qi.addIndex("calendar_feeds", ["tenant_id", "user_id"], { unique: true, name: "uq_calendar_feeds_user" }));
}
export async function down({ context: qi }: Ctx) { await qi.dropTable("calendar_feeds"); }

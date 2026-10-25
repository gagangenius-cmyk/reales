import { Ctx, str, step } from "./_helpers";

/** The telephony provider's call id, so a status callback delivered twice (providers retry) records the call once. */
export async function up({ context: qi }: Ctx) {
  await step(() => qi.addColumn("call_logs", "provider_sid", str(64, true)));
  await step(() => qi.addIndex("call_logs", ["tenant_id", "provider_sid"], { unique: true, name: "uq_call_logs_provider_sid" }));
}
export async function down({ context: qi }: Ctx) { await qi.removeIndex("call_logs", "uq_call_logs_provider_sid"); await qi.removeColumn("call_logs", "provider_sid"); }

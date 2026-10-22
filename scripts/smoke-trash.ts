import "dotenv/config";
import { QueryTypes } from "sequelize";
import { PERMISSIONS } from "../packages/rbac/src";
import { closeSequelize, getSequelize, type RequestContext } from "../packages/database/src";
import { listTrash, purgeRecord, restoreRecord, softDelete, TRASH_ENTITIES, TRASH_KEYS } from "../packages/domain/src";

/** Read-mostly check that every trash entity's SQL (title, scope columns, guards) matches the real schema. Deleting a random id touches nothing. */
async function main() {
  const sq = getSequelize();
  const [t] = await sq.query<{ id: string }>("SELECT id FROM tenants LIMIT 1", { type: QueryTypes.SELECT });
  const ctx: RequestContext = { tenantId: t!.id, userId: "00000000-0000-0000-0000-000000000000", sessionId: "smoke", correlationId: "smoke", grants: (Object.keys(PERMISSIONS) as string[]).map((permission) => ({ permission, scope: "tenant" as const })), membership: { businessUnitIds: [], branchIds: [], projectIds: [], portfolioIds: [] }, stepUpValid: false };
  console.log("trash total", (await listTrash(sq, ctx, {}).catch((e) => { console.log("list failed:", e?.original?.sqlMessage ?? e.message); return { total: -1 }; })).total);
  const missing = "11111111-1111-1111-1111-111111111111";
  for (const k of TRASH_KEYS) {
    try { await softDelete(sq, ctx, k, missing); console.log(k, "UNEXPECTED success"); }
    catch (e: any) { if (e.name !== "NotFoundError") console.log(k, "delete ->", e?.original?.sqlMessage ?? e.message); }
    try { await restoreRecord(sq, ctx, k, missing); } catch (e: any) { if (e.name !== "NotFoundError") console.log(k, "restore ->", e?.original?.sqlMessage ?? e.message); }
    await listTrash(sq, ctx, { entity: k, q: "x" }).catch((e) => console.log(k, "list ->", e?.original?.sqlMessage ?? e.message));
  }
  // guards: run each against a missing id (SQL must be valid and return null)
  const q = (sql: string, rep: Record<string, unknown> = {}) => sq.query(sql, { replacements: { t: ctx.tenantId, ...rep }, type: QueryTypes.SELECT }) as Promise<any[]>;
  for (const [k, e] of Object.entries(TRASH_ENTITIES)) if (e.guard) { try { const r = await e.guard(q, missing); if (r) console.log(k, "guard blocked a missing id?", r); } catch (err: any) { console.log(k, "guard ->", err?.original?.sqlMessage ?? err.message); } }
  // full round trip on a throwaway organisation
  const id = crypto.randomUUID();
  await sq.query("INSERT INTO organizations (id, tenant_id, name, country, created_at, updated_at) VALUES (:id, :t, 'zz smoke org', 'AE', NOW(3), NOW(3))", { replacements: { id, t: ctx.tenantId } });
  try {
    await softDelete(sq, ctx, "organization", id, "smoke");
    const inTrash = (await listTrash(sq, ctx, { entity: "organization", q: "zz smoke" })).rows.some((r) => r.id === id);
    const [still] = await sq.query("SELECT COUNT(*) n FROM organizations WHERE id=:id AND deleted_at IS NULL", { replacements: { id }, type: QueryTypes.SELECT }) as any[];
    await restoreRecord(sq, ctx, "organization", id);
    const [back] = await sq.query("SELECT COUNT(*) n FROM organizations WHERE id=:id AND deleted_at IS NULL", { replacements: { id }, type: QueryTypes.SELECT }) as any[];
    await softDelete(sq, ctx, "organization", id);
    await purgeRecord(sq, ctx, "organization", id);
    const [gone] = await sq.query("SELECT COUNT(*) n FROM organizations WHERE id=:id", { replacements: { id }, type: QueryTypes.SELECT }) as any[];
    console.log("round trip: inTrash", inTrash, "liveWhileDeleted", still.n, "liveAfterRestore", back.n, "afterPurge", gone.n);
  } finally { await sq.query("DELETE FROM organizations WHERE id=:id", { replacements: { id } }); }
  console.log("done", TRASH_KEYS.length);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => closeSequelize());

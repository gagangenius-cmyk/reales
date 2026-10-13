import { randomUUID } from "node:crypto";
import { QueryTypes } from "sequelize";
import { testDb } from "../helpers";

type T = { tenantId: string };
const sq = () => testDb();

export async function createContact(t: T): Promise<string> {
  const id = randomUUID();
  await sq().query("INSERT INTO contacts (id, tenant_id, type, first_name, status, created_at, updated_at) VALUES (:id, :t, 'person', 'X', 'active', NOW(3), NOW(3))", { replacements: { id, t: t.tenantId } });
  return id;
}

export async function createProject(t: T): Promise<string> {
  const id = randomUUID();
  await sq().query("INSERT INTO projects (id, tenant_id, kind, code, name, status, created_at, updated_at) VALUES (:id, :t, 'project', :code, 'P', 'active', NOW(3), NOW(3))", { replacements: { id, t: t.tenantId, code: `P${id.slice(0, 6)}` } });
  return id;
}

/** The default pipeline and its first stage, created by tenant bootstrap. */
export async function createPipelineIds(tenantId: string) {
  const [p] = await sq().query<{ id: string }>("SELECT id FROM pipelines WHERE tenant_id=:t AND is_default=1", { replacements: { t: tenantId }, type: QueryTypes.SELECT });
  const [s] = await sq().query<{ id: string }>("SELECT id FROM pipeline_stages WHERE tenant_id=:t AND pipeline_id=:p ORDER BY position LIMIT 1", { replacements: { t: tenantId, p: p!.id }, type: QueryTypes.SELECT });
  return { pipelineId: p!.id, stageId: s!.id };
}

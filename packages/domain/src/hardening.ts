import { randomUUID } from "node:crypto";
import { QueryTypes, Sequelize } from "sequelize";
import { mysqlDate, RequestContext } from "@reales/database";
import { authorize, hasPermission, ForbiddenError } from "@reales/rbac";
import { plain } from "./scope";
import { syncInspection, type Mutation } from "./inspections";
import { ConflictError, NotFoundError, QuotaExceededError, Uow, withUow } from "./uow";

// ---------------------------------------------------------------- data-processing policy and sub-processor register
export interface PolicyInput { allowedRegions: string[]; allowCrossBorder?: boolean; requireRegisteredProviders?: boolean }

export async function setDataProcessingPolicy(sq: Sequelize, ctx: RequestContext, i: PolicyInput) {
  authorize(ctx, "dataprocessing.manage");
  const regions = [...new Set(i.allowedRegions.map((r) => r.trim().toLowerCase()).filter(Boolean))];
  if (!regions.length) throw new ConflictError("At least one allowed region is required");
  return withUow(sq, ctx, async (u) => {
    const ex: any = await u.repo("DataProcessingPolicy").findOne({ transaction: u.tx });
    const values = { allowedRegions: regions, allowCrossBorder: !!i.allowCrossBorder, requireRegisteredProviders: i.requireRegisteredProviders ?? true, updatedBy: ctx.userId };
    if (ex) await u.repo("DataProcessingPolicy").updateById(ex.get("id"), values, { transaction: u.tx });
    else await u.repo("DataProcessingPolicy").create({ id: randomUUID(), ...values }, { transaction: u.tx });
    await u.audit({ action: "dataprocessing.policy_set", entityType: "tenant", entityId: ctx.tenantId, after: values });
    return plain(await u.repo("DataProcessingPolicy").findOne({ transaction: u.tx }));
  });
}

export async function getDataProcessingPolicy(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "dataprocessing.manage");
  return withUow(sq, ctx, async (u) => {
    const p = await u.repo("DataProcessingPolicy").findOne({ transaction: u.tx });
    return p ? plain(p) : null;
  });
}

export async function upsertSubprocessor(sq: Sequelize, ctx: RequestContext, i: { code: string; name: string; purpose: string; region: string; status: "approved" | "pending" | "blocked"; dpaSignedOn?: string }) {
  authorize(ctx, "dataprocessing.manage");
  if (i.status === "approved" && !i.dpaSignedOn) throw new ConflictError("A signed data-processing agreement date is required to approve a sub-processor");
  return withUow(sq, ctx, async (u) => {
    const ex: any = await u.repo("Subprocessor").findOne({ where: { code: i.code }, transaction: u.tx });
    const values = { name: i.name, purpose: i.purpose, region: i.region.trim().toLowerCase(), status: i.status, dpaSignedOn: i.dpaSignedOn ?? null };
    if (ex) await u.repo("Subprocessor").updateById(ex.get("id"), values, { transaction: u.tx });
    else await u.repo("Subprocessor").create({ id: randomUUID(), code: i.code, ...values }, { transaction: u.tx });
    await u.audit({ action: "subprocessor.upserted", entityType: "subprocessor", entityId: i.code, after: values });
    return plain(await u.repo("Subprocessor").findOne({ where: { code: i.code }, transaction: u.tx }));
  });
}

export async function listSubprocessors(sq: Sequelize, ctx: RequestContext) {
  authorize(ctx, "dataprocessing.manage");
  return withUow(sq, ctx, async (u) => (await u.repo("Subprocessor").findAll({ order: [["name", "ASC"]], transaction: u.tx })).map(plain));
}

export class ProviderNotAllowedError extends Error {
  status = 422;
  constructor(public provider: string, public reason: string) { super(`Provider "${provider}" is not allowed: ${reason}`); this.name = "ProviderNotAllowedError"; }
}

/**
 * Called before data is sent to an external provider. With no policy configured nothing is restricted (existing behaviour).
 * With a policy: the provider must be a registered, approved sub-processor (unless the tenant disables that rule) and its processing
 * region must be inside the allowed regions unless cross-border transfer is explicitly permitted.
 */
export async function assertProviderAllowed(u: Uow, providerCode: string): Promise<void> {
  const pol: any = await u.repo("DataProcessingPolicy").findOne({ transaction: u.tx });
  if (!pol) return;
  const sp: any = await u.repo("Subprocessor").findOne({ where: { code: providerCode }, transaction: u.tx });
  if (!sp) {
    if (pol.get("requireRegisteredProviders")) throw new ProviderNotAllowedError(providerCode, "not in the sub-processor register");
    return;
  }
  if (sp.get("status") === "blocked") throw new ProviderNotAllowedError(providerCode, "blocked by the tenant");
  if (sp.get("status") !== "approved" && pol.get("requireRegisteredProviders")) throw new ProviderNotAllowedError(providerCode, "pending approval");
  const regions = pol.get("allowedRegions") as string[];
  if (!pol.get("allowCrossBorder") && !regions.includes(sp.get("region"))) throw new ProviderNotAllowedError(providerCode, `processes data in ${sp.get("region")}, outside the allowed regions (${regions.join(", ")})`);
}

// ---------------------------------------------------------------- usage metering and quotas
export const period = (d = new Date()) => d.toISOString().slice(0, 7);
/** A monthly cap is configured as quota key `<meter>.monthly`. No row means unlimited. */
export const monthlyQuotaKey = (meter: string) => `${meter}.monthly`;

export async function meterUsageInUow(u: Uow, meter: string, qty = 1, at = new Date()): Promise<void> {
  await u.sq.query(
    "INSERT INTO usage_meters (id, tenant_id, meter_key, period, value, created_at, updated_at) VALUES (UUID(), :t, :m, :p, :q, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE value = value + :q, updated_at = NOW(3)",
    { replacements: { t: u.tenantId, m: meter, p: period(at), q: qty }, transaction: u.tx },
  );
}

export async function meterUsage(sq: Sequelize, tenantId: string, meter: string, qty = 1, at = new Date()): Promise<void> {
  await sq.query(
    "INSERT INTO usage_meters (id, tenant_id, meter_key, period, value, created_at, updated_at) VALUES (UUID(), :t, :m, :p, :q, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE value = value + :q, updated_at = NOW(3)",
    { replacements: { t: tenantId, m: meter, p: period(at), q: qty } },
  );
}

export async function currentUsage(sq: Sequelize, tenantId: string, meter: string, at = new Date()): Promise<number> {
  const r = await sq.query<{ value: string }>("SELECT value FROM usage_meters WHERE tenant_id=:t AND meter_key=:m AND period=:p", { replacements: { t: tenantId, m: meter, p: period(at) }, type: QueryTypes.SELECT });
  return Number(r[0]?.value ?? 0);
}

/** Returns the remaining allowance, or null when the meter has no monthly cap. */
export async function remainingQuota(sq: Sequelize, tenantId: string, meter: string): Promise<number | null> {
  const q = await sq.query<{ limit_value: string }>("SELECT limit_value FROM tenant_quotas WHERE tenant_id=:t AND quota_key=:k", { replacements: { t: tenantId, k: monthlyQuotaKey(meter) }, type: QueryTypes.SELECT });
  if (!q[0]) return null;
  return Math.max(0, Number(q[0].limit_value) - (await currentUsage(sq, tenantId, meter)));
}

export async function assertWithinQuota(sq: Sequelize, tenantId: string, meter: string, qty = 1): Promise<void> {
  const left = await remainingQuota(sq, tenantId, meter);
  if (left !== null && qty > left) throw new QuotaExceededError(monthlyQuotaKey(meter), Number((await sq.query<any>("SELECT limit_value FROM tenant_quotas WHERE tenant_id=:t AND quota_key=:k", { replacements: { t: tenantId, k: monthlyQuotaKey(meter) }, type: QueryTypes.SELECT }))[0].limit_value));
}

export async function setMonthlyQuota(sq: Sequelize, ctx: RequestContext, meter: string, limit: number | null) {
  authorize(ctx, "quota.manage");
  if (!/^[a-z_]{2,40}$/.test(meter)) throw new ConflictError("Invalid meter");
  if (limit !== null && !(Number.isInteger(limit) && limit >= 0)) throw new ConflictError("The limit must be a non-negative integer");
  return withUow(sq, ctx, async (u) => {
    if (limit === null) await u.sq.query("DELETE FROM tenant_quotas WHERE tenant_id=:t AND quota_key=:k", { replacements: { t: ctx.tenantId, k: monthlyQuotaKey(meter) }, transaction: u.tx });
    else await u.sq.query("INSERT INTO tenant_quotas (id, tenant_id, quota_key, limit_value, created_at, updated_at) VALUES (UUID(), :t, :k, :l, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE limit_value=:l, updated_at=NOW(3)", { replacements: { t: ctx.tenantId, k: monthlyQuotaKey(meter), l: limit }, transaction: u.tx });
    await u.audit({ action: "quota.set", entityType: "tenant", entityId: ctx.tenantId, after: { meter, limit } });
    return { meter, limit };
  });
}

export async function getUsageSummary(sq: Sequelize, ctx: RequestContext) {
  if (!hasPermission(ctx, "usage.read")) throw new ForbiddenError("Missing permission: usage.read");
  const p = period();
  const usage = await sq.query<{ meter_key: string; value: string }>("SELECT meter_key, value FROM usage_meters WHERE tenant_id=:t AND period=:p ORDER BY meter_key", { replacements: { t: ctx.tenantId, p }, type: QueryTypes.SELECT });
  const quotas = await sq.query<{ quota_key: string; limit_value: string }>("SELECT quota_key, limit_value FROM tenant_quotas WHERE tenant_id=:t AND quota_key LIKE '%.monthly'", { replacements: { t: ctx.tenantId }, type: QueryTypes.SELECT });
  const limits = new Map(quotas.map((q) => [q.quota_key.replace(/\.monthly$/, ""), Number(q.limit_value)]));
  const meters = new Set([...usage.map((x) => x.meter_key), ...limits.keys()]);
  return { period: p, meters: [...meters].sort().map((m) => ({ meter: m, used: Number(usage.find((x) => x.meter_key === m)?.value ?? 0), limit: limits.get(m) ?? null })) };
}

// ---------------------------------------------------------------- mobile devices and offline sync
export async function registerDevice(sq: Sequelize, ctx: RequestContext, i: { deviceId: string; name?: string; platform: "ios" | "android" | "web" }) {
  if (!hasPermission(ctx, "mobile.sync")) throw new ForbiddenError("Missing permission: mobile.sync");
  return withUow(sq, ctx, async (u) => {
    const ex: any = await u.repo("MobileDevice").findOne({ where: { deviceId: i.deviceId }, transaction: u.tx });
    if (ex) {
      if (ex.get("userId") !== ctx.userId) throw new ConflictError("This device is registered to another user");
      if (ex.get("status") === "revoked") throw new ConflictError("This device has been revoked");
      return plain(ex);
    }
    const id = randomUUID();
    await u.repo("MobileDevice").create({ id, userId: ctx.userId, deviceId: i.deviceId, name: i.name ?? null, platform: i.platform, status: "active" }, { transaction: u.tx });
    await u.audit({ action: "mobile.device_registered", entityType: "mobile_device", entityId: id, after: { platform: i.platform } });
    return plain(await u.repo("MobileDevice").findById(id, { transaction: u.tx }));
  });
}

/** Lost phone: revoke it and every server-side session of that user's device keeps working only through the web login. Own devices, or user.update for others. */
export async function revokeDevice(sq: Sequelize, ctx: RequestContext, id: string) {
  return withUow(sq, ctx, async (u) => {
    const d: any = await u.repo("MobileDevice").findById(id, { transaction: u.tx });
    if (!d) throw new NotFoundError("Device");
    if (d.get("userId") !== ctx.userId && !hasPermission(ctx, "user.update")) throw new ForbiddenError("Missing permission: user.update");
    await u.repo("MobileDevice").updateById(id, { status: "revoked", revokedAt: new Date() }, { transaction: u.tx });
    await u.audit({ action: "mobile.device_revoked", entityType: "mobile_device", entityId: id, after: { userId: d.get("userId") } });
    return plain(await u.repo("MobileDevice").findById(id, { transaction: u.tx }));
  });
}

export async function listMyDevices(sq: Sequelize, ctx: RequestContext) {
  return withUow(sq, ctx, async (u) => (await u.repo("MobileDevice").findAll({ where: { userId: ctx.userId }, order: [["createdAt", "DESC"]], transaction: u.tx })).map(plain));
}

export type MobileMutationInput = { clientMutationId: string; kind: "inspection.sync"; payload: { inspectionId: string; mutations: Mutation[] } };
export interface MobileResult { clientMutationId: string; status: "applied" | "conflict" | "rejected" | "duplicate"; detail?: unknown }

/**
 * Batch sync from a registered device. Each client mutation id is journalled once per device, so a retried upload after a flaky connection
 * returns the stored outcome instead of re-applying. Domain rules (permissions, scope, version conflicts) are enforced by the underlying call.
 */
export async function mobileSync(sq: Sequelize, ctx: RequestContext, deviceId: string, batch: MobileMutationInput[]): Promise<{ results: MobileResult[] }> {
  if (!hasPermission(ctx, "mobile.sync")) throw new ForbiddenError("Missing permission: mobile.sync");
  const device: any = await withUow(sq, ctx, async (u) => u.repo("MobileDevice").findOne({ where: { deviceId, userId: ctx.userId }, transaction: u.tx }));
  if (!device) throw new NotFoundError("Device");
  if (device.get("status") !== "active") throw new ForbiddenError("This device has been revoked");
  const results: MobileResult[] = [];
  for (const m of batch) {
    const seen: any = await withUow(sq, ctx, async (u) => u.repo("MobileMutation").findOne({ where: { deviceId: device.get("id"), clientMutationId: m.clientMutationId }, transaction: u.tx }));
    if (seen) { results.push({ clientMutationId: m.clientMutationId, status: "duplicate", detail: seen.get("result") }); continue; }
    let status: "applied" | "conflict" | "rejected" = "applied";
    let detail: unknown;
    try {
      if (m.kind === "inspection.sync") {
        const r = await syncInspection(sq, ctx, m.payload.inspectionId, m.payload.mutations);
        detail = r;
        if (r.conflicts.length) status = "conflict";
      } else throw new ConflictError("Unknown mutation kind");
    } catch (e) {
      if (e instanceof ForbiddenError || e instanceof NotFoundError || e instanceof ConflictError) { status = "rejected"; detail = { error: (e as Error).message }; } else throw e;
    }
    await withUow(sq, ctx, async (u) => {
      await u.repo("MobileMutation").create({ id: randomUUID(), deviceId: device.get("id"), clientMutationId: m.clientMutationId, kind: m.kind, status, result: detail ?? null, createdAt: mysqlDate(new Date()) }, { transaction: u.tx });
      await u.repo("MobileDevice").updateById(device.get("id"), { lastSyncAt: new Date() }, { transaction: u.tx });
    });
    results.push({ clientMutationId: m.clientMutationId, status, detail });
  }
  return { results };
}

import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import { recordAudit, verifyAuditChain } from "@reales/database";
import { dispatchOutboxBatch, emitEvent, DomainEvent, EventPublisher } from "@reales/events";
import { createProject, listAuditEvents } from "@reales/domain";
import { closeTestDb, makeTenant, testDb } from "./helpers";

afterAll(closeTestDb);
const sq = () => testDb();

describe("audit log", () => {
  it("records privileged mutations with a verifiable hash chain", async () => {
    const t = await makeTenant();
    await createProject(sq(), t.admin, { code: "AUD1", name: "audited" });
    const events = await listAuditEvents(sq(), t.admin, { limit: 10, offset: 0 });
    expect(events.map((e: any) => e.action)).toEqual(expect.arrayContaining(["project.created", "tenant.created"]));
    expect(await verifyAuditChain(sq(), t.tenantId)).toBeNull();
  });

  it("is append-only at the database level", async () => {
    const t = await makeTenant();
    await expect(sq().query("UPDATE audit_events SET action='x' WHERE tenant_id=:t", { replacements: { t: t.tenantId } })).rejects.toThrow(/append-only/);
    await expect(sq().query("DELETE FROM audit_events WHERE tenant_id=:t", { replacements: { t: t.tenantId } })).rejects.toThrow(/append-only/);
  });

  it("keeps seq gap-free and the chain intact under concurrent writers", async () => {
    const t = await makeTenant();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        sq().transaction((tx) => recordAudit(sq(), tx, { tenantId: t.tenantId, actorId: "u", action: `race.${i}`, correlationId: "c" })),
      ),
    );
    const rows = await sq().query<{ seq: string }>("SELECT seq FROM audit_events WHERE tenant_id=:t ORDER BY seq", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    rows.forEach((r, i) => expect(Number(r.seq)).toBe(i + 1));
    expect(await verifyAuditChain(sq(), t.tenantId)).toBeNull();
  });

  it("rolls the audit entry back together with the business change", async () => {
    const t = await makeTenant();
    await expect(
      sq().transaction(async (tx) => {
        await recordAudit(sq(), tx, { tenantId: t.tenantId, action: "should.vanish", correlationId: "c" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const [r] = await sq().query<{ n: number }>("SELECT COUNT(*) n FROM audit_events WHERE tenant_id=:t AND action='should.vanish'", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    expect(Number(r!.n)).toBe(0);
  });
});

/** Drain like the real dispatcher loop: keep pulling batches until nothing is due (other tests leave pending events in the shared DB). */
async function drain(publisher: EventPublisher, now?: Date) {
  let dispatched = 0, failed = 0;
  for (let i = 0; i < 100; i++) {
    const r = await dispatchOutboxBatch(sq(), publisher, { limit: 200, now });
    dispatched += r.dispatched; failed += r.failed;
    if (r.dispatched === 0 && r.failed === 0) break;
  }
  return { dispatched, failed };
}

describe("transactional outbox", () => {
  const collect = () => {
    const seen: DomainEvent[] = [];
    const publisher: EventPublisher = { publish: async (e) => void seen.push(e) };
    return { seen, publisher };
  };

  it("persists events atomically with the change and dispatches them once", async () => {
    const t = await makeTenant();
    const p = await createProject(sq(), t.admin, { code: "EVT1", name: "evented" });
    const { seen, publisher } = collect();
    await drain(publisher);
    const mine = seen.filter((e) => e.tenantId === t.tenantId && e.aggregateId === p.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ type: "project.created", version: 1, correlationId: t.admin.correlationId, actorId: t.adminId, projectId: p.id });

    const again = collect();
    await drain(again.publisher);
    expect(again.seen.filter((e) => e.aggregateId === p.id)).toHaveLength(0);
  });

  it("does not emit when the business transaction rolls back", async () => {
    const t = await makeTenant();
    await expect(
      sq().transaction(async (tx) => {
        await emitEvent(sq(), tx, t.admin, { type: "ghost.created", aggregateType: "ghost", aggregateId: "g1", payload: {} });
        throw new Error("rollback");
      }),
    ).rejects.toThrow();
    const [r] = await sq().query<{ n: number }>("SELECT COUNT(*) n FROM outbox_events WHERE tenant_id=:t AND type='ghost.created'", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    expect(Number(r!.n)).toBe(0);
  });

  it("retries failed publishes with backoff and never loses the event", async () => {
    const t = await makeTenant();
    await sq().transaction((tx) => emitEvent(sq(), tx, t.admin, { type: "retry.me", aggregateType: "x", aggregateId: "r1", payload: {} }));
    const failing: EventPublisher = { publish: async (e) => { if (e.type === "retry.me") throw new Error("queue down"); } };
    const res = await drain(failing);
    expect(res.failed).toBeGreaterThanOrEqual(1);
    const [row] = await sq().query<any>("SELECT status, attempts, last_error, next_attempt_at FROM outbox_events WHERE tenant_id=:t AND type='retry.me'", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    expect(row).toMatchObject({ status: "pending", attempts: 1, last_error: "queue down" });
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    // Not due yet -> skipped; once due -> delivered
    const notYet = collect();
    await drain(notYet.publisher);
    expect(notYet.seen.filter((e) => e.type === "retry.me")).toHaveLength(0);
    const later = collect();
    await drain(later.publisher, new Date(Date.now() + 60_000));
    expect(later.seen.filter((e) => e.type === "retry.me")).toHaveLength(1);
  });

  it("lets concurrent dispatchers share work without double delivery", async () => {
    const t = await makeTenant();
    for (let i = 0; i < 12; i++) await sq().transaction((tx) => emitEvent(sq(), tx, t.admin, { type: "fanout.item", aggregateType: "x", aggregateId: `f${i}`, payload: { i } }));
    const a = collect();
    const b = collect();
    await Promise.all([drain(a.publisher), drain(b.publisher)]);
    const ids = [...a.seen, ...b.seen].filter((e) => e.type === "fanout.item" && e.tenantId === t.tenantId).map((e) => e.aggregateId);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });
});

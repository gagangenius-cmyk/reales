import { afterAll, describe, expect, it } from "vitest";
import { IdempotencyError, withIdempotency } from "@reales/domain";
import { closeTestDb, makeTenant, testDb, uniq } from "./helpers";

afterAll(closeTestDb);

describe("idempotency keys", () => {
  it("runs once, replays the stored response, and rejects payload mismatch", async () => {
    const t = await makeTenant();
    const key = uniq("k");
    let runs = 0;
    const run = async () => ({ status: 201, body: { id: ++runs } });
    const first = await withIdempotency(testDb(), t.tenantId, "POST /x", key, { a: 1 }, run);
    const replay = await withIdempotency(testDb(), t.tenantId, "POST /x", key, { a: 1 }, run);
    expect(first).toMatchObject({ status: 201, body: { id: 1 }, replayed: false });
    expect(replay).toMatchObject({ status: 201, body: { id: 1 }, replayed: true });
    expect(runs).toBe(1);
    await expect(withIdempotency(testDb(), t.tenantId, "POST /x", key, { a: 2 }, run)).rejects.toMatchObject({ status: 422 });
  });

  it("scopes keys per tenant and releases the key when the first attempt fails", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const key = uniq("k");
    const ok = async () => ({ status: 200, body: { ok: true } });
    await withIdempotency(testDb(), a.tenantId, "s", key, {}, ok);
    expect((await withIdempotency(testDb(), b.tenantId, "s", key, {}, ok)).replayed).toBe(false);

    const k2 = uniq("k");
    await expect(withIdempotency(testDb(), a.tenantId, "s", k2, {}, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect((await withIdempotency(testDb(), a.tenantId, "s", k2, {}, ok)).replayed).toBe(false);
  });

  it("rejects a concurrent duplicate while the first is still running", async () => {
    const t = await makeTenant();
    const key = uniq("k");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = withIdempotency(testDb(), t.tenantId, "s", key, {}, async () => { await gate; return { status: 200, body: 1 }; });
    await new Promise((r) => setTimeout(r, 300));
    await expect(withIdempotency(testDb(), t.tenantId, "s", key, {}, async () => ({ status: 200, body: 2 }))).rejects.toBeInstanceOf(IdempotencyError);
    release();
    await slow;
  });
});

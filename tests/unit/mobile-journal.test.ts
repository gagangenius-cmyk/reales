import { describe, expect, it } from "vitest";
import { MutationJournal, type Fetcher, type KeyValueStore } from "../../packages/mobile-core/src/index";

const memory = (): KeyValueStore & { data: Record<string, string> } => { const data: Record<string, string> = {}; return { data, get: async (k) => data[k] ?? null, set: async (k, v) => { data[k] = v; } }; };
const reply = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const make = (fetcher: Fetcher, store = memory(), token: string | null = "tok") => { let n = 0; return { store, j: new MutationJournal({ store, baseUrl: "https://crm.test/", token: async () => token, fetcher, newId: () => `m${++n}` }) }; };

describe("offline mutation journal", () => {
  it("replays queued changes in order with idempotency keys and the bearer token", async () => {
    const seen: any[] = [];
    const { j } = make(async (url, init) => { seen.push({ url, ...init }); return reply(201); });
    await j.enqueue({ method: "POST", path: "/api/v1/calls", body: { a: 1 } });
    await j.enqueue({ method: "PATCH", path: "/api/v1/leads/1", body: { b: 2 } });
    expect(await j.flush()).toMatchObject({ sent: 2, remaining: 0 });
    expect(seen.map((s) => s.url)).toEqual(["https://crm.test/api/v1/calls", "https://crm.test/api/v1/leads/1"]);
    expect(seen[0].headers).toMatchObject({ authorization: "Bearer tok", "idempotency-key": "m1" });
  });

  it("keeps everything when offline or the server is down, then finishes later, resending the same key", async () => {
    let mode: "down" | "5xx" | "up" = "down"; const keys: string[] = [];
    const { j } = make(async (_u, init) => { keys.push(init.headers["idempotency-key"]!); if (mode === "down") throw new Error("offline"); return reply(mode === "5xx" ? 503 : 200); });
    await j.enqueue({ method: "POST", path: "/api/v1/calls" }); await j.enqueue({ method: "POST", path: "/api/v1/calls" });
    expect(await j.flush()).toMatchObject({ sent: 0, remaining: 2, stoppedBy: "offline" });
    mode = "5xx"; expect(await j.flush()).toMatchObject({ sent: 0, remaining: 2, stoppedBy: "server" });
    mode = "up"; expect(await j.flush()).toMatchObject({ sent: 2, remaining: 0 });
    expect(keys.slice(0, 3)).toEqual(["m1", "m1", "m1"]);
  });

  it("moves a change the server will never accept aside instead of blocking the queue, and hands conflicts to the app", async () => {
    const { j } = make(async (url) => (url.endsWith("/bad") ? reply(422, { error: { message: "Invalid phone" } }) : url.endsWith("/stale") ? reply(409) : reply(200)));
    await j.enqueue({ method: "POST", path: "/api/v1/bad" }); await j.enqueue({ method: "PUT", path: "/api/v1/stale" }); await j.enqueue({ method: "POST", path: "/api/v1/ok" });
    const r = await j.flush();
    expect(r).toMatchObject({ sent: 1, remaining: 0 });
    expect(r.rejected[0]).toMatchObject({ status: 422, message: "Invalid phone" });
    expect(r.conflicts).toHaveLength(1);
    await j.retryConflict(r.conflicts[0]!.id);
    expect(await j.pending()).toHaveLength(1);
    await j.dismissRejected(r.rejected[0]!.id);
    expect(await j.rejected()).toHaveLength(0);
  });

  it("stops on a signed-out session without losing anything, runs one replay at a time, survives a corrupt store, refuses foreign paths", async () => {
    let calls = 0;
    const a = make(async () => { calls++; return reply(401); });
    await a.j.enqueue({ method: "POST", path: "/api/v1/calls" });
    expect(await a.j.flush()).toMatchObject({ remaining: 1, stoppedBy: "auth" });
    const b = make(async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return reply(200); });
    await b.j.enqueue({ method: "POST", path: "/api/v1/calls" });
    const before = calls; const [x, y] = await Promise.all([b.j.flush(), b.j.flush()]);
    expect(x).toBe(y); expect(calls - before).toBe(1);
    const c = make(async () => reply(200), memory(), null);
    await c.j.enqueue({ method: "POST", path: "/api/v1/calls" });
    expect(await c.j.flush()).toMatchObject({ stoppedBy: "auth", remaining: 1 });
    const d = make(async () => reply(200)); d.store.data["reales.journal.v1"] = "{not json";
    expect(await d.j.pending()).toEqual([]);
    await expect(d.j.enqueue({ method: "POST", path: "https://evil.example/x" })).rejects.toThrow(/CRM API/);
  });
});

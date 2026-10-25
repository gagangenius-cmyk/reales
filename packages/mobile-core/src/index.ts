/**
 * Offline mutation journal for the native app (and any other client that can lose its connection). Changes made offline are written to local storage
 * in order, each with an idempotency key, and replayed when the connection returns. The server's idempotency keys make a replay after a half-finished
 * attempt safe. Rules: a network error or a 5xx/429/408 stops the replay and keeps everything for the next try; a 409 conflict is handed to the app
 * (it decides: keep the server version, or re-submit); any other 4xx is a change the server will never accept, so it is moved to the "rejected" list for
 * the person to see instead of blocking the queue forever. Storage and fetch are injected, so the same code runs in React Native, a browser or a test.
 */
export interface KeyValueStore { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> }
export interface Mutation { id: string; method: "POST" | "PUT" | "PATCH" | "DELETE"; path: string; body?: unknown; createdAt: number; attempts: number }
export interface Rejected extends Mutation { status: number; message: string }
export interface FlushResult { sent: number; remaining: number; rejected: Rejected[]; conflicts: Mutation[]; stoppedBy?: "offline" | "server" | "auth" }
export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface JournalOptions { store: KeyValueStore; baseUrl: string; token: () => Promise<string | null>; fetcher?: Fetcher; newId?: () => string; now?: () => number; storageKey?: string }
interface State { queue: Mutation[]; rejected: Rejected[]; conflicts: Mutation[] }

export class MutationJournal {
  private flushing: Promise<FlushResult> | null = null;
  constructor(private o: JournalOptions) {}
  private get key() { return this.o.storageKey ?? "reales.journal.v1"; }
  private async read(): Promise<State> {
    try { const v = JSON.parse((await this.o.store.get(this.key)) ?? "null"); if (v && Array.isArray(v.queue)) return { queue: v.queue, rejected: v.rejected ?? [], conflicts: v.conflicts ?? [] }; } catch { /* corrupt store: start clean rather than crash the app */ }
    return { queue: [], rejected: [], conflicts: [] };
  }
  private write(s: State) { return this.o.store.set(this.key, JSON.stringify(s)); }

  async enqueue(m: { method: Mutation["method"]; path: string; body?: unknown }): Promise<Mutation> {
    if (!m.path.startsWith("/api/v1/")) throw new Error("Only CRM API paths can be queued");
    const s = await this.read();
    const rnd = () => Math.random().toString(36).slice(2, 12);
    const item: Mutation = { id: (this.o.newId ?? (() => `${Date.now().toString(36)}-${rnd()}-${rnd()}`))(), method: m.method, path: m.path, body: m.body, createdAt: (this.o.now ?? Date.now)(), attempts: 0 };
    s.queue.push(item);
    await this.write(s);
    return item;
  }
  async pending() { return (await this.read()).queue; }
  async rejected() { return (await this.read()).rejected; }
  async conflicts() { return (await this.read()).conflicts; }
  async dismissRejected(id: string) { const s = await this.read(); s.rejected = s.rejected.filter((r) => r.id !== id); await this.write(s); }
  /** The app chose to re-submit a conflicted change: it goes back to the end of the queue with a fresh key. */
  async retryConflict(id: string) { const s = await this.read(); const c = s.conflicts.find((x) => x.id === id); if (!c) return; s.conflicts = s.conflicts.filter((x) => x.id !== id); s.queue.push({ ...c, id: `${c.id}-r${c.attempts + 1}`, attempts: 0 }); await this.write(s); }
  async discardConflict(id: string) { const s = await this.read(); s.conflicts = s.conflicts.filter((x) => x.id !== id); await this.write(s); }

  /** Replay in order. Only one replay runs at a time; calling again while one is running returns that same run. */
  flush(): Promise<FlushResult> { return (this.flushing ??= this.run().finally(() => { this.flushing = null; })); }

  private async run(): Promise<FlushResult> {
    const f = this.o.fetcher ?? (fetch as unknown as Fetcher);
    const s = await this.read();
    let sent = 0, stoppedBy: FlushResult["stoppedBy"];
    const token = await this.o.token();
    if (!token) return { sent: 0, remaining: s.queue.length, rejected: s.rejected, conflicts: s.conflicts, stoppedBy: "auth" };
    while (s.queue.length) {
      const m = s.queue[0]!;
      let res;
      try {
        res = await f(`${this.o.baseUrl.replace(/\/+$/, "")}${m.path}`, { method: m.method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": m.id }, body: m.body === undefined ? undefined : JSON.stringify(m.body) });
      } catch { stoppedBy = "offline"; m.attempts++; break; }
      if (res.ok) { s.queue.shift(); sent++; continue; }
      if (res.status === 401) { stoppedBy = "auth"; break; }
      if (res.status === 409) { s.queue.shift(); s.conflicts.push(m); continue; }
      if (res.status >= 500 || res.status === 429 || res.status === 408) { stoppedBy = "server"; m.attempts++; break; }
      const j = await res.json().catch(() => ({}));
      s.queue.shift(); s.rejected.push({ ...m, status: res.status, message: String(j?.error?.message ?? "Rejected by the server").slice(0, 300) });
    }
    await this.write(s);
    return { sent, remaining: s.queue.length, rejected: s.rejected, conflicts: s.conflicts, stoppedBy };
  }
}

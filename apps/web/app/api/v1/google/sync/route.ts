import { syncMyGoogle } from "@reales/domain";
import { api } from "@/lib/api";

export const POST = api({ limit: { limit: 6, windowSec: 60, key: "google-sync" } }, async ({ ctx, sq }) => (await syncMyGoogle(sq, ctx)) ?? { ok: true });

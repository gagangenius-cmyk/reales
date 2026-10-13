import "dotenv/config";
import { getSequelize } from "@reales/database";
import { runSweeps } from "@reales/domain";
import { logger } from "@reales/observability";

process.env.SERVICE_NAME ??= "scheduler";
const INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS ?? 60_000);

async function main() {
  const sq = getSequelize();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  logger.info({ intervalMs: INTERVAL_MS }, "scheduler started");
  while (!stopping) {
    try {
      const results = await runSweeps(sq);
      const acted = results.filter((r) => r.offersExpired || r.reservationsExpired || r.listingsUnpublished || r.workflowsResumed || r.campaignBatches || r.error);
      if (acted.length) logger.info({ acted }, "sweep completed");
    } catch (e) {
      logger.error({ err: e }, "sweep run failed");
    }
    for (let waited = 0; waited < INTERVAL_MS && !stopping; waited += 500) await new Promise((r) => setTimeout(r, 500));
  }
  process.exit(0);
}
main();

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { housekeepingHandlers, scheduleHousekeeping } from "./jobs/housekeeping.js";
import { startJobRunner } from "./jobs/runner.js";

const config = loadConfig();
const db = createDb(config.db);
const app = await buildApp({ config, db });

const stopJobs = config.jobRunnerEnabled
  ? startJobRunner(db, housekeepingHandlers(db), app.log, () => scheduleHousekeeping(db))
  : async () => {};

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "Shutting down");
  await stopJobs();
  await app.close();
  await db.destroy();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.port, host: "0.0.0.0" });

import { buildApp, createContext } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { businessHandlers, scheduleBusinessJobs } from "./jobs/business.js";
import { housekeepingHandlers, scheduleHousekeeping } from "./jobs/housekeeping.js";
import { startJobRunner } from "./jobs/runner.js";
import { createProviders } from "./providers/index.js";

const config = loadConfig();
const db = createDb(config.db);
const providers = createProviders(config);
const app = await buildApp({ config, db, providers });
if (config.production && config.logsAuthSecrets)
  app.log.warn("Some SMS or email is not being sent: login codes and password links are printed to these logs.");

const stopJobs = config.jobRunnerEnabled
  ? startJobRunner(
      db,
      { ...housekeepingHandlers(db), ...businessHandlers(createContext(config, db, providers, app.log)) },
      app.log,
      async () => {
        await scheduleHousekeeping(db);
        await scheduleBusinessJobs(db);
      },
    )
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

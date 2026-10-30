import { loadConfig } from "../config.js";
import { migrate } from "../db/migrate.js";

const applied = await migrate(loadConfig().db, console.log);
console.log(applied.length ? `Applied ${applied.length} migration(s).` : "Already up to date.");

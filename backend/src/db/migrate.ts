import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { RowDataPacket } from "mysql2";
import type { Config } from "../config.js";
import { createMigrationConnection } from "./client.js";

const DIRECTORY = fileURLToPath(new URL("../../migrations/", import.meta.url));
const LOCK_NAME = "sehrawat_schema_migrations";

/** Ignores line endings: git checks these files out as CRLF on Windows and LF on Linux. */
export function migrationChecksum(text: string) {
  return createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex");
}

/** Applies pending SQL files in name order. Returns the names it applied. */
export async function migrate(config: Config["db"], log: (line: string) => void = () => {}) {
  const connection = createMigrationConnection(config);
  const applied: string[] = [];
  try {
    // Two deploys starting together must not both run the same DDL.
    const [lock] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK(?, 60) AS got", [LOCK_NAME]);
    if (lock[0]?.got !== 1) throw new Error("Another migration is running.");
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) NOT NULL PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6))
    ) ENGINE=InnoDB`);
    const [rows] = await connection.query<RowDataPacket[]>("SELECT name, checksum FROM schema_migrations");
    const known = new Map(rows.map((r) => [r.name as string, r.checksum as string]));
    const files = (await readdir(DIRECTORY)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const text = await readFile(join(DIRECTORY, file), "utf8");
      const checksum = migrationChecksum(text);
      const previous = known.get(file);
      if (previous) {
        if (previous !== checksum)
          throw new Error(`${file} changed after it was applied. Add a new migration instead.`);
        continue;
      }
      log(`Applying ${file}`);
      await connection.query(text);
      await connection.query("INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)", [file, checksum]);
      applied.push(file);
    }
    return applied;
  } finally {
    await connection.end();
  }
}

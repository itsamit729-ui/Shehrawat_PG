import { Kysely, MysqlDialect, sql, type Transaction } from "kysely";
import { createConnection, createPool, type ConnectionOptions } from "mysql2";
import type { Config } from "../config.js";
import type { Database } from "./schema.js";

export type Db = Kysely<Database>;
export type Trx = Transaction<Database>;

// Aiven's default sql_mode includes ANSI, which changes how quotes parse, so pin it for every connection.
const SESSION_SETUP =
  "SET SESSION time_zone = '+00:00', " +
  "sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,ONLY_FULL_GROUP_BY', " +
  "innodb_lock_wait_timeout = 3";

function connectionOptions(config: Config["db"]): ConnectionOptions {
  // Aiven's URI ends in ?ssl-mode=REQUIRED, which mysql2 doesn't read. TLS is configured below instead.
  const url = new URL(config.url);
  url.search = "";
  return {
    uri: url.href,
    timezone: "Z",
    dateStrings: ["DATE"],
    charset: "utf8mb4",
    connectTimeout: 10000,
    ...(config.tls ? { ssl: { ca: config.caCert || undefined, rejectUnauthorized: true } } : {}),
  };
}

export function createDb(config: Config["db"]): Db {
  const pool = createPool({
    ...connectionOptions(config),
    connectionLimit: config.poolSize,
    maxIdle: config.poolSize,
    enableKeepAlive: true,
  });
  pool.on("connection", (connection) => {
    connection.query(SESSION_SETUP);
  });
  return new Kysely<Database>({ dialect: new MysqlDialect({ pool }) });
}

/** A single connection for migrations, the only place multi-statement SQL is allowed. */
export function createMigrationConnection(config: Config["db"]) {
  const connection = createConnection({ ...connectionOptions(config), multipleStatements: true });
  connection.query(SESSION_SETUP);
  return connection.promise();
}

export const dbNow = sql<Date>`UTC_TIMESTAMP(6)`;

export function dbNowPlus(seconds: number) {
  return sql<Date>`UTC_TIMESTAMP(6) + INTERVAL ${seconds} SECOND`;
}

/**
 * Runs allocation work at READ COMMITTED. MySQL's default REPEATABLE READ can answer plain
 * SELECTs from a snapshot taken before a row lock was granted, which would hide a competing
 * writer's committed allocation from the overlap check.
 */
export function lockingTransaction<T>(db: Db, work: (trx: Trx) => Promise<T>) {
  return db.transaction().setIsolationLevel("read committed").execute(work);
}

const DEADLOCK = 1213;
const LOCK_WAIT_TIMEOUT = 1205;
const DUPLICATE_ENTRY = 1062;

function errno(e: unknown) {
  return (e as { errno?: number })?.errno;
}
export const isDuplicate = (e: unknown) => errno(e) === DUPLICATE_ENTRY;
export const isLockTimeout = (e: unknown) => errno(e) === LOCK_WAIT_TIMEOUT;

/** Retries only deadlocks, where MySQL has already rolled the whole transaction back. */
export async function withDeadlockRetry<T>(work: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (e) {
      if (errno(e) !== DEADLOCK || attempt >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 50));
    }
  }
}

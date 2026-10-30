import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { sql } from "kysely";
import { dbNow, dbNowPlus, type Db, type Trx } from "../db/client.js";

export type JobHandler = (payload: unknown) => Promise<void>;

const LEASE_SECONDS = 120;
const POLL_MS = 5000;
const CONCURRENCY = 2;

/** Call inside the business transaction, so the job exists only if that work commits. */
export async function enqueueJob(
  db: Db | Trx,
  job: { kind: string; dedupeKey: string; payload?: unknown; runAt?: Date },
) {
  await db
    .insertInto("jobs")
    .ignore()
    .values({
      id: randomUUID(),
      kind: job.kind,
      dedupe_key: job.dedupeKey,
      payload: JSON.stringify(job.payload ?? {}),
      run_at: job.runAt ?? dbNow,
      last_error: null,
    })
    .execute();
}

/**
 * Claims due jobs and commits before any work runs, so no transaction stays open during provider
 * calls. A job whose lease lapsed (its process died) is claimed again, which is why handlers must
 * tolerate running twice. SKIP LOCKED lets several runners share the queue without waiting.
 */
export async function claimJobs(db: Db, limit: number) {
  return db.transaction().execute(async (trx) => {
    const due = await trx
      .selectFrom("jobs")
      .select(["id", "kind", "payload", "attempts", "max_attempts"])
      .where((eb) =>
        eb.or([
          eb.and([eb("state", "=", "queued"), eb("run_at", "<=", dbNow)]),
          eb.and([eb("state", "=", "running"), eb("lease_expires_at", "<=", dbNow)]),
        ]),
      )
      .orderBy("run_at")
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();
    if (due.length)
      await trx
        .updateTable("jobs")
        .set({
          state: "running",
          attempts: sql`attempts + 1`,
          lease_expires_at: dbNowPlus(LEASE_SECONDS),
        })
        .where("id", "in", due.map((j) => j.id))
        .execute();
    return due.map((j) => ({ ...j, attempts: j.attempts + 1 }));
  });
}

async function finishJob(db: Db, id: string) {
  await db
    .updateTable("jobs")
    .set({ state: "done", finished_at: dbNow, lease_expires_at: null, last_error: null })
    .where("id", "=", id)
    .execute();
}

async function failJob(db: Db, job: { id: string; attempts: number; max_attempts: number }, error: string) {
  const dead = job.attempts >= job.max_attempts;
  const backoff = Math.min(3600, 2 ** job.attempts * 15) + Math.floor(Math.random() * 15);
  await db
    .updateTable("jobs")
    .set({
      state: dead ? "dead" : "queued",
      run_at: dbNowPlus(backoff),
      lease_expires_at: null,
      last_error: error.slice(0, 500),
      ...(dead ? { finished_at: dbNow } : {}),
    })
    .where("id", "=", job.id)
    .execute();
}

/** Runs one bounded batch. Returns how many jobs it claimed. */
export async function runDueJobs(db: Db, handlers: Record<string, JobHandler>, log: FastifyBaseLogger) {
  const jobs = await claimJobs(db, CONCURRENCY);
  await Promise.all(
    jobs.map(async (job) => {
      const handler = handlers[job.kind];
      try {
        if (!handler) throw new Error(`No handler for job kind ${job.kind}`);
        // Only a run that killed its process gets here: failJob would otherwise have retired it.
        if (job.attempts > job.max_attempts) throw new Error("Lease lapsed on every attempt");
        await handler(job.payload);
        await finishJob(db, job.id);
      } catch (err) {
        log.error({ jobId: job.id, kind: job.kind, err: (err as Error).name }, "Job failed");
        await failJob(db, job, (err as Error).message ?? "Unknown error");
      }
    }),
  );
  return jobs.length;
}

/** Runs beside the web server. Every schedule lives in the database, so restarts catch up. */
export function startJobRunner(
  db: Db,
  handlers: Record<string, JobHandler>,
  log: FastifyBaseLogger,
  beforeEachTick: () => Promise<void>,
) {
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let current: Promise<void> = Promise.resolve();
  const tick = async () => {
    try {
      await beforeEachTick();
      await runDueJobs(db, handlers, log);
    } catch (err) {
      log.error({ err: (err as Error).name }, "Job runner tick failed");
    }
  };
  const schedule = () => {
    if (stopping) return;
    timer = setTimeout(() => {
      current = tick().finally(schedule);
    }, POLL_MS);
  };
  schedule();
  return async () => {
    stopping = true;
    clearTimeout(timer);
    await current;
  };
}

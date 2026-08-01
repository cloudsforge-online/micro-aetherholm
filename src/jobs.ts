/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no `setInterval`
 * in this repository doing domain work and CI greps for one. The lease key names the contended
 * resource, not the row:
 *
 *   | Work          | Key         | Why                                                        |
 *   |---------------|-------------|------------------------------------------------------------|
 *   | outbox.relay  | `stream`    | The outbox stream. Keying on an event id would let two     |
 *   |               |             | relays deliver one batch to a subscriber twice.            |
 *   | season.ensure | `stream`    | At most one open season; the partial unique index is the   |
 *   |               |             | second guard behind the lease.                             |
 *   | city.queue    | `city:<id>` | Queue completion for ONE city. The key names the city, so  |
 *   |               |             | two replicas cannot both apply its due items — and the     |
 *   |               |             | `status = 'queued'` UPDATE guard holds even if they could. |
 *
 * There is no per-minute economy tick anywhere in this table, and that is the design: resource
 * stocks are lazy (src/economy.ts) and need no job at all.
 */

import type { Job, JobQueue, JobRunner, RunnerEvent } from '@cloudsforge/jobs';
import type { Logger, Metrics } from '@cloudsforge/telemetry';
import { createRelay, withOutbox, type Db } from './outbox.ts';
import { completeDue } from './cities.ts';
import { ensureOpenSeason } from './seasons.ts';

export const RELAY_KIND = 'outbox.relay';
export const SEASON_ENSURE_KIND = 'season.ensure';
export const CITY_QUEUE_KIND = 'city.queue';

export function cityQueueKey(cityId: string): string {
  return `city:${cityId}`;
}

export interface JobDeps {
  readonly sql: Db;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly producer: string;
  readonly signingSecret: string;
  readonly queue: Pick<JobQueue, 'enqueue'>;
}

export interface Recurring {
  readonly kind: string;
  readonly key: string;
  readonly everyMs: number;
}

export const RECURRING: readonly Recurring[] = Object.freeze([
  { kind: RELAY_KIND, key: 'stream', everyMs: 1_000 },
  { kind: SEASON_ENSURE_KIND, key: 'stream', everyMs: 60_000 },
]);

/** Enqueue each recurring job once. `keep` collapses N replicas booting into one row. */
export async function seedRecurring(queue: Pick<JobQueue, 'enqueue'>): Promise<void> {
  for (const r of RECURRING) await queue.enqueue({ kind: r.kind, key: r.key, onConflict: 'keep' });
}

/** Re-arm a recurring job after it completes (never from inside the handler). */
export async function rescheduleRecurring(
  queue: Pick<JobQueue, 'enqueue'>,
  kind: string,
  key: string,
): Promise<void> {
  const r = RECURRING.find((x) => x.kind === kind && x.key === key);
  if (!r) return;
  await queue.enqueue({ kind, key, runAt: new Date(Date.now() + r.everyMs), onConflict: 'keep' });
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): void {
  runner.register(
    RELAY_KIND,
    createRelay({ sql: deps.sql, logger: deps.logger, signingSecret: deps.signingSecret }),
  );

  runner.register(SEASON_ENSURE_KIND, async () => {
    await ensureOpenSeason(deps.sql, deps.producer, new Date(), withOutbox);
  });

  runner.register<{ cityId?: string }>(CITY_QUEUE_KIND, async (job: Job<{ cityId?: string }>) => {
    const cityId = job.payload.cityId ?? job.key.replace(/^city:/, '');
    const next = await completeDue(deps.sql, deps.producer, cityId, new Date(), withOutbox);
    if (next) {
      // Re-arm for the next completion. 'earliest' so a fresher queue item can only pull the run
      // time forward, never push a due one back.
      await deps.queue.enqueue({
        kind: CITY_QUEUE_KIND,
        key: cityQueueKey(cityId),
        payload: { cityId },
        runAt: next,
        onConflict: 'earliest',
      });
    }
  });
}

/** Wire recurring re-arm to the runner's completed event. */
export function onRunnerEvent(
  queue: Pick<JobQueue, 'enqueue'>,
  logger: Logger,
): (event: RunnerEvent) => void {
  return (event) => {
    if (event.type === 'completed' && event.kind && event.key) {
      void rescheduleRecurring(queue, event.kind, event.key).catch((err) =>
        logger.warn('reschedule failed', {
          kind: event.kind,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    if (event.type === 'dead' || event.type === 'error') {
      logger.warn('job event', { type: event.type, kind: event.kind, err: event.error });
    }
  };
}

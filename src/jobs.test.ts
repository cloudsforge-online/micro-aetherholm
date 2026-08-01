// Leased-job safety. The estate rule is that background work is a leased job claimed FOR UPDATE
// SKIP LOCKED, and that two workers on one job produce exactly one run. Proven with the real
// JobQueue primitive, and with the domain: the city.queue lease key names the CITY.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type postgres from 'postgres';
import { JobQueue, type Sql as JobsSql } from '@cloudsforge/jobs';
import { CITY_QUEUE_KIND, RECURRING, RELAY_KIND, SEASON_ENSURE_KIND, cityQueueKey, seedRecurring } from './jobs.ts';
import { enabled, skip, openDb, migrateTestDb, resetAetherholm } from './testsupport.ts';

let sql: postgres.Sql;

before(async () => {
  if (!enabled) return;
  sql = openDb(6);
  await migrateTestDb(sql);
});
beforeEach(async () => {
  if (enabled) await resetAetherholm(sql);
});
after(async () => {
  if (sql) await sql.end();
});

test('jobs: two workers racing one job — exactly one claims it', { skip }, async () => {
  const a = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-a' });
  const b = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-b' });
  await a.enqueue({ kind: CITY_QUEUE_KIND, key: cityQueueKey('c1') });

  const [ca, cb] = await Promise.all([a.claim(1, [CITY_QUEUE_KIND]), b.claim(1, [CITY_QUEUE_KIND])]);
  assert.equal([...ca, ...cb].length, 1, 'exactly one worker must claim the single job');
});

test('jobs: the lease key names the city, so two cities never contend', { skip }, async () => {
  const q = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-a' });
  await q.enqueue({ kind: CITY_QUEUE_KIND, key: cityQueueKey('c1') });
  await q.enqueue({ kind: CITY_QUEUE_KIND, key: cityQueueKey('c2') });
  const claimed = await q.claim(2, [CITY_QUEUE_KIND]);
  assert.equal(claimed.length, 2);
  assert.deepEqual(claimed.map((job) => job.key).sort(), ['city:c1', 'city:c2']);
});

test('jobs: enqueue is idempotent per (kind, key)', { skip }, async () => {
  const q = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-a' });
  await q.enqueue({ kind: CITY_QUEUE_KIND, key: cityQueueKey('c1'), onConflict: 'keep' });
  await q.enqueue({ kind: CITY_QUEUE_KIND, key: cityQueueKey('c1'), onConflict: 'keep' });
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from jobs where kind = ${CITY_QUEUE_KIND}
  `;
  assert.equal(rows[0]!.n, 1);
});

test("jobs: 'earliest' pulls a queued completion forward, never back", { skip }, async () => {
  const q = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-a' });
  const later = new Date(Date.now() + 60_000);
  const sooner = new Date(Date.now() + 10_000);
  await q.enqueue({ kind: CITY_QUEUE_KIND, key: cityQueueKey('c1'), runAt: later, onConflict: 'earliest' });
  await q.enqueue({ kind: CITY_QUEUE_KIND, key: cityQueueKey('c1'), runAt: sooner, onConflict: 'earliest' });
  await q.enqueue({ kind: CITY_QUEUE_KIND, key: cityQueueKey('c1'), runAt: later, onConflict: 'earliest' });
  const rows = await sql<{ run_at: Date }[]>`
    select run_at from jobs where kind = ${CITY_QUEUE_KIND}
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.run_at.getTime(), sooner.getTime());
});

test('jobs: the recurring set is the relay and the season keeper — no economy tick exists', { skip }, async () => {
  // The design's rule (20-aetherholm.md §6): balances are lazy, so there is NO per-minute world
  // tick to shard or to miss. If someone adds one it will appear here first.
  assert.deepEqual(
    RECURRING.map((r) => r.kind).sort(),
    [RELAY_KIND, SEASON_ENSURE_KIND].sort(),
  );
  const q = new JobQueue(sql as unknown as JobsSql, { owner: 'replica-a' });
  await seedRecurring(q);
  await seedRecurring(q); // N replicas booting collapse to one row per job
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from jobs`;
  assert.equal(rows[0]!.n, RECURRING.length);
});

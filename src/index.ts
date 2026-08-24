/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * It deliberately does NOT run migrations — that is `src/migrator.ts`, a separate one-shot — and
 * it asserts the schema version and refuses to serve below it, because below `SCHEMA_VERSION` the
 * outbox/inbox tables, the city stock CHECKs and the provision uniqueness may not exist.
 *
 * There are no upstream clients: phase 1 makes no outbound HTTP call (src/env.ts explains why),
 * so readiness is Postgres (hard) and the identity JWKS (soft) and nothing else.
 */

import postgres from 'postgres';
import { assertSchemaAtLeast, type Sql as DbSql , networkSql, type Sql as RuntimeSql } from '@cloudsforge/db';
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs';
import { Verifier } from '@cloudsforge/auth';
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle';
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry';
import { SERVICE, env } from './env.ts';
import { SCHEMA_VERSION } from './migrations.ts';
import { createServer, registerServiceMetrics } from './server.ts';
import { onRunnerEvent, registerHandlers, seedRecurring } from './jobs.ts';
import type { Db } from './outbox.ts';

// 1. Environment — validated on import of ./env.ts.

// 2. Telemetry, before anything that can fail.
const logger = new Logger({ service: SERVICE, level: env.logLevel, version: env.version, env: env.env });
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())));
logger.info('starting', { version: env.version, schemaVersion: SCHEMA_VERSION });

// 3. The database pool.
const poolOptions = { max: env.databasePoolMax, onnotice: () => {} }
const sql = postgres(env.databaseUrl, poolOptions)

// ── ONE HANDLE PER NETWORK THIS DEPLOYMENT SERVES ────────────────────────────────────────────
//
// `AETHERHOLM_DATABASE_URL_TESTNET` unset is the single-network case, which is every deployment until the
// consolidation reaches this service. `networkSql` then holds one handle and REFUSES a testnet
// request rather than answering it out of mainnet rows — substituting would be a query that
// SUCCEEDS against the other estate and says nothing.
const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined;

// 4. Assert the schema. This does NOT migrate.
try {
  await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION);
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION });
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(1);
}

// 5. The Lifecycle and its probes.
const lifecycle = new Lifecycle({
  drainDelayMs: 5_000,
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
});
lifecycle
  .addProbe(
    postgresProbe('postgres', (signal) =>
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true });
        }),
      ]),
    ),
  )
  // SOFT: a JWKS outage must degrade token verification (503 per request), not pull the world
  // from rotation and stop the queue-completion backlog from draining.
  .addProbe(httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }));

// 6. Shared bundles.
const db = sql as unknown as Db;
const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId, leaseMs: 120_000 });

// 7. Routes.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer });
// ── WHICH ESTATE THIS DEPLOYMENT IS ─────────────────────────────────────────────────────────
//
// The `networkSql` key below used to be the literal `mainnet`. Same image, same code,
// different env — so the TESTNET pod registered its testnet DSN under the name `mainnet` and
// then refused every request the gateway stamped `CF-Network: testnet`, because it genuinely
// held no handle by that name. Five services crash-looped on it within ten minutes of the
// first deploy: the refusal was right, the registration was wrong.
//
// `CF_NETWORK_SINGLE` is how a single-network pod says which estate it is. The render sets it
// for every deployment; `mainnet` remains the default only for a bare `pnpm dev`.
const ownNetwork = (env.singleNetwork || 'mainnet') as 'mainnet' | 'testnet'

const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  // The SELECTOR, not a handle — routes use `ctx.sql`, resolved once per request.
  sql: networkSql({
    [ownNetwork]: sql as unknown as RuntimeSql,
    ...(sqlTestnet ? { testnet: sqlTestnet as unknown as RuntimeSql } : {}),
  }),
  // The fallback for a request with no `CF-Network` header — which is EVERY service-to-service
  // call, because those go container to container and never reach the gateway that stamps one.
  // `requestNetwork` still prefers the header, so this cannot mask a mis-stamped external
  // request; it only answers the internal callers that never had one.
  singleNetwork: ownNetwork,
  producer: SERVICE,
  queue,
  eventAcceptSecrets: env.acceptSecrets,
  beforeScrape: async () => {
    const stats = await queue.stats();
    metrics.set('jobs_pending', stats.pending);
    metrics.set('jobs_overdue', stats.overdue);
  },
});

// 8. The job runner, started before listen().
const runner = new JobRunner({
  queue,
  concurrency: 4,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind });
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind });
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind });
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind });
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind });
      }
    }
    onRunnerEvent({ sql: db, queue, logger })(event);
  },
});
registerHandlers(runner, {
  sql: db,
  logger,
  metrics,
  producer: SERVICE,
  signingSecret: env.outboxSigningSecret,
  queue,
});
await seedRecurring(queue);
runner.start();

// 9. Listen.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(env.port, () => resolve());
});
logger.info('listening', { port: env.port });

// 10. Ready.
lifecycle.markReady();

lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 });
  logger.info('database pool closed');
});
lifecycle.onShutdown(async () => {
  const clean = await runner.stop(20_000);
  logger.info('job runner stopped', { clean });
});
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    }),
);

installSignalHandlers(lifecycle);

/**
 * The HTTP surface.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * Two routes ARE the title contract `worlds` calls (worlds/src/titleclient.ts:122, :134):
 *
 *   `GET  /v1/title`      — the descriptor. Public and unauthenticated: it is a capability
 *                           statement, not data, and worlds' conformance suite reads it before
 *                           anything is provisioned.
 *   `POST /v1/provision`  — service-token only, scope `aetherholm:provision`. An unauthenticated
 *                           or foreign-credential call is refused (conformance checks 8 and 9: a
 *                           provisioning endpoint anybody can reach is a free-worlds endpoint).
 *                           Idempotent on the entitlement id; an unknown SKU is 422 `unsupported`,
 *                           an ANSWER the bridge records as terminal rather than retrying.
 *
 * Everything else is city play. Queue submissions REQUIRE an `Idempotency-Key` and replay rather
 * than 409 on retry — the emberkin battle-submission pattern, for the same reason: a retried
 * mutation must read what the first attempt did, not do it again.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  ForbiddenError,
  TokenError,
  bearerFrom,
  isAdmin,
  requireScope,
  statusFor,
  type Principal,
} from '@cloudsforge/auth';
import type { Lifecycle } from '@cloudsforge/lifecycle';
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry';
import type { JobQueue } from '@cloudsforge/jobs';
import type { Db } from './outbox.ts';
import {
  IdempotencyConflictError,
  NotFoundError,
  NotOwnerError,
  PlotTakenError,
  QueueFullError,
  ValidationError,
  foundCity,
  getCity,
  listCitiesFor,
  queueWork,
} from './cities.ts';
import { InsufficientStockError } from './economy.ts';
import { listIslands, openSeason } from './seasons.ts';
import { UnsupportedSkuError, provisionSkerry } from './provisioning.ts';
import { CITY_QUEUE_KIND, cityQueueKey } from './jobs.ts';

export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>;
}

export const READ_SCOPE = 'aetherholm:read';
export const WRITE_SCOPE = 'aetherholm:write';
/** The scope worlds' credential must carry to provision. Checked, not assumed — conformance 8/9. */
export const PROVISION_SCOPE = 'aetherholm:provision';

/** The descriptor `GET /v1/title` serves. `private_world` is the one capability phase 1 delivers;
 *  declaring more would be the typo'd-capability defect worlds' conformance check 4 exists for. */
export const TITLE_DESCRIPTOR = Object.freeze({
  slug: 'aetherholm',
  name: 'Aetherholm',
  capabilities: Object.freeze(['private_world']),
});

export interface ServerDeps {
  readonly lifecycle: Lifecycle;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly verifier: PrincipalVerifier;
  readonly sql: Db;
  readonly producer: string;
  readonly queue: Pick<JobQueue, 'enqueue'>;
  readonly beforeScrape?: () => Promise<void>;
}

export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'aetherholm_provisions_total',
      help: 'Title-contract provisions, by outcome. `replayed` is the idempotent second ask.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'aetherholm_cities_founded_total',
      help: 'Cities founded. A refound of an existing city does not count.',
      kind: 'counter',
      labels: [],
    })
    .register({
      name: 'aetherholm_queue_submissions_total',
      help: 'Queue submissions accepted, by kind. `replayed` marks idempotent retries.',
      kind: 'counter',
      labels: ['kind', 'replayed'],
    });
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY_BYTES = 64 * 1024;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly text?: string;
  readonly contentType?: string;
}

interface RequestContext {
  readonly req: IncomingMessage;
  readonly url: URL;
  readonly requestId: string;
  readonly log: Logger;
  readonly params: Readonly<Record<string, string>>;
}

interface Route {
  readonly method: string;
  readonly path: string;
  readonly pattern: RegExp;
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>;
}

function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? `(?<${segment.slice(1)}>[^/]+)`
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${source}$`);
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes();
  let inFlight = 0;

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint();
    const presented = headerOf(req, 'x-request-id');
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId();
    res.setHeader('x-request-id', requestId);

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    let matched: Route | undefined;
    let params: Record<string, string> = {};
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(url.pathname);
      if (match) {
        matched = route;
        params = { ...match.groups };
        break;
      }
    }

    const routeLabel = matched ? matched.path : 'unmatched';
    const log = deps.logger.child({ requestId, method, route: routeLabel });

    inFlight += 1;
    deps.metrics.set('http_requests_in_flight', inFlight);

    const finish = (status: number): void => {
      inFlight -= 1;
      deps.metrics.set('http_requests_in_flight', inFlight);
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      deps.metrics.increment('http_requests_total', {
        method,
        route: routeLabel,
        status: String(status),
      });
      deps.metrics.observe('http_request_duration_ms', durationMs, { method, route: routeLabel });
    };

    void handle(matched, { req, url, requestId, log, params }, deps)
      .then((reply) => {
        send(res, reply, requestId);
        finish(reply.status);
      })
      .catch((err: unknown) => {
        log.error('request handler threw after mapping', { err });
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId);
        finish(500);
      });
  });
}

async function handle(
  route: Route | undefined,
  ctx: RequestContext,
  deps: ServerDeps,
): Promise<Reply> {
  if (!route) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId);
  }
  try {
    return await route.handle(ctx, deps);
  } catch (err) {
    const authStatus = statusFor(err);
    if (authStatus === 401) {
      ctx.log.info('unauthenticated request', { err });
      return errorReply(401, 'unauthenticated', 'a valid bearer token is required', ctx.requestId);
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown';
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId);
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err });
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId);
    }
    if (err instanceof UnsupportedSkuError) {
      // 422 with code 'unsupported' — the ANSWER worlds' bridge records as terminal
      // (worlds/src/titleclient.ts:181, worlds/src/conformance.ts check 7).
      return errorReply(422, 'unsupported', err.message, ctx.requestId);
    }
    if (err instanceof NotFoundError) return errorReply(404, 'not_found', err.message, ctx.requestId);
    if (err instanceof NotOwnerError) return errorReply(403, 'not_owner', err.message, ctx.requestId);
    if (err instanceof PlotTakenError) return errorReply(409, 'plot_taken', err.message, ctx.requestId);
    if (err instanceof QueueFullError) return errorReply(409, 'queue_full', err.message, ctx.requestId);
    if (err instanceof IdempotencyConflictError) {
      return errorReply(409, 'idempotency_conflict', err.message, ctx.requestId);
    }
    if (err instanceof InsufficientStockError) {
      return errorReply(409, 'insufficient_stock', err.message, ctx.requestId);
    }
    if (err instanceof BadRequestError || err instanceof ValidationError || err instanceof RangeError) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId);
    }
    ctx.log.error('unhandled request failure', { err });
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId);
  }
}

function buildRoutes(): Route[] {
  const define = (
    method: string,
    path: string,
    handler: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>,
  ): Route => ({ method, path, pattern: compile(path), handle: handler });

  return [
    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz();
      return { status: report.ready ? 200 : 503, body: report };
    }),

    define('GET', '/metrics', async (ctx, deps) => {
      try {
        await deps.beforeScrape?.();
      } catch (err) {
        ctx.log.warn('gauge refresh failed; serving the previous values', { err });
      }
      return {
        status: 200,
        text: deps.metrics.render(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      };
    }),

    /* --------------------------------------------------------------- the title contract */

    define('GET', '/v1/title', async () => ({ status: 200, body: TITLE_DESCRIPTOR })),

    define('POST', '/v1/provision', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps);
      if (principal.kind !== 'service') {
        // Provisioning is the platform's act, driven by a paid entitlement. A user token here is
        // someone trying to raise a world without buying one.
        throw new ForbiddenError(PROVISION_SCOPE);
      }
      requireScope(principal, PROVISION_SCOPE);

      const body = await readJson(ctx.req);
      const entitlementId = requireString(body, 'entitlementId');
      const subject = requireString(body, 'subject');
      const userId = requireString(body, 'userId');
      const sku = requireString(body, 'sku');
      const scope = requireString(body, 'scope');
      const metadata =
        typeof body['metadata'] === 'object' && body['metadata'] !== null && !Array.isArray(body['metadata'])
          ? (body['metadata'] as Record<string, unknown>)
          : {};

      const done = deps.lifecycle.track();
      try {
        const outcome = await provisionSkerry(deps.sql, deps.producer, {
          entitlementId,
          subject,
          userId,
          sku,
          scope,
          metadata,
          correlationId: ctx.requestId,
        });
        deps.metrics.increment('aetherholm_provisions_total', {
          outcome: outcome.replayed ? 'replayed' : 'provisioned',
        });
        ctx.log.info('provisioned', { entitlementId, urn: outcome.urn, replayed: outcome.replayed });
        return {
          status: outcome.replayed ? 200 : 201,
          body: { urn: outcome.urn, replayed: outcome.replayed },
        };
      } finally {
        done();
      }
    }),

    /* --------------------------------------------------------------- the world, read */

    define('GET', '/v1/seasons/current', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps);
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE);
      const season = await openSeason(deps.sql);
      if (!season) return errorReply(404, 'no_open_season', 'no season is open yet', ctx.requestId);
      return {
        status: 200,
        body: {
          id: season.id,
          name: season.name,
          seed: season.seed.toString(),
          status: season.status,
          openedAt: season.openedAt.toISOString(),
          endsAt: season.endsAt.toISOString(),
          archipelagoId: season.archipelagoId,
        },
      };
    }),

    define('GET', '/v1/archipelagos/:id/islands', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps);
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE);
      const id = ctx.params['id'] ?? '';
      if (!UUID.test(id)) throw new BadRequestError('archipelago id must be a uuid');
      const islands = await listIslands(deps.sql, id);
      if (islands.length === 0) {
        return errorReply(404, 'not_found', 'no such archipelago, or it has no islands', ctx.requestId);
      }
      return { status: 200, body: { islands } };
    }),

    /* --------------------------------------------------------------- city play */

    define('POST', '/v1/cities', async (ctx, deps) => {
      const userId = await requireUser(ctx, deps);
      const body = await readJson(ctx.req);
      const islandId = requireString(body, 'islandId');
      const name = requireString(body, 'name');
      const plot = body['plot'];
      if (typeof plot !== 'number') throw new BadRequestError('plot must be a number from 1 to 12');
      if (!UUID.test(islandId)) throw new BadRequestError('islandId must be a uuid');

      const done = deps.lifecycle.track();
      try {
        const result = await foundCity(deps.sql, deps.producer, {
          userId,
          islandId,
          plot,
          name,
          correlationId: ctx.requestId,
        });
        if (result.created) deps.metrics.increment('aetherholm_cities_founded_total');
        return { status: result.created ? 201 : 200, body: { city: result.city } };
      } finally {
        done();
      }
    }),

    define('GET', '/v1/cities', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps);
      const requested = ctx.url.searchParams.get('userId') ?? undefined;
      let ownerId: string;
      if (principal.kind === 'user') {
        // An admin may read anyone; a player reads only their own list.
        if (requested && requested !== principal.userId && !isAdmin(principal)) {
          throw new ForbiddenError('role:admin');
        }
        ownerId = requested ?? principal.userId;
      } else {
        requireScope(principal, READ_SCOPE);
        if (!requested) throw new BadRequestError('a service must name a userId');
        ownerId = requested;
      }
      const cities = await listCitiesFor(deps.sql, ownerId);
      return { status: 200, body: { cities } };
    }),

    define('GET', '/v1/cities/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps);
      const id = ctx.params['id'] ?? '';
      if (!UUID.test(id)) throw new BadRequestError('city id must be a uuid');
      const city = await getCity(deps.sql, id);
      if (!city) return errorReply(404, 'not_found', 'no such city', ctx.requestId);
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE);
      else if (city.userId !== principal.userId && !isAdmin(principal)) {
        // A city's stocks and queues are its owner's plan. 403 rather than 404: plots are public
        // on the island list anyway, so existence is not the secret — the economy is.
        throw new ForbiddenError('role:admin');
      }
      return { status: 200, body: { city } };
    }),

    define('POST', '/v1/cities/:id/buildings', async (ctx, deps) => {
      return queueRoute(ctx, deps, 'building');
    }),

    define('POST', '/v1/cities/:id/research', async (ctx, deps) => {
      return queueRoute(ctx, deps, 'research');
    }),
  ];
}

/** The shared queue-submission handler: building and research differ only in their target set. */
async function queueRoute(
  ctx: RequestContext,
  deps: ServerDeps,
  kind: 'building' | 'research',
): Promise<Reply> {
  const userId = await requireUser(ctx, deps);
  const cityId = ctx.params['id'] ?? '';
  if (!UUID.test(cityId)) throw new BadRequestError('city id must be a uuid');

  const key = headerOf(ctx.req, 'idempotency-key');
  if (!key || key.length < 1 || key.length > 200) {
    throw new BadRequestError(`an Idempotency-Key header is required to queue a ${kind}`);
  }
  const body = await readJson(ctx.req);
  const target = requireString(body, kind === 'building' ? 'type' : 'node');

  const done = deps.lifecycle.track();
  try {
    const result = await queueWork(deps.sql, deps.producer, {
      cityId,
      userId,
      kind,
      target,
      idempotencyKey: key,
      correlationId: ctx.requestId,
    });
    deps.metrics.increment('aetherholm_queue_submissions_total', {
      kind,
      replayed: String(result.replayed),
    });
    if (!result.replayed) {
      // The completion job, keyed on the city. 'earliest' can only pull the run forward.
      await deps.queue.enqueue({
        kind: CITY_QUEUE_KIND,
        key: cityQueueKey(cityId),
        payload: { cityId },
        runAt: result.item.completesAt,
        onConflict: 'earliest',
      });
    }
    return {
      status: 200,
      body: {
        item: {
          id: result.item.id,
          kind: result.item.kind,
          target: result.item.target,
          startedAt: result.item.startedAt.toISOString(),
          completesAt: result.item.completesAt.toISOString(),
        },
        replayed: result.replayed,
        stocks: result.stocks,
      },
    };
  } finally {
    done();
  }
}

/* --------------------------------------------------------------- auth + parsing helpers */

async function authenticate(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'));
  if (!token) throw new TokenError('no bearer token presented', 'missing');
  return deps.verifier.principal(token);
}

/** A user acting on their own cities. A service must carry aetherholm:write and name a user. */
async function requireUser(ctx: RequestContext, deps: ServerDeps): Promise<string> {
  const principal = await authenticate(ctx, deps);
  if (principal.kind === 'user') return principal.userId;
  requireScope(principal, WRITE_SCOPE);
  const onBehalf = headerOf(ctx.req, 'x-user-id');
  if (!onBehalf || !UUID.test(onBehalf)) {
    throw new ForbiddenError('x-user-id (a service must name a user)');
  }
  return onBehalf;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`${field} is required`);
  }
  return value.trim();
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestError('request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof BadRequestError) throw err;
    throw new BadRequestError('request body is not valid JSON');
  }
}

function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } };
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return;
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`;
  res.writeHead(reply.status, {
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

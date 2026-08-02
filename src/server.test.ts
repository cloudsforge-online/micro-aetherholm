// End-to-end HTTP tests through the real server: health, metrics, authentication boundaries,
// founding and reading a city with computed stocks, and the Idempotency-Key discipline on the
// queue routes. The title contract has its own file — titlecontract.test.ts — because it is a
// contract with another service and deserves its own record.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type postgres from 'postgres';
import { Lifecycle, postgresProbe } from '@cloudsforge/lifecycle';
import { TokenError, type Principal } from '@cloudsforge/auth';
import { JobQueue, type Sql as JobsSql } from '@cloudsforge/jobs';
import { createServer, type PrincipalVerifier } from './server.ts';
import { CITY_QUEUE_KIND } from './jobs.ts';
import { ensureOpenSeason, insertIslands, listIslands } from './seasons.ts';
import { generateIslands } from './world.ts';
import { sealSeason } from './sealing.ts';
import { withOutbox } from './outbox.ts';
import {
  enabled,
  skip,
  openDb,
  migrateTestDb,
  resetAetherholm,
  asDb,
  quietLogger,
  testMetrics,
  ALICE,
  BOB,
} from './testsupport.ts';

let sql: postgres.Sql;
let server: Server;
let base: string;
let queue: JobQueue;

/**
 * The verifier fake speaks the estate's Principal vocabulary:
 *   'alice' / 'bob'   — players
 *   'platform'        — a service token carrying aetherholm:provision (worlds' shape)
 *   'reader'          — a service token with aetherholm:read only
 *   anything else     — TokenError, exactly as a forged JWT fails signature verification
 */
const verifier: PrincipalVerifier = {
  async principal(token: string): Promise<Principal> {
    if (token === 'alice') return { kind: 'user', userId: ALICE, handle: 'alice', roles: [] };
    if (token === 'bob') return { kind: 'user', userId: BOB, handle: 'bob', roles: [] };
    if (token === 'admin') {
      return { kind: 'user', userId: BOB, handle: 'op', roles: ['admin'] };
    }
    if (token === 'platform') {
      return { kind: 'service', service: 'worlds', scopes: ['aetherholm:provision'] };
    }
    if (token === 'reader') return { kind: 'service', service: 'hub-api', scopes: ['aetherholm:read'] };
    throw new TokenError('unknown token', 'invalid');
  },
};

before(async () => {
  if (!enabled) return;
  sql = openDb(8);
  await migrateTestDb(sql);
  queue = new JobQueue(sql as unknown as JobsSql, { owner: 'test' });
  const lifecycle = new Lifecycle();
  lifecycle.addProbe(postgresProbe('postgres', () => sql`select 1`));
  server = createServer({
    lifecycle,
    logger: quietLogger(),
    metrics: testMetrics(),
    verifier,
    sql: asDb(sql),
    producer: 'aetherholm',
    queue,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  lifecycle.markReady();
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  if (enabled) await resetAetherholm(sql);
});
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (sql) await sql.end();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

async function anIsland(): Promise<string> {
  const season = await ensureOpenSeason(asDb(sql), 'aetherholm', new Date());
  const islands = await listIslands(asDb(sql), season.archipelagoId);
  return islands[0]!.id;
}

test('server: /livez and /readyz answer', { skip }, async () => {
  assert.equal((await fetch(`${base}/livez`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
});

test('server: /metrics is prometheus text', { skip }, async () => {
  const res = await fetch(`${base}/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
});

test('server: an unauthenticated read is 401 and carries the request id', { skip }, async () => {
  const res = await fetch(`${base}/v1/cities`);
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: { code: string; requestId: string } };
  assert.equal(body.error.code, 'unauthenticated');
  assert.equal(body.error.requestId, res.headers.get('x-request-id'));
});

test('server: the season and its islands read back; a service needs aetherholm:read', { skip }, async () => {
  await ensureOpenSeason(asDb(sql), 'aetherholm', new Date());
  const season = await fetch(`${base}/v1/seasons/current`, { headers: auth('alice') });
  assert.equal(season.status, 200);
  const body = (await season.json()) as { archipelagoId: string; seed: string; endsAt: string };
  assert.match(body.seed, /^\d+$/, 'the seed travels as a decimal string, never a float');

  const islands = await fetch(`${base}/v1/archipelagos/${body.archipelagoId}/islands`, {
    headers: auth('reader'),
  });
  assert.equal(islands.status, 200);
  const listed = (await islands.json()) as { islands: { band: string; freePlots: number }[] };
  assert.equal(listed.islands.length, 200);
  assert.equal(listed.islands[0]!.freePlots, 12);

  // The platform's provision-scoped token is NOT a read token.
  const refused = await fetch(`${base}/v1/seasons/current`, { headers: auth('platform') });
  assert.equal(refused.status, 403);
});

test('server: found a city, read it back with computed stocks, refuse the other player', { skip }, async () => {
  const islandId = await anIsland();
  const create = await fetch(`${base}/v1/cities`, {
    method: 'POST',
    headers: auth('alice'),
    body: JSON.stringify({ islandId, plot: 1, name: 'Aerie' }),
  });
  assert.equal(create.status, 201);
  const { city } = (await create.json()) as { city: { id: string; stocks: Record<string, string> } };
  assert.match(city.stocks['aether']!, /^\d+$/, 'stocks travel as decimal strings');

  const mine = await fetch(`${base}/v1/cities/${city.id}`, { headers: auth('alice') });
  assert.equal(mine.status, 200);

  // Bob can see the island's plot is taken (public), but not Alice's economy.
  const theirs = await fetch(`${base}/v1/cities/${city.id}`, { headers: auth('bob') });
  assert.equal(theirs.status, 403);
  // An admin can.
  const operator = await fetch(`${base}/v1/cities/${city.id}`, { headers: auth('admin') });
  assert.equal(operator.status, 200);
});

test('server: refounding on the same island replays with 200, not 201 and not 409', { skip }, async () => {
  const islandId = await anIsland();
  const body = JSON.stringify({ islandId, plot: 1, name: 'Aerie' });
  const first = await fetch(`${base}/v1/cities`, { method: 'POST', headers: auth('alice'), body });
  assert.equal(first.status, 201);
  const retry = await fetch(`${base}/v1/cities`, { method: 'POST', headers: auth('alice'), body });
  assert.equal(retry.status, 200);
  const cities = await sql<{ n: number }[]>`select count(*)::int as n from cities`;
  assert.equal(cities[0]!.n, 1);
});

test('server: a taken plot is 409 plot_taken', { skip }, async () => {
  const islandId = await anIsland();
  await fetch(`${base}/v1/cities`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({ islandId, plot: 1, name: 'Aerie' }),
  });
  const refused = await fetch(`${base}/v1/cities`, {
    method: 'POST', headers: auth('bob'),
    body: JSON.stringify({ islandId, plot: 1, name: 'Roost' }),
  });
  assert.equal(refused.status, 409);
  const body = (await refused.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'plot_taken');
});

test('server: a queue submission without an Idempotency-Key is 400; with one it replays', { skip }, async () => {
  const islandId = await anIsland();
  const create = await fetch(`${base}/v1/cities`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({ islandId, plot: 1, name: 'Aerie' }),
  });
  const { city } = (await create.json()) as { city: { id: string } };

  const bare = await fetch(`${base}/v1/cities/${city.id}/buildings`, {
    method: 'POST', headers: auth('alice'), body: JSON.stringify({ type: 'warehouse' }),
  });
  assert.equal(bare.status, 400);

  const submit = () =>
    fetch(`${base}/v1/cities/${city.id}/buildings`, {
      method: 'POST',
      headers: { ...auth('alice'), 'idempotency-key': 'k-house' },
      body: JSON.stringify({ type: 'warehouse' }),
    });
  const first = await submit();
  assert.equal(first.status, 200);
  const b1 = (await first.json()) as { item: { id: string }; replayed: boolean };
  assert.equal(b1.replayed, false);

  const second = await submit();
  assert.equal(second.status, 200, 'a retry must not 409');
  const b2 = (await second.json()) as { item: { id: string }; replayed: boolean };
  assert.equal(b2.replayed, true);
  assert.equal(b2.item.id, b1.item.id);

  // The completion job is scheduled under the city's key, once.
  const jobs = await sql<{ kind: string; key: string }[]>`select kind, key from jobs`;
  assert.deepEqual([...jobs], [{ kind: CITY_QUEUE_KIND, key: `city:${city.id}` }]);
});

test('server: bob cannot queue in alice\'s city — 403 not_owner', { skip }, async () => {
  const islandId = await anIsland();
  const create = await fetch(`${base}/v1/cities`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({ islandId, plot: 1, name: 'Aerie' }),
  });
  const { city } = (await create.json()) as { city: { id: string } };
  const refused = await fetch(`${base}/v1/cities/${city.id}/research`, {
    method: 'POST',
    headers: { ...auth('bob'), 'idempotency-key': 'k1' },
    body: JSON.stringify({ node: 'well_lore' }),
  });
  assert.equal(refused.status, 403);
  const body = (await refused.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'not_owner');
});

/* ------------------------------------------------------------------ phase 2 surfaces */

test('server: the airship content is public and every amount is a decimal string', { skip }, async () => {
  const res = await fetch(`${base}/v1/content/airships`);
  assert.equal(res.status, 200, 'content is a capability statement, like /v1/title');
  const body = (await res.json()) as { airships: Record<string, { cargo: string; attack: string }> };
  assert.equal(Object.keys(body.airships).length, 10);
  assert.match(body.airships['hauler']!.cargo, /^\d+$/);
  assert.equal(body.airships['ironclad']!.cargo, '0', 'war classes carry nothing — the split, on the wire');
});

test('server: lanes serve authenticated, and backfill a world that predates the lattice', { skip }, async () => {
  const season = await ensureOpenSeason(asDb(sql), 'aetherholm', new Date());
  // Simulate a phase-1 world: strip the lanes the season fixture created.
  await sql`delete from lanes`;
  await sql`update islands set is_spire = false`;
  const anonymous = await fetch(`${base}/v1/archipelagos/${season.archipelagoId}/lanes`);
  assert.equal(anonymous.status, 401, 'the live lattice is player data, not public data');
  const res = await fetch(`${base}/v1/archipelagos/${season.archipelagoId}/lanes`, {
    headers: auth('reader'),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { lanes: { multiplierBp: number }[] };
  assert.ok(body.lanes.length > 0, 'the ask itself grew the lanes from the stored seed');
});

test('server: a fleet launch demands an Idempotency-Key and a real mission', { skip }, async () => {
  const islandId = await anIsland();
  const create = await fetch(`${base}/v1/cities`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({ islandId, plot: 1, name: 'Aerie' }),
  });
  const { city } = (await create.json()) as { city: { id: string } };
  const bare = await fetch(`${base}/v1/fleets`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({ cityId: city.id, mission: 'raid', ships: { cutter: 1 }, targetIslandId: islandId }),
  });
  assert.equal(bare.status, 400, 'no Idempotency-Key, no launch');
  const nonsense = await fetch(`${base}/v1/fleets`, {
    method: 'POST', headers: { ...auth('alice'), 'idempotency-key': 'k-f1' },
    body: JSON.stringify({ cityId: city.id, mission: 'parade', ships: { cutter: 1 }, targetIslandId: islandId }),
  });
  assert.equal(nonsense.status, 400);
  const floaty = await fetch(`${base}/v1/fleets`, {
    method: 'POST', headers: { ...auth('alice'), 'idempotency-key': 'k-f2' },
    body: JSON.stringify({
      cityId: city.id, mission: 'transfer', ships: { hauler: 1 },
      cargo: { aether: 1.5 }, targetIslandId: islandId,
    }),
  });
  assert.equal(floaty.status, 400, 'cargo is decimal strings — a float near an amount is refused');
});

test('server: a shipyard queue item needs its aerodock, and replays on its key', { skip }, async () => {
  const islandId = await anIsland();
  const create = await fetch(`${base}/v1/cities`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({ islandId, plot: 1, name: 'Aerie' }),
  });
  const { city } = (await create.json()) as { city: { id: string } };
  const submit = () =>
    fetch(`${base}/v1/cities/${city.id}/ships`, {
      method: 'POST',
      headers: { ...auth('alice'), 'idempotency-key': 'k-keel' },
      body: JSON.stringify({ class: 'skiff' }),
    });
  const dockless = await submit();
  assert.equal(dockless.status, 400, 'a keel needs its aerodock');
  await sql`insert into buildings (city_id, type, level) values (${city.id}, 'aerodock', 1)`;
  const first = await submit();
  assert.equal(first.status, 200);
  const b1 = (await first.json()) as { item: { id: string }; replayed: boolean };
  assert.equal(b1.replayed, false);
  const second = await submit();
  const b2 = (await second.json()) as { item: { id: string }; replayed: boolean };
  assert.equal(b2.replayed, true);
  assert.equal(b2.item.id, b1.item.id);
});

test('server: an alliance cannot be founded without its community', { skip }, async () => {
  const season = await ensureOpenSeason(asDb(sql), 'aetherholm', new Date());
  const missing = await fetch(`${base}/v1/alliances`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({ archipelagoId: season.archipelagoId, name: 'Compact' }),
  });
  assert.equal(missing.status, 400, 'communityId is required — this service refuses to create communities');
  const created = await fetch(`${base}/v1/alliances`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({
      archipelagoId: season.archipelagoId,
      communityId: '55555555-5555-4555-8555-555555555555',
      name: 'Compact',
    }),
  });
  assert.equal(created.status, 201);
  const { alliance } = (await created.json()) as { alliance: { id: string; communityId: string } };
  assert.equal(alliance.communityId, '55555555-5555-4555-8555-555555555555');
});

test('server: the chronicle is anonymous for SEALED seasons only', { skip }, async () => {
  // Anonymous list: empty while nothing has sealed.
  const empty = await fetch(`${base}/v1/chronicle/seasons`);
  assert.equal(empty.status, 200, 'the chronicle list needs no bearer');
  assert.deepEqual((await empty.json()) as unknown, { seasons: [] });

  // Seal a season whose day has come.
  const seasons = await sql<{ id: string }[]>`
    insert into seasons (name, seed, status, opened_at, ends_at)
    values ('Old', 3, 'open', now() - interval '121 days', now() - interval '1 day')
    returning id
  `;
  await sql`insert into archipelagos (kind, season_id, name, seed)
            values ('public', ${seasons[0]!.id}, 'A', 3)`;
  const arch = await sql<{ id: string }[]>`
    select id from archipelagos where season_id = ${seasons[0]!.id}
  `;
  await withOutbox(asDb(sql), 'aetherholm', async (tx) => {
    await insertIslands(tx, arch[0]!.id, generateIslands(3n, 12));
  });
  await sealSeason(asDb(sql), 'aetherholm', seasons[0]!.id);

  const listed = await fetch(`${base}/v1/chronicle/seasons`);
  const body = (await listed.json()) as { seasons: { seasonId: string; digest: string }[] };
  assert.equal(body.seasons.length, 1);
  assert.equal(body.seasons[0]!.seasonId, seasons[0]!.id);

  const detail = await fetch(`${base}/v1/chronicle/seasons/${seasons[0]!.id}`);
  assert.equal(detail.status, 200, 'a sealed season reads anonymously');
  const battles = await fetch(`${base}/v1/chronicle/seasons/${seasons[0]!.id}/battles`);
  assert.equal(battles.status, 200);

  // A LIVE season is not history and stays scoped.
  const live = await ensureOpenSeason(asDb(sql), 'aetherholm', new Date());
  const refused = await fetch(`${base}/v1/chronicle/seasons/${live.id}`);
  assert.equal(refused.status, 404, 'live-season data never leaks through the anonymous surface');
});

test('server: an empty treasury is 409 insufficient_stock, and charges nothing', { skip }, async () => {
  const islandId = await anIsland();
  const create = await fetch(`${base}/v1/cities`, {
    method: 'POST', headers: auth('alice'),
    body: JSON.stringify({ islandId, plot: 1, name: 'Aerie' }),
  });
  const { city } = (await create.json()) as { city: { id: string } };
  await sql`update cities set aether = 0, cloudstone = 0, skysteel = 0, provisions = 0,
            last_settled_at = now() where id = ${city.id}`;
  const refused = await fetch(`${base}/v1/cities/${city.id}/buildings`, {
    method: 'POST',
    headers: { ...auth('alice'), 'idempotency-key': 'k1' },
    body: JSON.stringify({ type: 'warehouse' }),
  });
  assert.equal(refused.status, 409);
  const body = (await refused.json()) as { error: { code: string } };
  assert.equal(body.error.code, 'insufficient_stock');
});

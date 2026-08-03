# micro-aetherholm

[![ci](https://github.com/cloudsforge-online/micro-aetherholm/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-aetherholm/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml)

The third Forge Worlds title: a sky-island strategy MMO at Ikariam scale
([`ecosystem/20-aetherholm.md`] is the design; this repository is its phases 1 and 2). It owns
the world — seasons with seeds, archipelagos, islands, cities, buildings, build/research/shipyard
queues, and a **lazy economy with no world tick** — and the moving parts: the **directed wind
lattice**, fleets and travel, **deterministic battles with sha256-digested reports**, raids and
sieges, **seasons that seal into an immutable chronicle**, and alliances bound to
`micro-community`. It is also the first service in the estate to implement the title contract
`worlds` actually calls: `GET /v1/title` and `POST /v1/provision`
(`worlds/src/titleclient.ts:122`, `:134`), provisioning a **Private Skerry** idempotently on the
entitlement id.

> **What it refuses.** This service holds no money: there is no balance or Shard column anywhere,
> and `migrations.test.ts` proves the absence by enumerating `information_schema.columns`. The
> Skywright's Charter and the season pass are `billing` products; cosmetics and heraldry are
> `worlds` entitlements — granted **via the outbox** (`aetherholm.spire.captured`,
> `aetherholm.season.sealed`), never by writing into worlds. **The aegis — a new city's free
> 7-day protection — cannot be purchased**: the only code that writes `aegis_until` is city
> founding, and `titlecontract.test.ts` asserts that absence over comment-stripped source. Nothing
> sells speed either: build, research, shipbuilding and travel durations have no purchase path at
> all — in a competitive world, time is power (20-aetherholm.md §7). And it **refuses to create
> communities**: an alliance IS a `micro-community` community (doc §6); founding one requires a
> `communityId` the caller already has, and `alliances.test.ts` proves the module cannot even
> reach community — no client, no route, structurally.

## The title contract

Worlds registers a title as a row (`POST /v1/titles`, operator route — `worlds/src/server.ts:484`)
and its provisioning bridge then drives everything through two calls. The descriptor answers
`slug: 'aetherholm'` with `capabilities: ['private_world']` (`src/server.ts:70-74`).

**`private_world`, deliberately not `provision`.** Worlds' capability set is closed —
`'private_world' | 'cosmetics' | 'achievements' | 'seasons' | 'inventory'`
(`worlds/src/titles.ts:43-51`) — its conformance suite fails any capability outside it
(`worlds/src/conformance.ts` check 4), and the bridge asks `hasCapability(title, 'private_world')`
before calling at all (`worlds/src/provisioning.ts:441`). A title declaring `provision` would
never be called and would fail conformance.

Provisioning is idempotent **on the entitlement id** — the one value stable across redelivery,
retry and replica takeover (`worlds/src/titleclient.ts:12-17`). The replay returns the **same
urn** with `replayed: true`; a race between two replicas resolves at
`provisions_entitlement_uniq`. An unknown SKU answers `422 {error:{code:'unsupported'}}`, which
the bridge records as a terminal answer rather than retrying (`worlds/src/titleclient.ts:19-24`).
The only SKU sold is `private_skerry` (`src/provisioning.ts:30`): a 12-island private archipelago
whose geography — islands, **lanes and spires** — is derived from `sha256(entitlementId)`, so even
a hypothetical double-create could not mint two geographies for one purchase (`src/world.ts`
`skerrySeed`).

`src/titlecontract.test.ts` mirrors all nine conformance checks of `worlds/src/conformance.ts`
one for one over real HTTP against a real database. The credential worlds presents must carry the
`aetherholm:provision` scope; a missing, forged, wrong-scoped or user token is refused.

## The lazy economy

There is no tick. Stocks are **computed on read** from `(last_settled_at, rates, cap)` and
**settled on write** (`src/economy.ts`): the read path and the write path share one pure function,
`accrue`, so the number a player was shown and the number a spend is charged against cannot
diverge. Everything is `bigint`, floor arithmetic, decimal strings on the wire. A clock that steps
backwards accrues nothing rather than subtracting, and `last_settled_at` never moves backwards.

**Every phase-2 spend goes through the same settlement.** A fleet launch charges Aether lift for
the whole round trip — plus a transfer's cargo — in one settle-and-charge
(`src/fleets.ts` `launchFleet`); a launch the treasury cannot cover throws and rolls back,
**refused, never clamped**, with the phase-1 `cities_stocks_settled_within_caps` CHECK standing
behind it. Loot moves between cities' stocks under the same CHECKs; arriving cargo clamps at the
warehouse cap like accrual does (`src/fleets.ts` `depositInto`).

## The wind lattice

Travel is not euclidean (doc §2). Islands are nodes on a **directed** graph generated from the
season seed on its own tagged stream (`src/world.ts` `generateLanes`): a full ring in both
directions — strong connectivity by construction — plus rolled chords, and **each direction is
its own roll**, so A→B may be two hours while B→A is five. Lanes are stored (`lanes`, migration 9)
because battle reports cite the lane of approach forever; a phase-1 world that predates the
lattice grows byte-identical lanes from its stored seed the first time anyone asks
(`src/lattice.ts` `ensureLattice`, convergent under racing replicas). Travel time derives from the
path: shortest-path seconds × the fleet's slowest ship's factor, all integer. The **Aether
Spires** — the islands whoever holds at day 120 wins — are flagged from the seed the same way
(`src/world.ts` `spireIdxsFor`).

## Battles

Round-based, initiative by class, wind-advantage modifier from the lane of approach — resolved
**entirely** from `(battleId, seasonSeed, both orders of battle, windBp)` by a seeded PRNG
(`src/battles.ts`). The report carries a **sha256 digest over the canonicalised inputs and
result** — the `trade` backtest pattern (`trade/src/backtest.ts`) — so re-resolution is
byte-identical, and `battles.test.ts` mutation-checks it: change any input and the digest changes;
tamper with a stored result and the replay disagrees. The freight/war split is live: **loot rides
only in surviving Haulers**, a defender's Vault protects its floor per resource, and a siege
needs a Breaker. Battles are **append-only via trigger** — UPDATE and DELETE are database errors.

## Seasons seal

At day 120 — a leased job (`season.close`), never a timer — the archipelago freezes
(`src/sealing.ts`): spire holders are read (the alliance or lone player with the most surviving
cities per spire; a tie holds for nobody), the chronicle row is written with its own digest over
the canonicalised summary, the season flips to `sealed`, and heraldry leaves as events. From that
commit on, **an UPDATE or DELETE on the sealed season is a database error even for a caller
holding a connection** (`seasons_sealed_immutable`, doc §9.5) — proven in `sealing.test.ts` with
raw SQL. A sealed world also refuses play: founding, queueing and launching all answer
`409 season_sealed`. Sealed seasons are public history: the chronicle routes are the only
anonymous surface, and their queries are scoped `status = 'sealed'` so a live season cannot leak
through them even by id.

## Routes

Read out of `src/server.ts`. `/livez`, `/readyz`, `/metrics`, `GET /v1/title`,
`GET /v1/content/airships` and the three `/v1/chronicle/*` routes make no `authenticate()` call —
everything else 401s without a bearer token.

| Method | Path | Who | Idempotency-Key | What it does |
| --- | --- | --- | --- | --- |
| `GET` | `/livez` | anyone | — | static liveness (`src/server.ts:312`) |
| `GET` | `/readyz` | anyone | — | Postgres hard, JWKS soft (`src/server.ts:314`) |
| `GET` | `/metrics` | anyone | — | Prometheus text (`src/server.ts:319`) |
| `GET` | `/v1/title` | anyone | — | the title descriptor; a capability statement (`src/server.ts:334`) |
| `POST` | `/v1/provision` | service with `aetherholm:provision` only | dedupe on the body's `entitlementId` | provision a Private Skerry — islands, lanes and spires; unknown SKU is 422 `unsupported` (`src/server.ts:336`) |
| `GET` | `/v1/seasons/current` | user, or service with `aetherholm:read` | — | the open season, seed as a decimal string (`src/server.ts:382`) |
| `GET` | `/v1/archipelagos/:id/islands` | user, or service with `aetherholm:read` | — | islands with free plot counts (`src/server.ts:401`) |
| `GET` | `/v1/archipelagos/:id/lanes` | user, or service with `aetherholm:read` | — | the wind lattice; the ask backfills a pre-lattice world from its seed (`src/server.ts:518`) |
| `GET` | `/v1/content/buildings` | none | the 20 building base costs and durations, mirrored from the one source the engine charges from (`src/server.ts`, beside airships) |
| `GET` | `/v1/content/research` | none | the 32 research nodes with exact costs and durations |
| `GET` | `/v1/content/airships` | anyone | — | the 10 classes, amounts as decimal strings (`src/server.ts:490`) |
| `POST` | `/v1/cities` | user (service with `aetherholm:write` + `x-user-id`) | the partial unique IS the idempotency | found a city; refused on a sealed season (`src/server.ts:415`) |
| `GET` | `/v1/cities` | own list; admin may name `?userId=`; service must | — | cities with computed stocks and garrison (`src/server.ts:440`) |
| `GET` | `/v1/cities/:id` | owner, admin, or service reader | — | the city, stocks computed at read time; 403 to other players (`src/server.ts:459`) |
| `POST` | `/v1/cities/:id/buildings` | owner | **required** | settle, charge, queue a building level (`src/server.ts:474`) |
| `POST` | `/v1/cities/:id/research` | owner | **required** | settle, charge, queue a research node (`src/server.ts:478`) |
| `POST` | `/v1/cities/:id/ships` | owner | **required** | lay a keel; needs the class's aerodock level (`src/server.ts:482`) |
| `POST` | `/v1/fleets` | owner | **required** | launch: settle-and-charge lift + cargo, decrement garrison, route the lattice; refused on aegis, sealed season, missing Breaker (`src/server.ts:533`) |
| `GET` | `/v1/fleets` | own list; admin/service as cities | — | fleets, cargo as decimal strings (`src/server.ts:616`) |
| `GET` | `/v1/fleets/:id` | owner, admin, or service reader | — | one fleet (`src/server.ts:634`) |
| `GET` | `/v1/battles` | owner (the fleets-list pattern) | a player's battle history, both sides, stored outcomes and digests — never recomputed |
| `GET` | `/v1/battles/:id` | participants, admin, service reader — **anyone once the season sealed** | — | the immutable report with its digest (`src/server.ts:649`) |
| `POST` | `/v1/alliances` | user | — | bind an alliance to an EXISTING community; `communityId` required, never minted (`src/server.ts:715`) |
| `GET` | `/v1/alliances` | bearer | the world's alliance directory with `mine` marked — which-am-I-in answered by the list itself |
| `GET` | `/v1/alliances/:id` | user, or service reader | — | members, claims, beacons, shared lanes (`src/server.ts:742`) |
| `POST` | `/v1/alliances/:id/members` | user (self) | join replays | one banner per player per world (`src/server.ts:752`) |
| `DELETE` | `/v1/alliances/:id/members` | user (self) | — | leave (`src/server.ts:765`) |
| `POST` | `/v1/alliances/:id/claims` | member with a city on the island | first banner wins | claim an island; shared lanes follow (`src/server.ts:778`) |
| `GET` | `/v1/chronicle/seasons` | **anonymous** | — | sealed seasons with digests (`src/server.ts:800`) |
| `GET` | `/v1/chronicle/seasons/:id` | **anonymous** | — | the chronicle summary + digest; 404 unless sealed (`src/server.ts:816`) |
| `GET` | `/v1/chronicle/seasons/:id/battles` | **anonymous** | — | every battle verbatim — the replay browser's source (`src/server.ts:833`) |

## Background work

Leased jobs only; there are no timers and **no economy tick**. The lease key names the contended
resource (`src/jobs.ts` header table).

| Job | Lease key | When | Two replicas |
| --- | --- | --- | --- |
| `outbox.relay` | `stream` | every 1s | one relays (`src/jobs.ts:104`) |
| `season.ensure` | `stream` | every 60s | one opens; the loser conflicts on `seasons_one_open` and reads the winner. Also backfills the open season's lattice and keeps `season.close` armed (`src/jobs.ts:109`) |
| `city.queue` | `city:<id>` | next completion | the `status='queued'` guard applies each item once (`src/jobs.ts:162`) |
| `fleet.arrive` | `fleet:<id>` | arrival, then the return leg | the row's `for update` + status guard, and `battles_fleet_uniq` beneath them — §9.3, raced for real in `fleets.test.ts` (`src/jobs.ts:130`) |
| `siege.resolve` | `plot:<islandId>:<n>` | when a besieger arrives | every battle for a contested plot serialises under ONE lease, in arrival order (`src/jobs.ts:143`) |
| `season.close` | `season:<id>` | `ends_at` | the season row's `status='open'` guard; then the trigger owns history (`src/jobs.ts:155`) |

**Re-arms happen after completion, never inside a handler.** A handler that enqueues its own
`(kind, key)` writes into its own claimed row, which the runner then deletes — the re-arm
silently evaporates. Phase 1's `city.queue` handler did exactly that; the defect is pinned as a
test (`jobs.test.ts` "THE TRAP") and every same-key re-arm now runs from the runner's `completed`
event (`src/jobs.ts` `rearmCityQueue`, `rearmFleet`).

## The database

Phase-1 constraints unchanged (one open season, one city per player per island, stocks within
`[0, cap]`, provision idempotency — see `src/migrations.ts` versions 1–8). Phase 2 adds:

| Constraint | Refuses | Why here |
| --- | --- | --- |
| `lanes_directed_uniq` + `lanes_no_self` + `lanes_multiplier_range` | duplicate, degenerate or out-of-domain lanes | racing backfills converge instead of duplicating (`src/migrations.ts:361`) |
| `city_ships_count_non_negative` | a launch taking ships the garrison lacks | the CHECK behind the guarded UPDATE (`src/migrations.ts:392`) |
| `fleets_cargo_within_hold` (deferred constraint trigger) | a fleet departing — or returning — with more cargo than its freight holds | capacity lives in composition, so fleets AND fleet_ships are judged together at COMMIT; the SQL holds are pinned against `AIRSHIPS` in `fleets.test.ts` (`src/migrations.ts:507`) |
| `fleets_key_uniq` | re-charging a retried launch | same idempotency shape as queue_items (`src/migrations.ts:435`) |
| `battles_fleet_uniq` | a second battle for one arrival | §9.3's structural floor beneath the lease and the status guard (`src/migrations.ts:557`) |
| `battles_immutable` (trigger) | UPDATE/DELETE on any battle | a report that can be edited is not a report (`src/migrations.ts:574`) |
| `battles_digest_shape` | a report without its sha256 | the determinism claim is a column, not a habit (`src/migrations.ts:551`) |
| `alliances_community_uniq` | one community backing two alliances per world | one treasury, one banner (`src/migrations.ts:598`) |
| `alliance_members_one_per_world` | a player flying two banners | unrepresentable, not policed (`src/migrations.ts:610`) |
| `alliance_claims` primary key on `island_id` | two claims on one island | the first banner planted wins the race (`src/migrations.ts:615`) |
| `seasons_sealed_is_dated` | a sealed season without its date | (`src/migrations.ts:633`) |
| `seasons_sealed_immutable` (trigger) | UPDATE/DELETE on a sealed season, **including un-sealing** | doc §9.5: an error even for a caller holding a connection (`src/migrations.ts:667`) |
| `chronicles_immutable` (trigger) | rewriting history | the chronicle reads as it sealed (`src/migrations.ts:679`) |

## Events

Producer of eight registered topics (`contracts/packages/events`): the phase-1 five plus
`aetherholm.battle.resolved` (keyed `battle_id` — the payload names BOTH parties; the defender is
the news), `aetherholm.spire.captured` (keyed `island_id`, member user ids aboard the payload)
and `aetherholm.season.sealed` (keyed `season_id`, carries the chronicle digest). Deliveries sign
through `@cloudsforge/contracts-events` (`signDelivery`, `cf-signature`); there is no local
signing copy.

## Configuration

Unchanged from phase 1: no upstream URL, no service token, no new variables. Every variable is
declared in `src/env.ts` and `.env.example` agrees; CI compares the two.

| Variable | Default | If wrong |
| --- | --- | --- |
| `AETHERHOLM_DATABASE_URL` | — | refuses to start, naming the variable (`src/env.ts:109`) |
| `IDENTITY_JWKS_URL` / `IDENTITY_ISSUER` | — | every authenticated route answers 503, never 401 |
| `OUTBOX_SIGNING_SECRET` | — | refuses to start; placeholders and short strings refused too (`src/env.ts:113`) |
| `PORT` | `4120` (`src/env.ts:105`) | the registry row in `micro-ui` pins this value against this file |
| `AETHERHOLM_DATABASE_POOL_MAX` | 10 | pool exhaustion or Postgres exhaustion |
| `LOG_LEVEL`, `NODE_ENV`, `CLOUDSFORGE_TAG`, `INSTANCE_ID` | `info` / `development` / `dev` / hostname | cosmetic to fatal-log routing |

## Running it

```bash
pnpm install
docker run -d --rm --name aetherholm-pg -e POSTGRES_USER=aetherholm -e POSTGRES_PASSWORD=aetherholm \
  -e POSTGRES_DB=aetherholm_test -p 55488:5432 postgres:17-alpine
AETHERHOLM_TEST_DATABASE_URL=postgres://aetherholm:aetherholm@127.0.0.1:55488/aetherholm_test pnpm test
```

The suite refuses a DSN whose database name does not contain `test` — it truncates. The migrator
is a separate one-shot (`pnpm migrate`); `index.ts` asserts the schema version and refuses to
serve below it.

## Known gaps, recorded rather than implied

- **Heraldry consumption is not wired in worlds.** This service emits `spire.captured` and
  `season.sealed` faithfully; nothing in `worlds` subscribes yet, so the entitlement grant is an
  event with no consumer. That wiring belongs to worlds and is out of this repository's remit.
- **The alliance's `communityId` is stored, not verified.** This service makes no outbound call
  (by design — `src/env.ts` explains), so a fabricated uuid buys an alliance whose governance
  simply does not exist. The moment governance is exercised, community is the authority; a
  verification hop can be added when a service credential for community exists.
- **Monetisation delivery is not wired.** The Charter's +2 build slots, the season pass track,
  cosmetics and name reservation (doc §7) still have no delivery path; `BASE_BUILD_SLOTS` in
  `src/content.ts` is where the Charter read will land.
- **No attack-incoming warning.** A defender learns of a raid when it resolves; a
  `fleet.sighted`-style topic (the Watchspire's purpose) is a phase-3 decision, recorded in
  notify's catalogue reasoning.
- **Ship queue completions emit no event** — a hull joining its own harbour is the player's plan
  proceeding, not news; the battles it fights are.
- **Registration is an operator act.** This service does not self-register with worlds at boot;
  an operator posts the row (`worlds/src/server.ts:484`) and runs worlds' conformance suite
  against it first.
- **The well/strain system (doc §2) is not implemented** — no storm grounding, no strain
  mechanics; the well meeting is still ahead. Research effects remain recorded, not applied.
- **`micro-aetherholm-web` and `-assets` do not exist yet** (doc §11, phases 3–4). The chronicle
  routes are the replay browser's data source, ready for the client.

[`ecosystem/20-aetherholm.md`]: https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/20-aetherholm.md

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.

# micro-aetherholm

The third Forge Worlds title: a sky-island strategy MMO at Ikariam scale
([docs/ecosystem/20-aetherholm.md] is the design; this repository is its phase 1). It owns the
world — seasons with seeds, archipelagos, islands, cities, buildings, build and research queues,
and a **lazy economy with no world tick** — and it is the first service in the estate to implement
the title contract `worlds` actually calls: `GET /v1/title` and `POST /v1/provision`
(`worlds/src/titleclient.ts:122`, `:134`), provisioning a **Private Skerry** idempotently on the
entitlement id.

> **What it refuses.** This service holds no money: there is no balance or Shard column anywhere,
> and `migrations.test.ts` proves the absence by enumerating `information_schema.columns`. The
> Skywright's Charter and the season pass are `billing` products; cosmetics and heraldry are
> `worlds` entitlements. **The aegis — a new city's free 7-day protection — cannot be purchased**:
> the only code that writes `aegis_until` is city founding, and `titlecontract.test.ts` asserts
> that absence over comment-stripped source, both behaviourally (an aegis-shaped SKU is 422
> `unsupported`) and structurally (no other module names the column). Nothing sells speed either:
> build and research durations have no purchase path at all — in a competitive world, time is
> power (20-aetherholm.md §7).

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
The only SKU sold is `private_skerry` (`src/provisioning.ts:29`): a 12-island private archipelago
whose geography is derived from `sha256(entitlementId)`, so even a hypothetical double-create
could not mint two geographies for one purchase (`src/world.ts` `skerrySeed`).

`src/titlecontract.test.ts` mirrors all nine conformance checks of `worlds/src/conformance.ts`
one for one over real HTTP against a real database, each test citing the worlds line it
reproduces. The credential worlds presents (`WORLDS_SERVICE_TOKEN`, `worlds/.env.example:31-34` —
"the credential a TITLE service sees on a provisioning call, so a title can and must check it")
must carry the `aetherholm:provision` scope; a missing, forged, wrong-scoped or user token is
refused (`src/server.ts:294-301`).

## The lazy economy

There is no tick. Stocks are **computed on read** from `(last_settled_at, rates, cap)` and
**settled on write** (`src/economy.ts`): the read path and the write path share one pure function,
`accrue`, so the number a player was shown and the number a spend is charged against cannot
diverge. Everything is `bigint`, floor arithmetic, decimal strings on the wire — the estate's
money rule applied to resources, for the same reason. A clock that steps backwards accrues
nothing rather than subtracting, and `last_settled_at` never moves backwards.

## Routes

Read out of `src/server.ts`. `/livez`, `/readyz`, `/metrics` and `GET /v1/title` make no
`authenticate()` call — everything else 401s without a bearer token.

| Method | Path | Who | Idempotency-Key | What it does |
| --- | --- | --- | --- | --- |
| `GET` | `/livez` | anyone | — | static liveness (`src/server.ts:270`) |
| `GET` | `/readyz` | anyone | — | Postgres hard, JWKS soft (`src/server.ts:272`) |
| `GET` | `/metrics` | anyone | — | Prometheus text (`src/server.ts:277`) |
| `GET` | `/v1/title` | anyone | — | the title descriptor; public, it is a capability statement (`src/server.ts:292`) |
| `POST` | `/v1/provision` | service with `aetherholm:provision` only | sent by worlds; dedupe is on the body's `entitlementId` | provision a Private Skerry; replays on the entitlement id; unknown SKU is 422 `unsupported` (`src/server.ts:294`) |
| `GET` | `/v1/seasons/current` | user, or service with `aetherholm:read` | — | the open season, its seed as a decimal string (`src/server.ts:340`) |
| `GET` | `/v1/archipelagos/:id/islands` | user, or service with `aetherholm:read` | — | islands with free plot counts (`src/server.ts:359`) |
| `POST` | `/v1/cities` | user (service with `aetherholm:write` + `x-user-id`) | not needed — the partial unique IS the idempotency; a refound answers 200 with the existing city | found a city: skyhall 1, starting stocks, 7-day aegis (`src/server.ts:373`) |
| `GET` | `/v1/cities` | own list; admin may name `?userId=`; service with `aetherholm:read` must | — | list cities with computed stocks (`src/server.ts:398`) |
| `GET` | `/v1/cities/:id` | owner, admin, or service with `aetherholm:read` | — | the city with stocks computed at read time; 403 to other players — the economy is the secret, not the existence (`src/server.ts:417`) |
| `POST` | `/v1/cities/:id/buildings` | owner | **required** | settle, charge, queue a building level; retry replays, never 409 (`src/server.ts:432`) |
| `POST` | `/v1/cities/:id/research` | owner | **required** | settle, charge, queue a research node (`src/server.ts:436`) |

## Background work

Leased jobs only; there are no timers, and deliberately **no economy tick** — laziness is the
design, and `jobs.test.ts` pins the recurring set so a tick cannot appear unnoticed.

| Job | Lease key | Cadence | Two replicas |
| --- | --- | --- | --- |
| `outbox.relay` | `stream` | 1s | one relays; keying on an event id would deliver a batch twice (`src/jobs.ts:28`) |
| `season.ensure` | `stream` | 60s | one opens the season; the loser conflicts on `seasons_one_open` and reads the winner (`src/jobs.ts:29`, `src/seasons.ts`) |
| `city.queue` | `city:<id>` | when the next item completes; re-armed with `onConflict: 'earliest'` | one claims; and the `status = 'queued'` UPDATE guard applies each item exactly once even so (`src/jobs.ts:82`, `src/cities.ts` `completeDue`) |

## The database

The constraints that carry the design, each in the schema rather than a handler because a handler
guards one code path and a constraint guards every path that will ever exist — including an
operator with psql and a bug not yet written.

| Constraint | Refuses | Why here |
| --- | --- | --- |
| `cities_stocks_settled_within_caps` | a settlement below zero or above the warehouse cap | holds against the settlement bug not yet written, the double-spend retry, and a raw UPDATE — property-tested from both sides in `economy.test.ts` (`src/migrations.ts:212`) |
| `cities_one_per_player_per_island` (partial unique, `where abandoned_at is null`) | a player's second city on one island | unrepresentable, not merely refused; partial so a phase-2 razing frees the plot without deleting history (`src/migrations.ts:230`) |
| `cities_one_per_plot` (partial unique) | two cities on one plot (`src/migrations.ts:234`) | same shape |
| `provisions_entitlement_uniq` | a second provision for one purchase | the idempotency key of the whole worlds bridge, made structural (`src/migrations.ts:332`) |
| `archipelagos_entitlement_uniq` (partial unique) | one entitlement owning two skerries | the second line: holds even against an INSERT that skips the provisions row (`src/migrations.ts:149`) |
| `seasons_one_open` (partial unique) | two open seasons | N replicas race the season job; whichever commits first wins (`src/migrations.ts:113`) |
| `archipelagos_ownership_coherent` | a world half public, half private | a public archipelago belongs to a season and nobody; a skerry to somebody and no season (`src/migrations.ts:131`) |
| `islands_twelve_plots` | an island that is not 12 plots | the design's table is the contract (`src/migrations.ts:163`) |
| `queue_items_key_uniq` | re-charging a retried queue submission | the fingerprint compared on replay is `(kind, target)` and excludes `correlationId` — fingerprinting a trace id made honest retries 409 in the ledger (`src/migrations.ts:284`) |
| `provisions_urn_shape` | recording a urn this service did not mint (`src/migrations.ts:334`) | a urn the estate cannot dereference |

## Configuration

Every variable is declared in `src/env.ts` and nowhere else; `.env.example` agrees with it and CI
compares the two. **There is no upstream URL and no service token**: phase 1 makes no outbound
HTTP call — the title contract is inbound, and worlds brings its own credential.

| Variable | Default | If wrong |
| --- | --- | --- |
| `AETHERHOLM_DATABASE_URL` | — | refuses to start, naming the variable (`src/env.ts:109`) |
| `IDENTITY_JWKS_URL` / `IDENTITY_ISSUER` | — | every authenticated route answers 503, never 401 — a JWKS outage must not sign the estate out |
| `OUTBOX_SIGNING_SECRET` | — | refuses to start; placeholders and short strings are refused too (`src/env.ts:113`) |
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

- **Monetisation delivery is not wired.** The Charter's +2 build slots, the season pass track,
  cosmetics and name reservation (20-aetherholm.md §7) have no delivery path yet;
  `BASE_BUILD_SLOTS` in `src/content.ts` is where the Charter read will land. Principle 3 of 01
  applies before any SKU is listed: it is delivered or it is withdrawn, including from the API.
- **Phase 2 is absent by design**: the wind lattice, fleets, travel, battles, sieges, season
  close/sealing (the `'sealed'` status value exists; the immutability trigger ships with the
  sealing it protects), alliances via `micro-community`, and the chronicle
  (20-aetherholm.md §11).
- **Registration is an operator act.** This service does not self-register with worlds at boot;
  an operator posts the row (`worlds/src/server.ts:484`) with `service_url` pointing here and
  runs worlds' conformance suite against it first, as `worlds/src/conformance.ts` intends.
- **Research effects are recorded, not applied** — the trees' effects are phase-2 content, and
  the canonical trees move to `micro-aetherholm-assets` when that repository exists.

[docs/ecosystem/20-aetherholm.md]: ../docs/ecosystem/20-aetherholm.md

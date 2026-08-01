/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * What this schema owns: seasons and their seeded archipelagos, islands, cities with LAZY resource
 * stocks, buildings, build/research queues, completed research, and the provisions the title
 * contract has delivered. **There is deliberately no balance or Shard column anywhere** — this
 * service holds no money; a Charter or a season pass is a `billing` product and cosmetics are
 * `worlds` entitlements. `migrations.test.ts` proves the absence by enumerating
 * `information_schema.columns`.
 *
 * ## Why the invariants are HERE and not in handlers
 *
 * A handler guards one code path; a constraint guards every path that will ever exist, including
 * an operator with psql and a bug not yet written. Each constraint below names the disaster it
 * makes unrepresentable, because the reasoning is the part a reader cannot recover from the SQL.
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs';
import type { Migration } from '@cloudsforge/db';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Verbatim from the runtime package so the claim query's table and the table that exists
    // cannot drift.
    up: JOBS_SCHEMA_SQL,
  },
  {
    version: 2,
    name: 'outbox',
    up: `
      create table if not exists outbox (
        id             uuid        primary key default gen_random_uuid(),
        topic          text        not null,
        key            text        not null,
        occurred_at    timestamptz not null default now(),
        producer       text        not null,
        version        integer     not null default 1,
        actor          text,
        correlation_id text,
        payload        jsonb       not null default '{}'::jsonb,
        published_at   timestamptz
      );

      create index if not exists outbox_unpublished_idx
        on outbox (occurred_at)
        where published_at is null;

      create table if not exists event_subscriptions (
        id         uuid        primary key default gen_random_uuid(),
        topic      text        not null,
        url        text        not null,
        active     boolean     not null default true,
        created_at timestamptz not null default now(),
        constraint event_subscriptions_topic_url_uniq unique (topic, url)
      );

      create table if not exists outbox_deliveries (
        event_id        uuid        not null references outbox (id) on delete cascade,
        subscription_id uuid        not null references event_subscriptions (id) on delete cascade,
        delivered_at    timestamptz,
        attempts        integer     not null default 0,
        last_error      text,
        primary key (event_id, subscription_id)
      );
    `,
  },
  {
    version: 3,
    name: 'inbox',
    up: `
      -- Delivery is at-least-once, so the consumer is what makes it effectively-once. The primary
      -- key is the dedupe: a redelivered event conflicts and the handler is never re-run.
      create table if not exists inbox (
        topic       text        not null,
        event_id    uuid        not null,
        received_at timestamptz not null default now(),
        primary key (topic, event_id)
      );
    `,
  },
  {
    version: 4,
    name: 'world',
    up: `
      create table if not exists seasons (
        id         uuid          primary key default gen_random_uuid(),
        name       text          not null,
        -- The season seed, a u64 as numeric(20,0). Everything geographic is derived from it,
        -- so it is constrained to the PRNG's domain exactly as emberkin constrains its save seed.
        seed       numeric(20,0) not null,
        status     text          not null default 'open',
        opened_at  timestamptz   not null default now(),
        ends_at    timestamptz   not null,
        created_at timestamptz   not null default now(),
        constraint seasons_seed_range check (seed >= 0 and seed <= 18446744073709551615),
        -- 'sealed' is a forward reference phase 2 needs; phase 1 only ever writes 'open'.
        constraint seasons_status_known check (status in ('open','sealed')),
        constraint seasons_dates_ordered check (ends_at > opened_at)
      );

      -- ══════════════════════════════════════════════════════════════════════════════════════
      -- AT MOST ONE OPEN SEASON. A partial unique index rather than a handler check, because the
      -- season is opened by a recurring leased job on N replicas: whichever transaction commits
      -- first wins and every later one conflicts, no matter which replica or which operator ran
      -- it. Two open seasons would be two worlds claiming the same players.
      -- ══════════════════════════════════════════════════════════════════════════════════════
      create unique index if not exists seasons_one_open
        on seasons ((true))
        where status = 'open';

      create table if not exists archipelagos (
        id             uuid          primary key default gen_random_uuid(),
        kind           text          not null,
        season_id      uuid          references seasons (id),
        -- The Private Skerry's owner and the entitlement that paid for it. Null on the public world.
        owner_subject  text,
        entitlement_id text,
        name           text          not null,
        seed           numeric(20,0) not null,
        created_at     timestamptz   not null default now(),
        constraint archipelagos_kind_known check (kind in ('public','skerry')),
        constraint archipelagos_seed_range check (seed >= 0 and seed <= 18446744073709551615),
        -- A public archipelago belongs to a season and nobody; a skerry belongs to somebody and
        -- no season. Enforced as one CHECK so a row cannot be half of each.
        constraint archipelagos_ownership_coherent check (
          (kind = 'public' and season_id is not null and owner_subject is null and entitlement_id is null)
          or
          (kind = 'skerry' and season_id is null and owner_subject is not null and entitlement_id is not null)
        )
      );

      -- One public archipelago per season: the season IS its geography.
      create unique index if not exists archipelagos_one_public_per_season
        on archipelagos (season_id)
        where kind = 'public';

      -- ══════════════════════════════════════════════════════════════════════════════════════
      -- THE IDEMPOTENCY OF A PROVISION, second line. The provisions table's unique (below) is
      -- the first; this one holds even against a hand-written INSERT that skips the provisions
      -- row: one entitlement can never own two skerries, which is the exact defect the worlds
      -- bridge exists to prevent (worlds/src/titleclient.ts file header).
      -- ══════════════════════════════════════════════════════════════════════════════════════
      create unique index if not exists archipelagos_entitlement_uniq
        on archipelagos (entitlement_id)
        where entitlement_id is not null;

      create table if not exists islands (
        id             uuid        primary key default gen_random_uuid(),
        archipelago_id uuid        not null references archipelagos (id) on delete cascade,
        idx            integer     not null,
        band           text        not null,
        plots          smallint    not null default 12,
        constraint islands_idx_non_negative check (idx >= 0),
        constraint islands_band_known check (band in ('shallows','midreach','highwind')),
        -- 12 plots + 1 communal well is the design's table (20-aetherholm.md §1); a different
        -- count is a generator bug, not a variant.
        constraint islands_twelve_plots check (plots = 12),
        constraint islands_idx_uniq unique (archipelago_id, idx)
      );
    `,
  },
  {
    version: 5,
    name: 'cities',
    up: `
      create table if not exists cities (
        id              uuid        primary key default gen_random_uuid(),
        island_id       uuid        not null references islands (id),
        user_id         uuid        not null,
        plot            smallint    not null,
        name            text        not null,
        founded_at      timestamptz not null default now(),
        -- The free 7-day protection. Set at founding and NOWHERE else: the aegis is never sold
        -- (20-aetherholm.md §4), and the title-contract suite asserts no provision path can
        -- reach it.
        aegis_until     timestamptz not null,
        -- Razing/abandonment is phase 2; the column exists now because the partial unique
        -- indexes below need their predicate to be stable across that migration.
        abandoned_at    timestamptz,

        -- ═══════════════════════════════════════════════════════════════════════════════════
        -- THE LAZY ECONOMY. There is no world tick: stocks are computed on read from
        -- (last_settled_at, rates, cap) and SETTLED on write. Every column an accrual reads is
        -- here, so a settlement is a pure function of this row and a clock.
        -- ═══════════════════════════════════════════════════════════════════════════════════
        last_settled_at  timestamptz not null default now(),
        aether           bigint      not null,
        cloudstone       bigint      not null,
        skysteel         bigint      not null,
        provisions       bigint      not null,
        storage_cap      bigint      not null,
        rate_aether      bigint      not null,
        rate_cloudstone  bigint      not null,
        rate_skysteel    bigint      not null,
        rate_provisions  bigint      not null,

        constraint cities_name_length check (char_length(name) between 1 and 60),
        constraint cities_plot_range check (plot between 1 and 12),
        constraint cities_aegis_after_founding check (aegis_until >= founded_at),
        -- ═══════════════════════════════════════════════════════════════════════════════════
        -- A SETTLEMENT MAY NEVER WRITE A NEGATIVE STOCK OR ONE ABOVE CAP. The application
        -- computes clamped values, but the CHECK is what holds against the settlement bug not
        -- yet written, the retry that double-spends, and the operator UPDATE — none of which a
        -- handler can see. Property-tested in economy.test.ts from both sides.
        -- ═══════════════════════════════════════════════════════════════════════════════════
        constraint cities_stocks_settled_within_caps check (
          aether     between 0 and storage_cap and
          cloudstone between 0 and storage_cap and
          skysteel   between 0 and storage_cap and
          provisions between 0 and storage_cap
        ),
        constraint cities_rates_non_negative check (
          rate_aether >= 0 and rate_cloudstone >= 0 and rate_skysteel >= 0 and rate_provisions >= 0
        ),
        constraint cities_cap_positive check (storage_cap > 0)
      );

      -- ═════════════════════════════════════════════════════════════════════════════════════
      -- ONE CITY PER PLAYER PER ISLAND, and one city per plot — as PARTIAL unique indexes so a
      -- razed city (phase 2 writes abandoned_at) frees the plot without deleting history. The
      -- second city is unrepresentable, not merely refused: no handler race, no replayed
      -- request, no psql session can write it.
      -- ═════════════════════════════════════════════════════════════════════════════════════
      create unique index if not exists cities_one_per_player_per_island
        on cities (island_id, user_id)
        where abandoned_at is null;

      create unique index if not exists cities_one_per_plot
        on cities (island_id, plot)
        where abandoned_at is null;

      create index if not exists cities_user_idx on cities (user_id, founded_at desc);
    `,
  },
  {
    version: 6,
    name: 'buildings_and_queues',
    up: `
      create table if not exists buildings (
        city_id    uuid        not null references cities (id) on delete cascade,
        type       text        not null,
        level      integer     not null default 0,
        updated_at timestamptz not null default now(),
        primary key (city_id, type),
        constraint buildings_type_known check (type in (
          'skyhall','well_rig','cloudstone_quarry','skysteel_forge','terrace_farm','warehouse',
          'vault','residences','aerodock','launch_rails','windworks','academy','watchspire',
          'storm_anchor','bulwark_ring','trade_gantry','guild_beacon','charthouse','infirmary',
          'hall_of_banners'
        )),
        constraint buildings_level_non_negative check (level >= 0)
      );

      create table if not exists queue_items (
        id              uuid        primary key default gen_random_uuid(),
        city_id         uuid        not null references cities (id) on delete cascade,
        kind            text        not null,
        target          text        not null,
        status          text        not null default 'queued',
        started_at      timestamptz not null default now(),
        completes_at    timestamptz not null,
        completed_at    timestamptz,
        -- ═══════════════════════════════════════════════════════════════════════════════════
        -- THE IDEMPOTENCY OF A QUEUE SUBMISSION. Derived from the client's Idempotency-Key;
        -- the fingerprint the handler compares on replay is (kind, target) and deliberately
        -- EXCLUDES per-attempt fields such as correlationId — fingerprinting a trace id made
        -- honest retries 409 in the ledger (ledger/src/idempotency.test.ts is the estate's
        -- record of that lesson). The unique below is what makes the retry read, not re-spend.
        -- ═══════════════════════════════════════════════════════════════════════════════════
        idempotency_key text        not null,
        created_at      timestamptz not null default now(),
        constraint queue_items_kind_known check (kind in ('building','research')),
        constraint queue_items_status_known check (status in ('queued','done')),
        constraint queue_items_ordered check (completes_at > started_at),
        constraint queue_items_done_is_complete check (
          (status = 'done') = (completed_at is not null)
        ),
        constraint queue_items_key_uniq unique (city_id, idempotency_key)
      );

      create index if not exists queue_items_due_idx
        on queue_items (city_id, completes_at)
        where status = 'queued';
    `,
  },
  {
    version: 7,
    name: 'research',
    up: `
      -- Research is per player per ARCHIPELAGO: knowledge does not cross a season boundary
      -- (a new season is a level field, 20-aetherholm.md §2) nor leak between a skerry and the
      -- public world. The primary key IS the idempotency: completing a node twice conflicts.
      create table if not exists research (
        archipelago_id uuid        not null references archipelagos (id) on delete cascade,
        user_id        uuid        not null,
        node           text        not null,
        completed_at   timestamptz not null default now(),
        primary key (archipelago_id, user_id, node)
      );
    `,
  },
  {
    version: 8,
    name: 'provisions',
    up: `
      -- What the title contract has delivered. One row per entitlement, FOREVER: the replay
      -- reads this row and returns the same urn, which is check 5 of worlds' conformance suite
      -- (worlds/src/conformance.ts:35-39) — "provisioning twice returns the SAME urn".
      create table if not exists provisions (
        id             uuid        primary key default gen_random_uuid(),
        entitlement_id text        not null,
        subject        text        not null,
        user_id        text        not null,
        sku            text        not null,
        scope          text        not null,
        archipelago_id uuid        not null references archipelagos (id),
        urn            text        not null,
        metadata       jsonb       not null default '{}'::jsonb,
        created_at     timestamptz not null default now(),
        -- ═══════════════════════════════════════════════════════════════════════════════════
        -- THE IDEMPOTENCY KEY OF THE WHOLE BRIDGE (worlds/src/titleclient.ts:12-17). The
        -- entitlement id is the one value stable across redelivery, retry and replica
        -- takeover, so it is unique here: a second INSERT for one purchase conflicts, and the
        -- handler answers with the first row and replayed: true.
        -- ═══════════════════════════════════════════════════════════════════════════════════
        constraint provisions_entitlement_uniq unique (entitlement_id),
        -- A urn this service did not mint is a urn the estate cannot dereference.
        constraint provisions_urn_shape check (urn like 'cf:aetherholm:skerry:%')
      );
    `,
  },
];

/** The version this build requires. `index.ts` asserts it at boot and refuses to serve below it. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/** A new service baselines at 0 — there is no ancestor schema; this game was designed here. */
export const BASELINE_VERSION = 0;

/** Every table this service owns, for the test harness's truncate. Order is child-first. */
export const TABLES: readonly string[] = Object.freeze([
  'provisions',
  'research',
  'queue_items',
  'buildings',
  'cities',
  'islands',
  'archipelagos',
  'seasons',
  'inbox',
  'outbox_deliveries',
  'event_subscriptions',
  'outbox',
]);

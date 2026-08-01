/**
 * The phase-1 content contract: building types, research nodes, costs, rates and caps.
 *
 * The COUNTS are the contract — 20 buildings, 32 research nodes in 4 branches of 8
 * (docs/ecosystem/20-aetherholm.md §4) — and `content.test.ts` pins them. The full trees
 * (prerequisite edges, per-level curves, art) live in `micro-aetherholm-assets` when that
 * repository exists, following the Emberkin pattern of content JSON driving both the engine and
 * the art prompts. What lives here is the minimum the phase-1 economy genuinely executes:
 * which buildings produce, which building caps storage, and what a queue item costs.
 *
 * **Every amount is `bigint`.** Resources are not Shards — no Shard is ever held by this service —
 * but the same rule applies for the same reason: a float near an amount eventually rounds a
 * settlement, and a rounded settlement is a stock that drifts from what the CHECK constraint
 * believes was written.
 */

export const RESOURCES = ['aether', 'cloudstone', 'skysteel', 'provisions'] as const;
export type Resource = (typeof RESOURCES)[number];

export type Stocks = Readonly<Record<Resource, bigint>>;

/** The 20 building types of 20-aetherholm.md §4, snake_cased for the schema CHECK. */
export const BUILDING_TYPES = [
  'skyhall',
  'well_rig',
  'cloudstone_quarry',
  'skysteel_forge',
  'terrace_farm',
  'warehouse',
  'vault',
  'residences',
  'aerodock',
  'launch_rails',
  'windworks',
  'academy',
  'watchspire',
  'storm_anchor',
  'bulwark_ring',
  'trade_gantry',
  'guild_beacon',
  'charthouse',
  'infirmary',
  'hall_of_banners',
] as const;
export type BuildingType = (typeof BUILDING_TYPES)[number];

export function isBuildingType(value: string): value is BuildingType {
  return (BUILDING_TYPES as readonly string[]).includes(value);
}

/** The 32 research nodes: 4 branches × 8, per §4. Effects beyond the record land with phase 2. */
export const RESEARCH_BRANCHES = ['economy', 'aeronautics', 'warfare', 'statecraft'] as const;
export type ResearchBranch = (typeof RESEARCH_BRANCHES)[number];

export const RESEARCH_NODES: Readonly<Record<ResearchBranch, readonly string[]>> = Object.freeze({
  economy: [
    'well_lore',
    'cistern_craft',
    'quarry_songs',
    'ledger_discipline',
    'terraced_bounty',
    'vault_locks',
    'guild_charters',
    'deep_veins',
  ],
  aeronautics: [
    'gasbag_trim',
    'keel_balance',
    'wind_reading',
    'lift_theory',
    'aether_burners',
    'storm_rigging',
    'long_hauls',
    'flagship_doctrine',
  ],
  warfare: [
    'boarding_drills',
    'gun_carriages',
    'armour_plating',
    'initiative_drills',
    'siege_breakers',
    'watch_networks',
    'bulwark_engineering',
    'banner_command',
  ],
  statecraft: [
    'well_meetings',
    'trade_pacts',
    'charter_law',
    'beacon_diplomacy',
    'chronicle_keeping',
    'heraldry',
    'alliance_bonds',
    'season_rites',
  ],
});

export const ALL_RESEARCH_NODES: readonly string[] = Object.freeze(
  RESEARCH_BRANCHES.flatMap((branch) => [...RESEARCH_NODES[branch]]),
);

export function isResearchNode(value: string): boolean {
  return ALL_RESEARCH_NODES.includes(value);
}

export function branchOf(node: string): ResearchBranch | null {
  for (const branch of RESEARCH_BRANCHES) {
    if (RESEARCH_NODES[branch].includes(node)) return branch;
  }
  return null;
}

/* ------------------------------------------------------------------ the phase-1 economy */

/** A new city's starting position. Modest, above zero so the first queue is affordable. */
export const STARTING_STOCKS: Stocks = Object.freeze({
  aether: 120n,
  cloudstone: 200n,
  skysteel: 60n,
  provisions: 160n,
});

/** Base accrual per hour before any building, so an empty plot still limps forward. */
export const BASE_RATES: Stocks = Object.freeze({
  aether: 4n,
  cloudstone: 8n,
  skysteel: 2n,
  provisions: 6n,
});

/** Base warehouse-less storage cap, per resource. */
export const BASE_STORAGE_CAP = 500n;
/** Additional cap per warehouse level. */
export const WAREHOUSE_CAP_PER_LEVEL = 400n;

/** Per-level production, for the four producers. Everything else produces nothing in phase 1. */
export const PRODUCTION_PER_LEVEL: Readonly<Partial<Record<BuildingType, Readonly<Partial<Record<Resource, bigint>>>>>> =
  Object.freeze({
    well_rig: Object.freeze({ aether: 6n }),
    cloudstone_quarry: Object.freeze({ cloudstone: 12n }),
    skysteel_forge: Object.freeze({ skysteel: 4n }),
    terrace_farm: Object.freeze({ provisions: 10n }),
  });

/**
 * Aether richness by altitude band — higher bands yield richer Aether (20-aetherholm.md §2).
 * Applied to the WELL-DRAWN part of the rate only, never to the base trickle: the well is the
 * island's, the trickle is the city's.
 */
export const BAND_AETHER_MULTIPLIER: Readonly<Record<string, bigint>> = Object.freeze({
  shallows: 1n,
  midreach: 2n,
  highwind: 3n,
});

/**
 * The accrual rates a city with these building levels earns, per hour.
 *
 * Pure over its inputs so the property tests can sweep it, and so the settlement job and the
 * read path cannot compute two different answers.
 */
export function ratesFor(
  levels: ReadonlyMap<BuildingType, number>,
  band: string,
): Stocks {
  const rate: Record<Resource, bigint> = { ...BASE_RATES };
  for (const [type, perLevel] of Object.entries(PRODUCTION_PER_LEVEL)) {
    const level = BigInt(levels.get(type as BuildingType) ?? 0);
    if (level === 0n) continue;
    for (const [resource, amount] of Object.entries(perLevel)) {
      let earned = amount * level;
      if (type === 'well_rig' && resource === 'aether') {
        earned *= BAND_AETHER_MULTIPLIER[band] ?? 1n;
      }
      rate[resource as Resource] += earned;
    }
  }
  return rate;
}

/** The storage cap a city with these building levels holds, per resource. */
export function storageCapFor(levels: ReadonlyMap<BuildingType, number>): bigint {
  return BASE_STORAGE_CAP + WAREHOUSE_CAP_PER_LEVEL * BigInt(levels.get('warehouse') ?? 0);
}

/* ------------------------------------------------------------------ costs and durations */

/** Base cost of level 1, scaled linearly by the level being built. Deliberately simple: the real
 *  curves are content, and content lives in the assets repository when phase 4 writes it. */
const BUILDING_BASE_COST: Stocks = Object.freeze({
  aether: 20n,
  cloudstone: 60n,
  skysteel: 15n,
  provisions: 30n,
});

export function buildingCost(_type: BuildingType, nextLevel: number): Stocks {
  const level = BigInt(Math.max(1, nextLevel));
  return {
    aether: BUILDING_BASE_COST.aether * level,
    cloudstone: BUILDING_BASE_COST.cloudstone * level,
    skysteel: BUILDING_BASE_COST.skysteel * level,
    provisions: BUILDING_BASE_COST.provisions * level,
  };
}

/** Seconds to build the given level. Time is power (20-aetherholm.md §7): never sold, never shortened. */
export function buildingDurationSeconds(_type: BuildingType, nextLevel: number): number {
  return 300 * Math.max(1, nextLevel);
}

const RESEARCH_BASE_COST: Stocks = Object.freeze({
  aether: 40n,
  cloudstone: 20n,
  skysteel: 10n,
  provisions: 25n,
});

export function researchCost(node: string): Stocks {
  const branch = branchOf(node);
  if (!branch) throw new RangeError(`unknown research node: ${node}`);
  const depth = BigInt(RESEARCH_NODES[branch].indexOf(node) + 1);
  return {
    aether: RESEARCH_BASE_COST.aether * depth,
    cloudstone: RESEARCH_BASE_COST.cloudstone * depth,
    skysteel: RESEARCH_BASE_COST.skysteel * depth,
    provisions: RESEARCH_BASE_COST.provisions * depth,
  };
}

export function researchDurationSeconds(node: string): number {
  const branch = branchOf(node);
  if (!branch) throw new RangeError(`unknown research node: ${node}`);
  return 600 * (RESEARCH_NODES[branch].indexOf(node) + 1);
}

/* ------------------------------------------------------------------ queue capacity */

/**
 * Base queue slots. The Skywright's Charter grants +2 build slots (20-aetherholm.md §7) — that
 * delivery is a billing entitlement read and lands with the monetisation wiring, recorded in the
 * README's known gaps. What phase 1 guarantees is the floor, and that no code path SELLS speed:
 * a slot changes how much you can plan, never how fast anything finishes.
 */
export const BASE_BUILD_SLOTS = 2;
export const BASE_RESEARCH_SLOTS = 1;

/** A new city's free protection, in days. Free at founding, never sold — see the aegis test. */
export const AEGIS_DAYS = 7;

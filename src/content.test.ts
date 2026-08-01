// The content contract. The COUNTS are the design's table (20-aetherholm.md §1 and §4): 20
// building types, 32 research nodes in 4 branches of 8. Pinned here so the trees cannot silently
// shrink or grow while the assets repository is still to come.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALL_RESEARCH_NODES,
  BASE_RATES,
  BASE_STORAGE_CAP,
  BUILDING_TYPES,
  RESEARCH_BRANCHES,
  RESEARCH_NODES,
  RESOURCES,
  branchOf,
  buildingCost,
  buildingDurationSeconds,
  ratesFor,
  researchCost,
  researchDurationSeconds,
  storageCapFor,
  type BuildingType,
} from './content.ts';

test('content: exactly 20 building types, all distinct', () => {
  assert.equal(BUILDING_TYPES.length, 20);
  assert.equal(new Set(BUILDING_TYPES).size, 20);
});

test('content: exactly 32 research nodes — 4 branches of 8, all distinct', () => {
  assert.equal(RESEARCH_BRANCHES.length, 4);
  for (const branch of RESEARCH_BRANCHES) {
    assert.equal(RESEARCH_NODES[branch].length, 8, `${branch} must hold 8 nodes`);
  }
  assert.equal(ALL_RESEARCH_NODES.length, 32);
  assert.equal(new Set(ALL_RESEARCH_NODES).size, 32);
});

test('content: every node knows its branch, and an unknown node does not', () => {
  for (const node of ALL_RESEARCH_NODES) assert.notEqual(branchOf(node), null, node);
  assert.equal(branchOf('alchemy'), null);
});

test('content: every amount anywhere is bigint — a float near an amount is a defect', () => {
  for (const resource of RESOURCES) {
    assert.equal(typeof BASE_RATES[resource], 'bigint');
  }
  assert.equal(typeof BASE_STORAGE_CAP, 'bigint');
  for (const type of BUILDING_TYPES) {
    const cost = buildingCost(type, 3);
    for (const resource of RESOURCES) assert.equal(typeof cost[resource], 'bigint');
  }
  for (const node of ALL_RESEARCH_NODES) {
    const cost = researchCost(node);
    for (const resource of RESOURCES) assert.equal(typeof cost[resource], 'bigint');
  }
});

test('content: costs and durations rise with level and depth — time is never free', () => {
  assert.ok(buildingCost('warehouse', 2).cloudstone > buildingCost('warehouse', 1).cloudstone);
  assert.ok(buildingDurationSeconds('warehouse', 5) > buildingDurationSeconds('warehouse', 1));
  assert.ok(researchCost('deep_veins').aether > researchCost('well_lore').aether);
  assert.ok(researchDurationSeconds('deep_veins') > researchDurationSeconds('well_lore'));
});

test('content: the four producers produce, the well rig scales with band, others do not', () => {
  const levels = new Map<BuildingType, number>([
    ['well_rig', 2],
    ['cloudstone_quarry', 1],
    ['skysteel_forge', 1],
    ['terrace_farm', 1],
    ['watchspire', 5], // no production in phase 1
  ]);
  const shallows = ratesFor(levels, 'shallows');
  const highwind = ratesFor(levels, 'highwind');
  assert.ok(shallows.aether > BASE_RATES.aether);
  // Higher bands yield richer Aether (20-aetherholm.md §2) — and ONLY aether: the multiplier is
  // the well's, and the well holds aether.
  assert.ok(highwind.aether > shallows.aether);
  assert.equal(highwind.cloudstone, shallows.cloudstone);
  assert.equal(highwind.skysteel, shallows.skysteel);
  assert.equal(highwind.provisions, shallows.provisions);
});

test('content: the warehouse caps storage; nothing else does', () => {
  const bare = storageCapFor(new Map());
  const walled = storageCapFor(new Map<BuildingType, number>([['warehouse', 3]]));
  const towered = storageCapFor(new Map<BuildingType, number>([['watchspire', 3]]));
  assert.equal(bare, BASE_STORAGE_CAP);
  assert.ok(walled > bare);
  assert.equal(towered, bare);
});

test('content: an unknown research node refuses a cost rather than inventing one', () => {
  assert.throws(() => researchCost('alchemy'), RangeError);
  assert.throws(() => researchDurationSeconds('alchemy'), RangeError);
});

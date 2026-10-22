import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { parseDemo, loadDemoBuffer, vehicleClass } from '../src/parse.js';
import * as H from './helpers.js';

// two players on opposite teams: p1 (team 1) at (100, 200) spawns at tick 1, p2 (team 2) at (-500, -300)
function sampleDemo(opts) {
  return [
    ...H.serverDetails(opts),
    ...H.playerAdd(1, 'Alpha'), ...H.playerAdd(2, 'Bravo'),
    ...H.playerUpdate(1, { team: 1, alive: true, x: 100, z: 200, kit: 'ru_rifleman' }),
    ...H.playerUpdate(2, { team: 2, alive: true, x: -500, z: -300, kit: 'us_medic' }),
    ...H.tick(), ...H.tick(), ...H.tick(),
    ...H.kill(1, 2, 'ak74'),
    ...H.playerUpdate(2, { alive: false }),
    ...H.tick(),
    ...H.roundEnd(),
  ];
}

test('parses server details and samples living players once per tick', () => {
  const d = parseDemo(H.toArrayBuffer(sampleDemo()));
  assert.equal(d.meta.map, 'black_gold');
  assert.equal(d.meta.mapSize, 4);
  assert.equal(d.meta.versionOk, true);
  assert.equal(d.meta.ticks, 4);
  assert.equal(d.n.players, 3 * 2 + 1); // both alive for 3 ticks, then only p1
  assert.deepEqual([...new Set(d.players.team)].sort(), [1, 2]);
  assert.equal(d.players.x[0], 100); assert.equal(d.players.z[0], 200);
});

test('presence stays exact in player-seconds', () => {
  const d = parseDemo(H.toArrayBuffer(sampleDemo()));
  let seconds = 0;
  for (let i = 0; i < d.n.players; i++) seconds += d.sampleDt[d.players.tick[i]];
  assert.ok(Math.abs(seconds - 7 * 0.48) < 1e-4, `got ${seconds}`);
});

test('short ticks are subsampled without losing time', () => {
  const bytes = [...H.serverDetails(), ...H.playerAdd(1, 'A'), ...H.playerUpdate(1, { team: 1, alive: true, x: 0, z: 0, kit: 'ru_rifleman' }),
    ...Array.from({ length: 10 }, () => H.tick(8)).flat(), ...H.roundEnd()]; // 0.32 s ticks
  const d = parseDemo(H.toArrayBuffer(bytes));
  assert.ok(d.n.players < 10, 'should keep fewer samples than ticks');
  let seconds = 0; for (let i = 0; i < d.n.players; i++) seconds += d.sampleDt[d.players.tick[i]];
  assert.ok(seconds > 2.5 && seconds <= 3.21, `got ${seconds}`);
});

test('records kills with positions, distance and team', () => {
  const d = parseDemo(H.toArrayBuffer(sampleDemo()));
  assert.equal(d.kills.length, 1);
  const k = d.kills[0];
  assert.equal(k.weapon, 'ak74'); assert.equal(k.aTeam, 1); assert.equal(k.vTeam, 2); assert.equal(k.tk, false);
  assert.equal(k.dist, Math.round(Math.hypot(600, 500)));
});

test('age counts seconds since the player spawned', () => {
  const d = parseDemo(H.toArrayBuffer(sampleDemo()));
  assert.ok(d.players.age[0] <= 1);                 // spawned at time 0, first sample after 0.48 s
  assert.ok(d.players.age[d.n.players - 1] >= 1);   // last sample is ~2 s later
});

test('flags demos from another protocol version', () => {
  const d = parseDemo(H.toArrayBuffer(sampleDemo({ version: 4 })));
  assert.equal(d.meta.versionOk, false);
});

test('falls back to the known map size when the demo has none', () => {
  const bytes = sampleDemo({ map: 'korengal', mapSize: 0 });
  const d = parseDemo(H.toArrayBuffer(bytes));
  assert.equal(d.meta.mapSize, 2); // a stored 0 means "unknown" -> default, as the original viewer does
});

test('reads zlib-compressed recordings', async () => {
  const z = deflateSync(Buffer.from(sampleDemo()));
  const d = await loadDemoBuffer(z.buffer.slice(z.byteOffset, z.byteOffset + z.byteLength));
  assert.equal(d.meta.map, 'black_gold');
});

test('drops an unfinished last message (server crash) instead of failing', () => {
  const bytes = sampleDemo().slice(0, -3); // cut inside the ROUNDEND message
  const d = parseDemo(H.toArrayBuffer(bytes));
  assert.ok(d.meta.ticks >= 1);
});

test('classifies vehicles from real template names', () => {
  const cases = { ru_tnk_t90: 'tank', ch_apc_wz551: 'apc', ch_ifv_type86: 'apc', ru_atm_spandrel: 'apc', ru_the_mi8: 'heli',
    gb_ahe_apache: 'heli', ru_jet_su27: 'jet', ch_boat: 'boat', us_jep_hmmwv_uparmored: 'light', ru_trk_logistics: 'light',
    deployable_tow: 'static', parachute: 'other', laddercontainer: 'other' };
  for (const [name, cls] of Object.entries(cases)) assert.equal(vehicleClass(name), cls, name);
});

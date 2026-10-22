import test from 'node:test';
import assert from 'node:assert/strict';
import { gridRef, newGrid, splat, blur, GRID } from '../src/heatmap.js';
import { accumulate, defaultFilter } from '../src/analysis.js';
import { parseDemo } from '../src/parse.js';
import * as H from './helpers.js';

// Expected values were read off the grid printed on the real map images (1536 px renders).
const at = (S, u, v) => { const half = 512 * S, k = (1024 * S) / 1536; return gridRef(u * k - half, half - v * k, S); };

test('grid reference matches the labels printed on the map images', () => {
  assert.equal(at(4, 20, 20), 'A1-7');     // top-left corner, keypad 7
  assert.equal(at(4, 1400, 50), 'M1-5');   // "M" label of a 4 km map
  assert.equal(at(1, 1170, 50), 'K1-5');   // "K" label of a 1 km map: squares are 75 m, not 300 m
  assert.equal(at(1, 835, 50), 'H1-5');
  assert.equal(at(2, 700, 650), 'G6-1');   // 2 km map (Muttrah-sized)
});

test('square size scales with the map so there are always ~14 columns', () => {
  assert.equal(gridRef(-512 * 8 + 1, 512 * 8 - 1, 8), 'A1-7');
  assert.match(gridRef(512 * 8 - 1, -512 * 8 + 1, 8), /^N14-/);
});

test('points outside the map are clamped instead of producing garbage', () => {
  assert.equal(gridRef(-99999, 99999, 4), 'A1-7');
});

test('splat conserves weight and blur keeps it', () => {
  const g = newGrid();
  splat(g, 123, -456, 4, 5);
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum(g) - 5) < 1e-4);
  assert.ok(Math.abs(sum(blur(g, 3)) - 5) < 0.05);
  splat(g, 99999, 0, 4, 5); // outside: dropped
  assert.ok(Math.abs(sum(g) - 5) < 1e-4);
});

function demo() {
  const bytes = [...H.serverDetails(), ...H.playerAdd(1, 'A'), ...H.playerAdd(2, 'B'),
    ...H.playerUpdate(1, { team: 1, alive: true, x: 0, z: 0, kit: 'ru_rifleman' }),
    ...H.playerUpdate(2, { team: 2, alive: true, x: 800, z: 800, kit: 'us_medic' }),
    ...Array.from({ length: 20 }, () => H.tick()).flat(), ...H.roundEnd()];
  return parseDemo(H.toArrayBuffer(bytes));
}

test('accumulate honours team, kit and "ignore after respawn" filters', () => {
  const d = demo();
  const total = (g) => g.reduce((s, v) => s + v, 0);
  const all = total(accumulate([d], 'foot', defaultFilter()));
  assert.ok(Math.abs(all - 2 * 20 * 0.48) < 0.01, `got ${all}`);
  assert.ok(Math.abs(total(accumulate([d], 'foot', { ...defaultFilter(), team: 1 })) - all / 2) < 0.01);
  assert.ok(Math.abs(total(accumulate([d], 'foot', { ...defaultFilter(), role: 'medic' })) - all / 2) < 0.01);
  const late = total(accumulate([d], 'foot', { ...defaultFilter(), minAge: 5 }));
  assert.ok(late < all && late > 0, `got ${late}`); // the first ~5 s after spawning are dropped
});

test('time window filters by fraction of the match', () => {
  const d = demo();
  const total = (g) => g.reduce((s, v) => s + v, 0);
  const half = total(accumulate([d], 'foot', { ...defaultFilter(), t0: 0, t1: 0.5 }));
  const all = total(accumulate([d], 'foot', defaultFilter()));
  assert.ok(half > all * 0.4 && half < all * 0.6, `half=${half} all=${all}`);
});

test('grid size constant is what the UI expects', () => { assert.equal(GRID, 512); });

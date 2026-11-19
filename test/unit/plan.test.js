import test from 'node:test';
import assert from 'node:assert/strict';

import { clampInt, mapWithConcurrency, parseRate, planEvenTimestamps, planGridCells, resolveLayout } from '../../lib/plan.js';

test('planEvenTimestamps places one midpoint per slice', () => {
  assert.deepEqual(planEvenTimestamps(0, 8, 4), [1, 3, 5, 7]);
  assert.deepEqual(planEvenTimestamps(10, 20, 2), [12.5, 17.5]);
});

test('planEvenTimestamps stays inside the window and always returns count points', () => {
  const points = planEvenTimestamps(2, 2.1, 3);
  assert.equal(points.length, 3);
  assert.ok(points.every((value) => value >= 2 && value <= 2.1));
});

test('planEvenTimestamps tolerates a zero-width window and a zero count', () => {
  assert.deepEqual(planEvenTimestamps(5, 5, 0), [5]);
});

test('resolveLayout honours an explicit choice and the auto threshold', () => {
  assert.equal(resolveLayout('frames', 20, 5), 'frames');
  assert.equal(resolveLayout('grid', 1, 5), 'grid');
  assert.equal(resolveLayout('auto', 4, 5), 'frames');
  assert.equal(resolveLayout('auto', 5, 5), 'grid');
  assert.equal(resolveLayout('auto', 12, 5), 'grid');
});

test('planGridCells covers every frame and prefers exact fills', () => {
  assert.deepEqual(planGridCells(1), { columns: 1, rows: 1 });
  assert.deepEqual(planGridCells(4), { columns: 2, rows: 2 });
  assert.deepEqual(planGridCells(8), { columns: 4, rows: 2 });
  assert.deepEqual(planGridCells(9), { columns: 3, rows: 3 });
  assert.deepEqual(planGridCells(12), { columns: 4, rows: 3 });
  assert.deepEqual(planGridCells(20), { columns: 5, rows: 4 });
  for (const count of [1, 2, 3, 5, 7, 9, 11, 13, 17, 20, 25]) {
    const { columns, rows } = planGridCells(count);
    assert.ok(columns * rows >= count, `grid for ${count} must fit every cell`);
  }
});

test('clampInt rounds and clamps', () => {
  assert.equal(clampInt(7.6, 1, 5), 5);
  assert.equal(clampInt(-3, 1, 5), 1);
  assert.equal(clampInt('abc', 2, 5), 2);
});

test('parseRate reads ffprobe rationals', () => {
  assert.equal(parseRate('30000/1001'), 29.97);
  assert.equal(parseRate('25/1'), 25);
  assert.equal(parseRate(undefined), undefined);
  assert.equal(parseRate('0/1'), undefined);
});

test('mapWithConcurrency keeps input order and caps in-flight work', async () => {
  let inFlight = 0;
  let peak = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return value * 10;
  });
  assert.deepEqual(result, [10, 20, 30, 40, 50]);
  assert.ok(peak <= 2, `peak in-flight was ${peak}`);
});

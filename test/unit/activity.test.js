import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dedupeByThumbnails,
  detectShotBoundaries,
  median,
  planShotTimestamps,
  thumbnailDistance,
} from '../../lib/activity.js';

const frame = (value) => new Uint8Array(16).fill(value);

test('median handles odd, even and empty lists', () => {
  assert.equal(median([1, 5, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), 0);
});

test('detectShotBoundaries finds spikes above ratio times median', () => {
  const changes = [
    { seconds: 0.5, score: 0.01 },
    { seconds: 1.0, score: 0.01 },
    { seconds: 2.0, score: 0.60 },
    { seconds: 2.5, score: 0.01 },
    { seconds: 4.0, score: 0.55 },
  ];
  assert.deepEqual(detectShotBoundaries(changes, { shotRatio: 3, shotFloor: 0.05, minShotSeconds: 0.5 }), [2, 4]);
});

test('detectShotBoundaries respects the minimum gap', () => {
  const changes = [
    { seconds: 1.0, score: 0.9 },
    { seconds: 1.2, score: 0.9 },
    { seconds: 1.9, score: 0.9 },
  ];
  assert.deepEqual(detectShotBoundaries(changes, { shotRatio: 1, minShotSeconds: 0.5 }), [1, 1.9]);
});

test('detectShotBoundaries returns nothing for a flat clip', () => {
  const changes = Array.from({ length: 10 }, (_, index) => ({ seconds: index * 0.5, score: 0.02 }));
  assert.deepEqual(detectShotBoundaries(changes), []);
});

test('planShotTimestamps places one midpoint per shot and caps the count', () => {
  assert.deepEqual(planShotTimestamps({ boundaries: [2, 4], start: 0, end: 6, count: 10 }), [1, 3, 5]);
  assert.deepEqual(planShotTimestamps({ boundaries: [2, 4], start: 0, end: 6, count: 2 }), [1, 5]);
  assert.deepEqual(planShotTimestamps({ boundaries: [], start: 0, end: 6, count: 10 }), []);
});

test('planShotTimestamps spreads a small budget across many shots instead of taking the first ones', () => {
  const boundaries = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
  const picked = planShotTimestamps({ boundaries, start: 0, end: 60, count: 8 });
  assert.equal(picked.length, 8);
  assert.equal(picked[0], 2.5);
  assert.equal(picked[picked.length - 1], 57.5);
  assert.ok(picked[picked.length - 1] > 50, 'the last shot must be reached, not the eighth shot');
  for (let index = 1; index < picked.length; index += 1) assert.ok(picked[index] > picked[index - 1]);
});

test('planShotTimestamps with a single-frame budget picks a middle shot', () => {
  const picked = planShotTimestamps({ boundaries: [2, 4], start: 0, end: 6, count: 1 });
  assert.deepEqual(picked, [3]);
});

test('thumbnailDistance is 0 for identical frames and 1 for black vs white', () => {
  assert.equal(thumbnailDistance(frame(10), frame(10)), 0);
  assert.equal(thumbnailDistance(frame(0), frame(255)), 1);
});

test('dedupeByThumbnails drops a moment that repeats the previous picture', () => {
  const frames = [frame(0), frame(0), frame(200), frame(200), frame(255)];
  const result = dedupeByThumbnails({
    positions: [0, 0.1, 0.2, 0.3, 0.4],
    frames,
    fps: 10,
    start: 0,
    minDistance: 0.05,
  });
  assert.deepEqual(result.positions, [0, 0.2, 0.4]);
  assert.equal(result.dropped, 2);
});

test('dedupeByThumbnails keeps every moment when no proxy frames exist', () => {
  const result = dedupeByThumbnails({ positions: [1, 2], frames: [], fps: 6, start: 0 });
  assert.deepEqual(result.positions, [1, 2]);
  assert.equal(result.dropped, 0);
});

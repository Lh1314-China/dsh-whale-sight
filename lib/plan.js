/**
 * Pure planning helpers for `watch_video` — no I/O, so they are cheap to unit test.
 * @module dsh-whale-sight/lib/plan
 */

/**
 * Clamp a number to an integer inside a closed range.
 * @param {unknown} value - candidate.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} the clamped integer.
 */
export function clampInt(value, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : min;
  return Math.min(max, Math.max(min, number));
}

/**
 * Place `count` sample points across [start, end], one per equal slice, at the slice midpoint.
 * Midpoints avoid the exact cut at both ends, where a decoder often returns nothing.
 * @param {number} start - window start in seconds.
 * @param {number} end - window end in seconds.
 * @param {number} count - how many points.
 * @returns {number[]} ascending positions in seconds, rounded to milliseconds.
 */
export function planEvenTimestamps(start, end, count) {
  const safeStart = Math.max(0, Number.isFinite(start) ? start : 0);
  const safeEnd = Math.max(safeStart, Number.isFinite(end) ? end : safeStart);
  const n = Math.max(1, Math.round(Number.isFinite(count) ? count : 1));
  const span = safeEnd - safeStart;
  const step = span / n;
  const points = [];
  for (let index = 0; index < n; index += 1) {
    const at = safeStart + step * (index + 0.5);
    points.push(Math.round(at * 1000) / 1000);
  }
  return points;
}

/**
 * Decide how the frames are delivered.
 * @param {'auto'|'grid'|'frames'} requested - caller preference.
 * @param {number} count - how many images the read produces.
 * @param {number} gridWhenAtLeast - config threshold for `auto`.
 * @returns {'grid'|'frames'} the resolved layout.
 */
export function resolveLayout(requested, count, gridWhenAtLeast) {
  if (requested === 'grid' || requested === 'frames') return requested;
  return count >= Math.max(1, gridWhenAtLeast) ? 'grid' : 'frames';
}

/** Preferred shapes by capacity: exact fills first, so a sheet has as few blank cells as possible. */
const GRID_SHAPE = [
  [1, 1], [2, 1], [2, 2], [3, 2], [4, 2], [3, 3], [4, 3], [4, 4], [5, 4],
];

/**
 * Choose a contact-sheet shape that covers `count` cells without leaving many blank ones.
 * @param {number} count - cells to place.
 * @returns {{columns: number, rows: number}} the grid shape.
 */
export function planGridCells(count) {
  const n = Math.max(1, Math.round(Number.isFinite(count) ? count : 1));
  for (const [columns, rows] of GRID_SHAPE) {
    if (columns * rows >= n) return { columns, rows };
  }
  const columns = 5;
  return { columns, rows: Math.ceil(n / columns) };
}

/**
 * Parse an ffprobe frame-rate string such as "30000/1001".
 * @param {string|undefined} rate - the raw rational.
 * @returns {number|undefined} frames per second, rounded to two decimals.
 */
export function parseRate(rate) {
  if (typeof rate !== 'string' || rate === '') return undefined;
  const [numerator, denominator] = rate.split('/').map((part) => Number(part));
  if (!Number.isFinite(numerator) || numerator <= 0) return undefined;
  if (!Number.isFinite(denominator) || denominator <= 0) return undefined;
  return Math.round((numerator / denominator) * 100) / 100;
}

/**
 * Run an async mapper with a small concurrency window, preserving input order.
 * Frame decoding is I/O-bound, so a few ffmpeg processes in flight cut a long
 * storyboard read from seconds to under one.
 * @template T, R
 * @param {T[]} items - inputs.
 * @param {number} limit - maximum in-flight operations.
 * @param {(item: T, index: number) => Promise<R>} operation - per-item work.
 * @returns {Promise<R[]>} results in input order.
 */
export async function mapWithConcurrency(items, limit, operation) {
  const results = new Array(items.length);
  const window = Math.max(1, Math.min(items.length || 1, Math.round(limit)));
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await operation(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: window }, () => worker()));
  return results;
}

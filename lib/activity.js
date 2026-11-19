/**
 * Cheap motion/shape analysis for `watch_video`.
 *
 * A low-resolution grayscale proxy is the cheapest way to answer "where does the picture
 * change" without decoding full frames: 64x36 at ~6 fps is about 14 KB per second of video,
 * and the same proxy doubles as the thumbnail used to drop repeated moments.
 *
 * @module dsh-whale-sight/lib/activity
 */
import { run } from './ffmpeg.js';

/** Proxy frame width used for the activity scan. */
const PROXY_WIDTH = 64;

/** Proxy frame height used for the activity scan. */
const PROXY_HEIGHT = 36;

/**
 * Scan a time window into small grayscale frames and score the change between neighbours.
 * @param {string} ffmpeg - resolved ffmpeg.
 * @param {string} file - absolute media path.
 * @param {{ start?: number, spanSeconds: number, fps?: number, signal?: AbortSignal }} options - window and rate.
 * @returns {Promise<{ frames: Uint8Array[], changes: { seconds: number, score: number }[], fps: number, start: number }>} proxy data.
 */
export async function scanActivity(ffmpeg, file, options) {
  const start = Math.max(0, options.start ?? 0);
  const span = Math.max(0.1, options.spanSeconds);
  const fps = Math.max(1, Math.min(12, Math.round(options.fps ?? 6)));
  const { stdout } = await run(ffmpeg, [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-ss', start.toFixed(3),
    '-t', span.toFixed(3),
    '-i', file,
    '-an', '-sn',
    '-vf', `fps=${fps},scale=${PROXY_WIDTH}:${PROXY_HEIGHT}:flags=fast_bilinear,format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
  ], { signal: options.signal });

  const size = PROXY_WIDTH * PROXY_HEIGHT;
  const frames = [];
  const changes = [];
  let previous;
  for (let offset = 0; offset + size <= stdout.length; offset += size) {
    const frame = stdout.subarray(offset, offset + size);
    frames.push(frame);
    if (previous !== undefined) {
      let sum = 0;
      for (let index = 0; index < size; index += 1) sum += Math.abs(frame[index] - previous[index]);
      changes.push({
        seconds: Math.round((start + (frames.length - 1) / fps) * 1000) / 1000,
        score: Math.round((sum / size / 255) * 10000) / 10000,
      });
    }
    previous = frame;
  }
  return { frames, changes, fps, start };
}

/**
 * Median of a numeric list.
 * @param {number[]} values - input.
 * @returns {number} the median (0 for an empty list).
 */
export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Find cut positions: changes well above the clip's own median, spaced apart.
 * @param {{ seconds: number, score: number }[]} changes - change scores.
 * @param {{ shotRatio?: number, shotFloor?: number, minShotSeconds?: number }} [options] - thresholds.
 * @returns {number[]} boundary positions in seconds.
 */
export function detectShotBoundaries(changes, options = {}) {
  const shotRatio = options.shotRatio ?? 3;
  const shotFloor = options.shotFloor ?? 0.05;
  const minShotSeconds = options.minShotSeconds ?? 0.5;
  if (changes.length === 0) return [];
  const threshold = Math.max(shotFloor, median(changes.map((change) => change.score)) * shotRatio);
  const boundaries = [];
  let last = -Infinity;
  for (const change of changes) {
    if (change.score < threshold) continue;
    if (change.seconds - last < minShotSeconds) continue;
    boundaries.push(change.seconds);
    last = change.seconds;
  }
  return boundaries;
}

/**
 * One representative moment per shot: the midpoint between neighbouring boundaries.
 * When the clip has more shots than the budget, shots are picked at an even stride so
 * the read spreads over the whole clip instead of stopping after the first N shots.
 * @param {{ boundaries: number[], start: number, end: number, count: number }} input - shot layout.
 * @returns {number[]} ascending positions, at most `count`.
 */
export function planShotTimestamps(input) {
  const { boundaries, start, end } = input;
  const count = Math.max(1, Math.round(input.count));
  if (boundaries.length === 0) return [];
  const edges = [start, ...boundaries.filter((value) => value > start && value < end), end];
  const midpoints = [];
  for (let index = 1; index < edges.length; index += 1) {
    const from = edges[index - 1];
    const to = edges[index];
    if (to - from < 0.05) continue;
    midpoints.push(Math.round((from + (to - from) / 2) * 1000) / 1000);
  }
  if (midpoints.length <= count) return midpoints;
  if (count === 1) return [midpoints[Math.floor(midpoints.length / 2)]];
  const picked = [];
  for (let index = 0; index < count; index += 1) {
    const at = Math.round((index * (midpoints.length - 1)) / (count - 1));
    if (picked[picked.length - 1] !== midpoints[at]) picked.push(midpoints[at]);
  }
  return picked;
}

/**
 * Distance between two proxy frames, normalized to 0..1.
 * @param {Uint8Array} a - first frame.
 * @param {Uint8Array} b - second frame.
 * @returns {number} mean absolute difference over 255.
 */
export function thumbnailDistance(a, b) {
  const size = Math.min(a.length, b.length);
  if (size === 0) return 1;
  let sum = 0;
  for (let index = 0; index < size; index += 1) sum += Math.abs(a[index] - b[index]);
  return sum / size / 255;
}

/**
 * Drop moments that repeat the previous kept moment's picture.
 * @param {{ positions: number[], frames: Uint8Array[], fps: number, start: number, minDistance?: number }} input - candidates and proxy frames.
 * @returns {{ positions: number[], dropped: number }} kept positions and the drop count.
 */
export function dedupeByThumbnails(input) {
  const { positions, frames, fps, start } = input;
  const minDistance = input.minDistance ?? 0.02;
  if (frames.length === 0) return { positions: [...positions], dropped: 0 };
  const kept = [];
  let previousFrame;
  for (const position of positions) {
    const index = Math.min(frames.length - 1, Math.max(0, Math.round((position - start) * fps)));
    const frame = frames[index];
    if (previousFrame !== undefined && thumbnailDistance(previousFrame, frame) < minDistance) continue;
    kept.push(position);
    previousFrame = frame;
  }
  return { positions: kept, dropped: positions.length - kept.length };
}

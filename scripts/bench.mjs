/**
 * Measure the real cost of one `watch_video` read, phase by phase.
 * Usage: node scripts/bench.mjs <clip.mp4> [--whisper-cli <exe> --whisper-model <bin>]
 */
import { performance } from 'node:perf_hooks';

import * as mod from '../index.js';
import { composeSheet, grabAudioWav, grabFrame, probeVideo, resolveTools, transcribeWithWhisper } from '../lib/ffmpeg.js';
import { dedupeByThumbnails, detectShotBoundaries, planShotTimestamps, scanActivity } from '../lib/activity.js';
import { planEvenTimestamps, planGridCells } from '../lib/plan.js';

const clip = process.argv[2];
if (clip === undefined) {
  console.error('usage: node scripts/bench.mjs <clip.mp4> [--whisper-cli <exe> --whisper-model <bin>]');
  process.exit(2);
}
const args = process.argv.slice(3);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const whisperCli = option('--whisper-cli');
const whisperModel = option('--whisper-model');

const time = async (label, operation) => {
  const started = performance.now();
  const value = await operation();
  const elapsed = performance.now() - started;
  console.log(`${String(Math.round(elapsed)).padStart(6)} ms  ${label}`);
  return value;
};

const { ffmpeg, ffprobe } = await resolveTools({});
const media = await time('probe (ffprobe)', () => probeVideo(ffprobe, clip, undefined));
console.log(`        -> ${media.durationSeconds}s, ${media.width}x${media.height}, ${media.audioCodec ?? 'no audio'}`);

const scan = await time(`activity scan (1/8 scale, ${media.durationSeconds}s)`, () => scanActivity(ffmpeg, clip, { start: 0, spanSeconds: media.durationSeconds, fps: 6 }));
const boundaries = detectShotBoundaries(scan.changes);
console.log(`        -> ${scan.frames.length} proxy frames, ${boundaries.length} cuts`);

const count = 8;
let positions = planShotTimestamps({ boundaries, start: 0, end: media.durationSeconds, count });
if (positions.length < 2) positions = planEvenTimestamps(0, media.durationSeconds, count);
const deduped = dedupeByThumbnails({ positions, frames: scan.frames, fps: scan.fps, start: 0 });
positions = deduped.positions;
console.log(`        -> ${positions.length} moments (${deduped.dropped} deduped)`);

const cells = await time(`grab ${positions.length} cells @320px`, async () => {
  const out = [];
  for (const seconds of positions) {
    out.push(await grabFrame(ffmpeg, clip, seconds, { width: 320, quality: 4, label: `#${out.length + 1} ${seconds.toFixed(1)}s` }));
  }
  return out;
});
const { columns, rows } = planGridCells(cells.length);
const sheet = await time(`compose sheet ${columns}x${rows}`, () => composeSheet(ffmpeg, cells, { columns, rows, quality: 4 }));
console.log(`        -> sheet ${sheet.length} bytes`);

if (media.audioCodec !== undefined && whisperCli !== undefined && whisperModel !== undefined) {
  const wav = await time('extract 16k mono wav', () => grabAudioWav(ffmpeg, clip, { start: 0, maxSeconds: 600 }));
  console.log(`        -> wav ${wav.length} bytes`);
  const transcript = await time('whisper.cpp transcript', () => transcribeWithWhisper(whisperCli, whisperModel, wav, { language: 'zh', threads: 4 }));
  console.log(`        -> ${JSON.stringify(transcript.text.slice(0, 60))}`);
}

// Full tool path with the same code the host runs, attachments mocked to count bytes.
let savedBytes = 0;
const attachments = {
  async saveImage({ data }) {
    savedBytes += data.length;
    return { attachmentId: `sha256:bench-${savedBytes}`, mediaType: 'image/jpeg', bytes: data.length, width: 320, height: 180 };
  },
};
let definition;
mod.apply({
  tools: { register: (def) => { definition = def; return () => {}; } },
  get: (name) => (name === 'attachments' ? attachments : undefined),
}, { defaultFrames: 8 });

for (const transcript of [false, true]) {
  savedBytes = 0;
  const started = performance.now();
  const value = await definition.execute({ path: clip, layout: 'grid', transcript }, { signal: undefined });
  const elapsed = performance.now() - started;
  const blocks = definition.output.render({ path: clip, layout: 'grid', transcript }, value);
  const textChars = blocks.filter((block) => block.type === 'text').reduce((sum, block) => sum + block.text.length, 0);
  console.log(`${String(Math.round(elapsed)).padStart(6)} ms  full read (transcript=${transcript}) -> ${value.sampling.layout}, ${blocks.filter((b) => b.type === 'image').length} image, ${textChars} text chars, ${savedBytes} image bytes`);
  console.log(`        coverage ${JSON.stringify(value.coverage)} moments ${value.frames.map((frame) => frame.seconds).join(', ')}`);
}

/**
 * Local check without DSH: probe a clip, grab labelled cells, compose the sheet,
 * and write everything into a directory so a human (or the model) can look at it.
 *
 * Usage: node scripts/local-check.mjs <clip.mp4> <outDir>
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { composeSheet, grabFrame, probeVideo, resolveTools } from '../lib/ffmpeg.js';
import { planEvenTimestamps, planGridCells, resolveLayout } from '../lib/plan.js';

const clip = process.argv[2];
const outDir = process.argv[3];
if (clip === undefined || outDir === undefined) {
  console.error('usage: node scripts/local-check.mjs <clip.mp4> <outDir>');
  process.exit(2);
}

const config = { ffmpegPath: '', ffprobePath: '' };
const { ffmpeg, ffprobe } = await resolveTools(config);
console.log('ffmpeg =', ffmpeg);
console.log('ffprobe =', ffprobe);

const media = await probeVideo(ffprobe, clip, undefined);
console.log('media =', JSON.stringify(media));

const positions = planEvenTimestamps(0, media.durationSeconds ?? 6, 8);
const layout = resolveLayout('auto', positions.length, 5);
console.log('positions =', positions.join(', '), 'layout =', layout);

await mkdir(outDir, { recursive: true });
const cells = [];
for (const [index, seconds] of positions.entries()) {
  const bytes = await grabFrame(ffmpeg, clip, seconds, {
    width: 320,
    quality: 4,
    label: `#${index + 1} ${seconds.toFixed(1)}s`,
  });
  cells.push(bytes);
  await writeFile(join(outDir, `cell-${String(index + 1).padStart(2, '0')}.jpg`), bytes);
  console.log(`cell ${index + 1} @ ${seconds}s -> ${bytes.length} bytes`);
}

const { columns, rows } = planGridCells(cells.length);
const sheet = await composeSheet(ffmpeg, cells, { columns, rows, quality: 4 });
await writeFile(join(outDir, 'sheet.jpg'), sheet);
console.log(`sheet ${columns}x${rows} -> ${sheet.length} bytes at ${join(outDir, 'sheet.jpg')}`);

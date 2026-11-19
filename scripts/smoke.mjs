/**
 * Integration smoke without DSH: register the tool against a mock context, execute it,
 * and render the result. Proves the real execute + render path on a real clip.
 *
 * Usage: node scripts/smoke.mjs <clip.mp4>
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as mod from '../index.js';

const clip = process.argv[2];
if (clip === undefined) {
  console.error('usage: node scripts/smoke.mjs <clip.mp4>');
  process.exit(2);
}

const outDir = join(process.env.TEMP ?? '.', 'dsh-whale-sight-smoke');
await mkdir(outDir, { recursive: true });

let saved = 0;
const attachments = {
  async saveImage({ data, mediaType, name }) {
    saved += 1;
    await writeFile(join(outDir, name ?? `image-${saved}.jpg`), data);
    return { attachmentId: `sha256:mock-${saved}`, mediaType, bytes: data.length, width: 320, height: 180, name };
  },
};

const throwingProvider = process.env.WHALE_MOCK_PROVIDER === 'throw'
  ? {
    snapshot: () => ({ providers: [{ id: 'mock-unprepared' }] }),
    resolve: () => ({}),
    async transcribe() { throw new Error('Prepare the local speech provider before recording'); },
  }
  : undefined;

let definition;
const ctx = {
  tools: { register: (def) => { definition = def; return () => {}; } },
  get: (name) => (name === 'attachments' ? attachments : name === 'speechToText' ? throwingProvider : undefined),
};

mod.apply(ctx, {
  defaultFrames: 6,
  gridWhenAtLeast: 5,
  cellWidth: 320,
  ...(process.env.WHALE_WHISPER_CLI === undefined ? {} : { whisperCppPath: process.env.WHALE_WHISPER_CLI }),
  ...(process.env.WHALE_WHISPER_MODEL === undefined ? {} : { whisperModelPath: process.env.WHALE_WHISPER_MODEL }),
  ...(process.env.WHALE_YTDLP === undefined ? {} : { ytdlpPath: process.env.WHALE_YTDLP }),
  ...(process.env.WHALE_DOWNLOAD_DIR === undefined ? {} : { downloadDir: process.env.WHALE_DOWNLOAD_DIR }),
  ...(process.env.WHALE_PYTHON === undefined ? {} : { pythonPath: process.env.WHALE_PYTHON }),
  ...(process.env.WHALE_TAGGER === undefined ? {} : { audioTaggerPath: process.env.WHALE_TAGGER }),
  ...(process.env.WHALE_BILI_COOKIE_FILE === undefined ? {} : { bilibiliCookieFile: process.env.WHALE_BILI_COOKIE_FILE }),
});
console.log('tool =', definition?.name, '| required =', JSON.stringify(definition?.parameters.required));

const ALLOWED = {
  root: new Set(['source', 'media', 'sampling', 'frames', 'grid', 'coverage', 'subtitles', 'subtitleNote', 'transcript', 'transcriptNote', 'audioEvents', 'audioEventsNote', 'warnings']),
  source: new Set(['path', 'url']),
  media: new Set(['durationSeconds', 'width', 'height', 'fps', 'videoCodec', 'audioCodec']),
  sampling: new Set(['strategy', 'requested', 'delivered', 'layout', 'shots', 'dropped']),
  frame: new Set(['index', 'seconds', 'attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name']),
  grid: new Set(['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name', 'columns', 'rows']),
  coverage: new Set(['start', 'end', 'firstSample', 'lastSample', 'maxGapSeconds']),
  subtitles: new Set(['source', 'language', 'cueCount', 'chars', 'truncated', 'text']),
  transcript: new Set(['text', 'language', 'audioSeconds', 'source']),
  audioEvents: new Set(['model', 'windows']),
};

/**
 * Refuse any object key the declared output schema does not allow.
 * @param {Record<string, any>} value - the tool result.
 * @returns {string[]} violations, empty when the shape is legal.
 */
function schemaViolations(value) {
  const violations = [];
  const check = (scope, object) => {
    const allowed = ALLOWED[scope];
    if (object === undefined) return;
    for (const key of Object.keys(object)) if (!allowed.has(key)) violations.push(`${scope}.${key}`);
  };
  check('root', value);
  check('source', value.source);
  check('media', value.media);
  check('sampling', value.sampling);
  check('coverage', value.coverage);
  check('grid', value.grid);
  check('subtitles', value.subtitles);
  check('transcript', value.transcript);
  for (const frame of value.frames ?? []) check('frame', frame);
  return violations;
}

/**
 * Walk a value the way the host does: every leaf must survive a lossless JSON round trip.
 * An `undefined` anywhere makes the host reject the result as "not lossless JSON".
 * @param {unknown} value - candidate.
 * @param {string} trail - path for the report.
 * @returns {string[]} paths that hold undefined.
 */
function undefinedPaths(value, trail = 'value') {
  if (value === undefined) return [trail];
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => undefinedPaths(item, `${trail}[${index}]`));
  return Object.entries(value).flatMap(([key, item]) => undefinedPaths(item, `${trail}.${key}`));
}

const noTranscript = process.argv.includes('--no-transcript');

for (const layout of ['auto', 'frames']) {
  const callArgs = { path: clip, layout, ...(noTranscript ? { transcript: false } : {}) };
  const value = await definition.execute(callArgs, { signal: undefined });
  const violations = schemaViolations(value);
  if (violations.length > 0) throw new Error(`schema violations: ${violations.join(', ')}`);
  const lossy = undefinedPaths(value);
  if (lossy.length > 0) throw new Error(`value is not lossless JSON: ${lossy.join(', ')}`);
  const blocks = definition.output.render({ path: clip, layout }, value);
  console.log(`\nlayout=${layout}: strategy=${value.sampling.strategy} delivered=${value.sampling.delivered}`
    + ` layout=${value.sampling.layout} grid=${value.grid === undefined ? '-' : `${value.grid.columns}x${value.grid.rows}`}`
    + ` coverage=${value.coverage.start}-${value.coverage.end} gap=${value.coverage.maxGapSeconds}`);
  console.log('blocks =', blocks.map((block) => block.type).join(','));
  const images = blocks.filter((block) => block.type === 'image');
  console.log('image blocks =', images.length, '| first text =', blocks[0].text.split('\n').slice(0, 3).join(' / '));
  const tail = blocks[blocks.length - 1].text;
  const subtitleLine = /<subtitles[^>]*>[\s\S]{0,120}/.exec(tail);
  const transcriptLine = /<transcript[^>]*>[\s\S]{0,80}/.exec(tail);
  console.log('subtitles =', subtitleLine === null ? '-' : subtitleLine[0].replaceAll('\n', ' | '));
  console.log('transcript =', transcriptLine === null ? '-' : transcriptLine[0].replaceAll('\n', ' | '));
}

console.log(`\nsaved images = ${saved} in ${outDir}`);

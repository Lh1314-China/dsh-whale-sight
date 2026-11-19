import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAudioEvents, renderAudioEvents } from '../../lib/audio-events.js';

const SAMPLE = JSON.stringify({
  model: 'MIT/ast-finetuned-audioset-10-10-0.4593',
  windows: [
    { start: 0, end: 10, events: [{ label: 'Speech', score: 0.87 }, { label: 'Noise', score: 0.04 }] },
    { start: 10, end: 20, events: [{ label: 'Laughter', score: 0.62 }, { label: 'Music', score: 0.31 }] },
  ],
});

test('parseAudioEvents reads the tagger payload', () => {
  const parsed = parseAudioEvents(SAMPLE);
  assert.equal(parsed.model, 'MIT/ast-finetuned-audioset-10-10-0.4593');
  assert.equal(parsed.windows.length, 2);
  assert.equal(parsed.windows[1].events[0].label, 'Laughter');
});

test('parseAudioEvents rejects empty or malformed output', () => {
  assert.throws(() => parseAudioEvents(''), /printed nothing/);
  assert.throws(() => parseAudioEvents('not json'), /invalid JSON/);
  assert.throws(() => parseAudioEvents('{"windows":[{"start":0}]}'), /malformed window/);
  assert.throws(() => parseAudioEvents('{"windows":[]}'), /no windows|malformed/);
});

test('renderAudioEvents keeps confident labels and drops noise', () => {
  const lines = renderAudioEvents(parseAudioEvents(SAMPLE));
  assert.deepEqual(lines, ['0.0-10.0s: Speech 0.87', '10.0-20.0s: Laughter 0.62, Music 0.31']);
});

test('renderAudioEvents honors minScore and maxLabels', () => {
  const lines = renderAudioEvents(parseAudioEvents(SAMPLE), { minScore: 0.5, maxLabels: 1 });
  assert.deepEqual(lines, ['0.0-10.0s: Speech 0.87', '10.0-20.0s: Laughter 0.62']);
  const none = renderAudioEvents(parseAudioEvents(SAMPLE), { minScore: 0.99 });
  assert.deepEqual(none, []);
});

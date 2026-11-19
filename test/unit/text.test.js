import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCues, parseTimeline, renderCues, timeLabel } from '../../lib/text.js';

test('parseTimeline reads SRT and VTT timelines', () => {
  assert.deepEqual(parseTimeline('00:00:01,500 --> 00:00:03,250'), { start: 1.5, end: 3.25 });
  assert.deepEqual(parseTimeline('00:01:02.000 --> 00:01:04.500'), { start: 62, end: 64.5 });
  assert.equal(parseTimeline('not a timeline'), undefined);
});

test('parseCues reads an SRT block list', () => {
  const srt = [
    '1',
    '00:00:00,000 --> 00:00:02,000',
    '第一句',
    '',
    '2',
    '00:00:02,500 --> 00:00:04,000',
    '第二句',
    '',
  ].join('\n');
  assert.deepEqual(parseCues(srt), [
    { start: 0, end: 2, text: '第一句' },
    { start: 2.5, end: 4, text: '第二句' },
  ]);
});

test('parseCues reads WebVTT and strips tags', () => {
  const vtt = ['WEBVTT', '', '00:00:01.000 --> 00:00:02.000', '<v 主持人>你好</v>', ''].join('\n');
  assert.deepEqual(parseCues(vtt), [{ start: 1, end: 2, text: '你好' }]);
});

test('parseCues tolerates an SRT that omits the blank line before the next index', () => {
  const srt = [
    '1',
    '00:00:00,000 --> 00:00:01,000',
    '第一句',
    '2',
    '00:00:01,500 --> 00:00:02,500',
    '第二句',
  ].join('\n');
  assert.deepEqual(parseCues(srt), [
    { start: 0, end: 1, text: '第一句' },
    { start: 1.5, end: 2.5, text: '第二句' },
  ]);
});

test('timeLabel formats minutes and tenths', () => {
  assert.equal(timeLabel(0), '0:00.0');
  assert.equal(timeLabel(9.25), '0:09.3');
  assert.equal(timeLabel(75), '1:15.0');
});

test('renderCues keeps time markers and stops at the character budget', () => {
  const cues = Array.from({ length: 30 }, (_, index) => ({
    start: index * 2,
    end: index * 2 + 1.5,
    text: `第 ${index + 1} 句`,
  }));
  const rendered = renderCues(cues, { maxChars: 400 });
  assert.ok(rendered.truncated);
  assert.ok(rendered.chars <= 400);
  assert.ok(rendered.text.startsWith('[0:00.0-0:01.5] 第 1 句'));
  assert.equal(rendered.cueCount, 30);
});

test('renderCues returns an empty text for no cues', () => {
  const rendered = renderCues([], { maxChars: 1000 });
  assert.equal(rendered.text, '');
  assert.equal(rendered.cueCount, 0);
  assert.equal(rendered.truncated, false);
});

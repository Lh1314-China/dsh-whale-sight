import test from 'node:test';
import assert from 'node:assert/strict';

import { declaredContentLength, isUsableMedia, partPath } from '../../lib/cache.js';

test('partPath keeps the final name and adds a suffix', () => {
  assert.equal(partPath('D:\\videos\\BV1.mp4'), 'D:\\videos\\BV1.mp4.part');
});

test('isUsableMedia accepts a probed video and rejects half-written files', () => {
  assert.equal(isUsableMedia({ videoCodec: 'h264', durationSeconds: 42.3, width: 1280 }), true);
  assert.equal(isUsableMedia({ videoCodec: 'h264', durationSeconds: 0 }), false);
  assert.equal(isUsableMedia({ videoCodec: 'h264', durationSeconds: 0.2 }), false);
  assert.equal(isUsableMedia({ durationSeconds: 42 }), false);
  assert.equal(isUsableMedia({ videoCodec: '', durationSeconds: 42 }), false);
  assert.equal(isUsableMedia(undefined), false);
  assert.equal(isUsableMedia(null), false);
});

test('declaredContentLength reads the final response block', () => {
  const headers = [
    'HTTP/1.1 302 Found',
    'location: https://cdn.example/a.m4s',
    'content-length: 0',
    '',
    'HTTP/1.1 200 OK',
    'content-type: video/mp4',
    'content-length: 67108864',
    '',
  ].join('\r\n');
  assert.equal(declaredContentLength(headers), 67108864);
});

test('declaredContentLength skips encoded responses and missing headers', () => {
  const gzip = ['HTTP/1.1 200 OK', 'content-encoding: gzip', 'content-length: 100', ''].join('\r\n');
  assert.equal(declaredContentLength(gzip), undefined);
  assert.equal(declaredContentLength('HTTP/1.1 200 OK\r\n\r\n'), undefined);
  assert.equal(declaredContentLength(''), undefined);
});

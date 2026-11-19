import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  buildPlayurlUrl,
  bvidFromUrl,
  mixinKey,
  parseView,
  pickStreams,
  signQuery,
} from '../../lib/bilibili.js';

test('bvidFromUrl reads a BV id out of a page URL', () => {
  assert.equal(bvidFromUrl('https://www.bilibili.com/video/BV1uasu6zE4X/'), 'BV1uasu6zE4X');
  assert.equal(bvidFromUrl('https://www.bilibili.com/video/BV13L411T74Z?p=1'), 'BV13L411T74Z');
  assert.equal(bvidFromUrl('https://b23.tv/abc'), undefined);
});

test('mixinKey is 32 characters and deterministic', () => {
  const img = '7cd084941338484aae1ad9425b84077c';
  const sub = '4932caff0ff746eab6f01bf08b70ac45';
  const key = mixinKey(img, sub);
  assert.equal(key.length, 32);
  assert.equal(key, mixinKey(img, sub));
  assert.notEqual(key, mixinKey(sub, img));
});

test('signQuery sorts keys, appends wts, and signs query plus mixin', () => {
  const mixin = 'abcdefghijklmnopqrstuvwxyz012345';
  const at = 1_700_000_000_000;
  const query = signQuery({ bvid: 'BV1', cid: 42, qn: 64 }, mixin, at);
  const [body, wRid] = query.split('&w_rid=');
  assert.ok(body.startsWith('bvid=BV1&cid=42&qn=64&wts=1700000000'));
  const expected = createHash('md5').update(body + mixin).digest('hex');
  assert.equal(wRid, expected);
  assert.equal(wRid.length, 32);
});

test('signQuery drops the characters the WBI filter removes', () => {
  const query = signQuery({ keyword: "a b(c)'!" }, 'x'.repeat(32), 0);
  assert.ok(query.startsWith('keyword=a%20bc&wts=0'));
});

test('parseView rejects API errors and reads the facts', () => {
  assert.throws(() => parseView({ code: -404, message: '啥都木有' }), /bilibili view failed/);
  const facts = parseView({ code: 0, data: { bvid: 'BV1abc', cid: 123, title: '标题', duration: 60 } });
  assert.deepEqual(facts, { bvid: 'BV1abc', cid: 123, title: '标题', durationSeconds: 60 });
});

test('pickStreams caps the height and takes the best audio', () => {
  const dash = {
    video: [
      { id: 80, height: 1080, baseUrl: 'https://v/1080' },
      { id: 64, height: 720, baseUrl: 'https://v/720' },
      { id: 32, height: 480, baseUrl: 'https://v/480' },
    ],
    audio: [
      { id: 30216, bandwidth: 66000, baseUrl: 'https://a/low' },
      { id: 30280, bandwidth: 127000, baseUrl: 'https://a/high' },
    ],
  };
  assert.deepEqual(pickStreams(dash, { maxHeight: 720 }), {
    videoUrl: 'https://v/720',
    audioUrl: 'https://a/high',
    height: 720,
    qualityId: 64,
  });
  assert.equal(pickStreams(dash, { maxHeight: 480 }).videoUrl, 'https://v/480');
  assert.equal(pickStreams(dash).audioUrl, 'https://a/high');
});

test('pickStreams refuses an empty payload', () => {
  assert.throws(() => pickStreams({}), /no video streams/);
});

test('buildPlayurlUrl signs the playurl endpoint', () => {
  const url = buildPlayurlUrl({ bvid: 'BV1', cid: 9, maxHeight: 720 }, 'k'.repeat(32), 1_700_000_000_000);
  assert.ok(url.startsWith('https://api.bilibili.com/x/player/wbi/playurl?'));
  assert.ok(url.includes('bvid=BV1'));
  assert.ok(url.includes('cid=9'));
  assert.ok(url.includes('fnval=16'));
  assert.ok(/w_rid=[0-9a-f]{32}/.test(url));
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { cookieFromCredential } from '../../lib/bilibili.js';

test('cookieFromCredential reads the lowercase credential file', () => {
  const raw = JSON.stringify({
    sessdata: 'abc%2C123',
    bili_jct: 'jct',
    buvid3: 'buvid',
    dedeuserid: '42',
  });
  const cookie = cookieFromCredential(raw);
  assert.equal(cookie, 'SESSDATA=abc%2C123; bili_jct=jct; buvid3=buvid; DedeUserID=42');
});

test('cookieFromCredential accepts an already built cookie header', () => {
  assert.equal(cookieFromCredential('SESSDATA=x; bili_jct=y'), 'SESSDATA=x; bili_jct=y');
});

test('cookieFromCredential refuses empty or SESSDATA-less input', () => {
  assert.throws(() => cookieFromCredential(''), /empty/);
  assert.throws(() => cookieFromCredential('{"bili_jct":"only"}'), /no SESSDATA/);
  assert.throws(() => cookieFromCredential('bili_jct=only'), /no SESSDATA/);
  assert.throws(() => cookieFromCredential('{not json'), /not valid JSON/);
});

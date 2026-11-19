import test from 'node:test';
import assert from 'node:assert/strict';

import { buildYtdlpArgs, hostOf, isAllowedHost, isHttpUrl, parseDownloadedPath } from '../../lib/source.js';

test('isHttpUrl separates links from local paths', () => {
  assert.equal(isHttpUrl('https://www.bilibili.com/video/BV1uasu6zE4X'), true);
  assert.equal(isHttpUrl('HTTP://example.com/a.mp4'), true);
  assert.equal(isHttpUrl('D:\\videos\\a.mp4'), false);
  assert.equal(isHttpUrl('./clips/a.mp4'), false);
  assert.equal(isHttpUrl(undefined), false);
});

test('hostOf lowercases the hostname and rejects garbage', () => {
  assert.equal(hostOf('https://WWW.BiliBili.com/video/BV1'), 'www.bilibili.com');
  assert.equal(hostOf('not a url'), undefined);
});

test('isAllowedHost matches the domain and its subdomains only', () => {
  const domains = ['bilibili.com', 'b23.tv'];
  assert.equal(isAllowedHost('bilibili.com', domains), true);
  assert.equal(isAllowedHost('www.bilibili.com', domains), true);
  assert.equal(isAllowedHost('b23.tv', domains), true);
  assert.equal(isAllowedHost('evilbilibili.com', domains), false);
  assert.equal(isAllowedHost('bilibili.com.evil.tld', domains), false);
});

test('buildYtdlpArgs keeps arguments as an array and ends with the URL', () => {
  const args = buildYtdlpArgs({
    url: 'https://www.bilibili.com/video/BV1uasu6zE4X',
    outputDir: 'D:\\Videos\\cache',
    maxHeight: 720,
    maxMB: 1024,
    proxy: '',
    cookiesFromBrowser: '',
  });
  assert.ok(args.includes('--print'));
  assert.ok(args.includes('after_move:filepath'));
  assert.ok(args.includes('--max-filesize'));
  assert.ok(args.includes('1024M'));
  assert.ok(args.includes('--proxy'));
  assert.equal(args[args.length - 1], 'https://www.bilibili.com/video/BV1uasu6zE4X');
  assert.ok(args.some((value) => value.includes('%(id)s.%(ext)s')));
});

test('buildYtdlpArgs adds cookies only when configured', () => {
  const without = buildYtdlpArgs({ url: 'https://b23.tv/x', outputDir: 'C:\\tmp' });
  assert.equal(without.includes('--cookies-from-browser'), false);
  const withCookies = buildYtdlpArgs({ url: 'https://b23.tv/x', outputDir: 'C:\\tmp', cookiesFromBrowser: 'edge' });
  assert.ok(withCookies.includes('--cookies-from-browser'));
  assert.ok(withCookies.includes('edge'));
});

test('parseDownloadedPath returns the last absolute path and ignores log lines', () => {
  const stdout = [
    '[download] 100% of 19.71MiB',
    '[Merger] Merging formats into "D:\\Videos\\cache\\BV1uasu6zE4X.mp4"',
    'D:\\Videos\\cache\\BV1uasu6zE4X.mp4',
    '',
  ].join('\n');
  assert.equal(parseDownloadedPath(stdout), 'D:\\Videos\\cache\\BV1uasu6zE4X.mp4');
  assert.equal(parseDownloadedPath('[info] nothing here'), undefined);
});

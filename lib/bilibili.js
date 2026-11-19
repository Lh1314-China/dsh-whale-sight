/**
 * Bilibili API helpers for `watch_video`'s URL path.
 *
 * The machine this runs on has a TLS middlebox that resets OpenSSL clients toward
 * bilibili.com (curl's schannel works), so the network calls themselves are made by
 * spawning curl; this module only does the pure parts: WBI request signing, choosing
 * the stream to download, and reading the API payloads.
 *
 * @module dsh-whale-sight/lib/bilibili
 */
import { createHash } from 'node:crypto';

/** The fixed character order used to derive the WBI mixin key. */
export const MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
  29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/** Quality ids that mean a known height; used to cap a download. */
const QUALITY_HEIGHT = { 16: 360, 32: 480, 64: 720, 74: 720, 80: 1080, 112: 1080, 116: 1080, 120: 2160 };

/**
 * Turn a bilibili credential file (or a ready cookie string) into a Cookie header.
 * @param {string} raw - JSON credential (lowercase keys) or a cookie header.
 * @returns {string} `SESSDATA=…; …`.
 */
export function cookieFromCredential(raw) {
  const text = String(raw).trim();
  if (text === '') throw new Error('the bilibili credential is empty');
  if (!text.startsWith('{')) {
    if (!/(^|;\s*)SESSDATA=/i.test(text)) throw new Error('the cookie string has no SESSDATA');
    return text;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('the bilibili credential file is not valid JSON');
  }
  const wanted = [
    ['sessdata', 'SESSDATA'],
    ['bili_jct', 'bili_jct'],
    ['buvid3', 'buvid3'],
    ['dedeuserid', 'DedeUserID'],
  ];
  const parts = [];
  for (const [key, name] of wanted) {
    const value = data[key] ?? data[name];
    if (typeof value === 'string' && value !== '') parts.push(`${name}=${value}`);
  }
  if (!parts.some((part) => part.startsWith('SESSDATA='))) throw new Error('the bilibili credential file has no SESSDATA');
  return parts.join('; ');
}

/**
 * Extract the bvid from a bilibili video URL.
 * @param {string} url - any bilibili page or short link already resolved.
 * @returns {string|undefined} the BV id, when present.
 */
export function bvidFromUrl(url) {
  const match = /\/video\/(BV[0-9A-Za-z]{10})/i.exec(String(url));
  return match === null ? undefined : match[1];
}

/**
 * Derive the WBI mixin key from the two keys the nav endpoint advertises.
 * @param {string} imgKey - img_url file stem.
 * @param {string} subKey - sub_url file stem.
 * @returns {string} 32-character mixin key.
 */
export function mixinKey(imgKey, subKey) {
  const raw = String(imgKey) + String(subKey);
  return MIXIN_TABLE.map((index) => raw[index] ?? '').join('').slice(0, 32);
}

/**
 * Encode one query value the way the signed endpoint expects.
 * @param {string} value - raw value.
 * @returns {string} percent-encoded value.
 */
function encodeValue(value) {
  return encodeURIComponent(String(value).replace(/[!'()*]/g, ''));
}

/**
 * Sort parameters by name, append `wts`, and sign with the WBI mixin key.
 * @param {Record<string, string|number>} params - endpoint parameters.
 * @param {string} mixin - WBI mixin key.
 * @param {number} [nowMs] - clock, injectable for tests.
 * @returns {string} the signed query string (already includes wts and w_rid).
 */
export function signQuery(params, mixin, nowMs = Date.now()) {
  const wts = Math.floor(nowMs / 1000);
  const entries = [...Object.entries(params), ['wts', String(wts)]]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const query = entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeValue(value)}`).join('&');
  const wRid = createHash('md5').update(query + mixin).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

/**
 * Extract the bvid/cid/title from a `/x/web-interface/view` payload.
 * @param {Record<string, any>} payload - parsed API response.
 * @returns {{ bvid: string, cid: number, title: string, durationSeconds: number }} video facts.
 */
export function parseView(payload) {
  if (payload?.code !== 0 || payload?.data === undefined) {
    throw new Error(`bilibili view failed: code=${payload?.code} ${payload?.message ?? ''}`.trim());
  }
  const data = payload.data;
  return {
    bvid: String(data.bvid),
    cid: Number(data.cid),
    title: typeof data.title === 'string' ? data.title : '',
    durationSeconds: Number(data.duration) || 0,
  };
}

/**
 * Choose one video stream (at or under the height cap) and the best audio stream.
 * @param {Record<string, any>} dash - `data.dash` from the playurl payload.
 * @param {{ maxHeight?: number }} [options] - height cap.
 * @returns {{ videoUrl: string, audioUrl: string|undefined, height: number, qualityId: number }} selected streams.
 */
export function pickStreams(dash, options = {}) {
  const maxHeight = options.maxHeight ?? 720;
  const videos = Array.isArray(dash?.video) ? dash.video : [];
  if (videos.length === 0) throw new Error('bilibili playurl returned no video streams');
  const allowed = videos.filter((stream) => {
    const height = QUALITY_HEIGHT[stream.id] ?? stream.height;
    return typeof height === 'number' && height <= maxHeight;
  });
  const chosen = (allowed.length > 0 ? allowed : videos)
    .slice()
    .sort((left, right) => (QUALITY_HEIGHT[right.id] ?? right.height) - (QUALITY_HEIGHT[left.id] ?? left.height))[0];
  const audio = (Array.isArray(dash?.audio) ? dash.audio : [])
    .slice()
    .sort((left, right) => (right.bandwidth ?? 0) - (left.bandwidth ?? 0))[0];
  return {
    videoUrl: String(chosen.baseUrl ?? chosen.base_url),
    audioUrl: audio === undefined ? undefined : String(audio.baseUrl ?? audio.base_url),
    height: QUALITY_HEIGHT[chosen.id] ?? Number(chosen.height) ?? 0,
    qualityId: Number(chosen.id),
  };
}

/**
 * Build the signed playurl URL.
 * @param {{ bvid: string, cid: number, qn?: number, maxHeight?: number }} input - target video.
 * @param {string} mixin - WBI mixin key.
 * @param {number} [nowMs] - clock, injectable for tests.
 * @returns {string} absolute API URL.
 */
export function buildPlayurlUrl(input, mixin, nowMs = Date.now()) {
  const qn = input.qn ?? 64;
  const query = signQuery({
    bvid: input.bvid,
    cid: input.cid,
    qn,
    fnval: 16,
    fnver: 0,
    fourk: 1,
  }, mixin, nowMs);
  return `https://api.bilibili.com/x/player/wbi/playurl?${query}`;
}

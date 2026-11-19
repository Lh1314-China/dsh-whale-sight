/**
 * URL sources for `watch_video`: validate a link, plan the yt-dlp call, and read back
 * the file path the downloader reports.
 *
 * Pure functions only — the subprocess call lives in index.js so this module can be
 * unit tested without a network or a downloader.
 *
 * @module dsh-whale-sight/lib/source
 */
import { join } from 'node:path';

/** Browser-like user agent shared by every network call in this package. */
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

/**
 * Whether a caller value is an HTTP(S) URL rather than a local path.
 * @param {unknown} value - caller input.
 * @returns {boolean} true for http(s) links.
 */
export function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/**
 * Hostname of a URL, lowercased.
 * @param {string} url - absolute URL.
 * @returns {string|undefined} the host, or undefined when unparseable.
 */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Whether a host is the allowed domain or one of its subdomains.
 * @param {string} host - hostname.
 * @param {string[]} domains - allowed registrable domains.
 * @returns {boolean} true when allowed.
 */
export function isAllowedHost(host, domains) {
  return domains.some((domain) => {
    const allowed = domain.toLowerCase().trim();
    return allowed !== '' && (host === allowed || host.endsWith(`.${allowed}`));
  });
}

/**
 * Build yt-dlp arguments for one video.
 * @param {{ url: string, outputDir: string, maxHeight?: number, maxMB?: number, proxy?: string, cookiesFromBrowser?: string, extraArgs?: string[] }} input - source and policy.
 * @returns {string[]} arguments passed as an array, never a command string.
 */
export function buildYtdlpArgs(input) {
  const maxHeight = input.maxHeight ?? 720;
  const maxMB = input.maxMB ?? 2048;
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--force-ipv4',
    // Bilibili drops connections under bursty request patterns; a small pause and a
    // couple of retries turn a flaky handshake into a normal download.
    '--retries', '3',
    '--fragment-retries', '3',
    '--socket-timeout', '20',
    '--sleep-requests', '1',
    '--print', 'after_move:filepath',
    '-f', `bestvideo[height<=${maxHeight}]+bestaudio/best[height<=${maxHeight}]/best`,
    '--merge-output-format', 'mp4',
    '--max-filesize', `${maxMB}M`,
    '-o', join(input.outputDir, '%(id)s.%(ext)s'),
  ];
  if (input.proxy !== undefined) args.push('--proxy', input.proxy);
  if (typeof input.cookiesFromBrowser === 'string' && input.cookiesFromBrowser.trim() !== '') {
    args.push('--cookies-from-browser', input.cookiesFromBrowser.trim());
  }
  for (const extra of input.extraArgs ?? []) {
    if (typeof extra === 'string' && extra !== '') args.push(extra);
  }
  args.push(input.url);
  return args;
}

/**
 * Read the file path yt-dlp printed after moving the merged file into place.
 * @param {string} stdout - downloader stdout.
 * @returns {string|undefined} the absolute path, or undefined when absent.
 */
export function parseDownloadedPath(stdout) {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].replace(/^"|"$/g, '');
    if (/^[A-Za-z]:[\\/]/.test(line) && /\.[A-Za-z0-9]{2,5}$/.test(line)) return line;
    if (line.startsWith('/') && /\.[A-Za-z0-9]{2,5}$/.test(line)) return line;
  }
  return undefined;
}

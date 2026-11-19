/**
 * Cache helpers for downloaded videos.
 *
 * A download is written to `<target>.part` and only renamed into place after ffmpeg
 * finished, so an interrupted merge can never masquerade as a complete cache entry.
 * Existing cache files are accepted only when ffprobe reports a real video stream.
 *
 * @module dsh-whale-sight/lib/cache
 */

/**
 * Path used while a target file is still being written.
 * @param {string} target - final path.
 * @returns {string} temporary path.
 */
export function partPath(target) {
  return `${target}.part`;
}

/**
 * Whether a media record describes a usable video (not a truncated or empty file).
 * @param {Record<string, any>|undefined} media - ffprobe-derived record.
 * @returns {boolean} true when a video stream and a non-trivial duration exist.
 */
export function isUsableMedia(media) {
  if (media === undefined || media === null || typeof media !== 'object') return false;
  if (typeof media.videoCodec !== 'string' || media.videoCodec === '') return false;
  return typeof media.durationSeconds === 'number' && media.durationSeconds > 0.5;
}

/**
 * Read the last `Content-Length` a curl header dump carries, so a truncated media
 * response can be rejected even when the container still reports a duration.
 * @param {string} headersText - raw `curl -D` output.
 * @returns {number|undefined} declared size in bytes, undefined when absent or encoded.
 */
export function declaredContentLength(headersText) {
  const blocks = String(headersText).split(/\r?\n\r?\n/g).filter((block) => block.trim() !== '');
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    let length;
    let encoded = false;
    for (const line of blocks[index].split(/\r?\n/g).slice(1)) {
      const match = /^content-length:\s*(\d+)\s*$/i.exec(line);
      if (match !== null) length = Number(match[1]);
      if (/^content-encoding:/i.test(line)) encoded = true;
    }
    if (encoded) return undefined;
    if (length !== undefined) return length;
  }
  return undefined;
}

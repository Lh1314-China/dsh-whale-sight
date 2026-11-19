/**
 * Subtitle parsing and rendering for `watch_video`.
 *
 * Subtitle text is the clip's own words, so it is preferred over a speech-to-text guess.
 * Both SRT and WebVTT are parsed into the same cue list; rendering keeps a time marker
 * per cue so a claim can be pinned to a moment.
 *
 * @module dsh-whale-sight/lib/text
 */

/**
 * Parse a `00:00:01,000 --> 00:00:03,500` (SRT) or `00:00:01.000 --> 00:00:03.500` (VTT) line.
 * @param {string} line - timeline line.
 * @returns {{ start: number, end: number }|undefined} seconds.
 */
export function parseTimeline(line) {
  const match = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/.exec(line);
  if (match === null) return undefined;
  const toSeconds = (hours, minutes, seconds, fraction) =>
    Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(`0.${fraction}`);
  return { start: toSeconds(match[1], match[2], match[3], match[4]), end: toSeconds(match[5], match[6], match[7], match[8]) };
}

/**
 * Parse SRT or WebVTT text into cues.
 * @param {string} text - subtitle file contents.
 * @returns {{ start: number, end: number, text: string }[]} cues in file order.
 */
export function parseCues(text) {
  const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const cues = [];
  let index = 0;
  while (index < lines.length) {
    const timeline = parseTimeline(lines[index]);
    if (timeline === undefined) {
      index += 1;
      continue;
    }
    index += 1;
    const body = [];
    while (index < lines.length && lines[index].trim() !== '') {
      if (parseTimeline(lines[index]) !== undefined) break;
      // A bare number right before the next timeline is that cue's index, not dialogue;
      // tolerate files that omit the blank line between cues.
      if (/^\d+$/.test(lines[index].trim()) && parseTimeline(lines[index + 1] ?? '') !== undefined) break;
      body.push(lines[index].trim());
      index += 1;
    }
    const spoken = body.join(' ').replace(/<[^>]+>/g, '').trim();
    if (spoken !== '') cues.push({ start: timeline.start, end: timeline.end, text: spoken });
  }
  return cues;
}

/**
 * Format seconds as `m:ss.t`.
 * @param {number} seconds - position.
 * @returns {string} compact time label.
 */
export function timeLabel(seconds) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}

/**
 * Render cues with time markers, bounded by a character budget.
 * @param {{ start: number, end: number, text: string }[]} cues - parsed cues.
 * @param {{ maxChars: number }} options - soft budget for the rendered text.
 * @returns {{ text: string, cueCount: number, chars: number, truncated: boolean }} rendered text.
 */
export function renderCues(cues, options) {
  const maxChars = Math.max(200, options.maxChars);
  const parts = [];
  let chars = 0;
  let truncated = false;
  for (const cue of cues) {
    const line = `[${timeLabel(cue.start)}-${timeLabel(cue.end)}] ${cue.text}`;
    if (chars + line.length + 2 > maxChars) {
      truncated = true;
      break;
    }
    parts.push(line);
    chars += line.length + 2;
  }
  return { text: parts.join('\n'), cueCount: cues.length, chars, truncated };
}

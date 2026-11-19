/**
 * Parsing and rendering for the optional audio-event tagger.
 *
 * The tagger is a separate Python helper (`scripts/audio-tag.py`) that emits JSON.
 * This module keeps the host-side logic pure so it can be unit tested.
 *
 * @module dsh-whale-sight/lib/audio-events
 */

/**
 * Parse the tagger's stdout into a validated structure.
 * @param {string} stdout - raw stdout from the helper.
 * @returns {{ model: string, windows: Array<{ start: number, end: number, events: Array<{ label: string, score: number }> }> }} parsed events.
 */
export function parseAudioEvents(stdout) {
  const text = String(stdout).trim();
  if (text === '') throw new Error('the audio tagger printed nothing');
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('the audio tagger printed invalid JSON');
  }
  if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.windows)) {
    throw new Error('the audio tagger returned no windows');
  }
  if (payload.windows.length === 0) throw new Error('the audio tagger returned no windows');
  const windows = payload.windows.map((window) => {
    if (typeof window.start !== 'number' || typeof window.end !== 'number' || !Array.isArray(window.events)) {
      throw new Error('the audio tagger returned a malformed window');
    }
    const events = window.events.map((event) => {
      if (typeof event.label !== 'string' || typeof event.score !== 'number') {
        throw new Error('the audio tagger returned a malformed event');
      }
      return { label: event.label, score: event.score };
    });
    return { start: window.start, end: window.end, events };
  });
  return { model: typeof payload.model === 'string' ? payload.model : 'unknown', windows };
}

/**
 * Format the windows as short readable lines, dropping low-confidence labels.
 * @param {{ model: string, windows: Array<{ start: number, end: number, events: Array<{ label: string, score: number }> }> }} parsed - parsed events.
 * @param {{ minScore?: number, maxLabels?: number }} [options] - filtering.
 * @returns {string[]} one line per window that has a confident label.
 */
export function renderAudioEvents(parsed, options = {}) {
  const minScore = options.minScore ?? 0.15;
  const maxLabels = options.maxLabels ?? 3;
  const lines = [];
  for (const window of parsed.windows) {
    const labels = window.events
      .filter((event) => event.score >= minScore)
      .sort((left, right) => right.score - left.score)
      .slice(0, maxLabels)
      .map((event) => `${event.label} ${event.score.toFixed(2)}`);
    if (labels.length === 0) continue;
    lines.push(`${window.start.toFixed(1)}-${window.end.toFixed(1)}s: ${labels.join(', ')}`);
  }
  return lines;
}

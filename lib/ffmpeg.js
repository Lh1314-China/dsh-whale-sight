/**
 * ffmpeg/ffprobe plumbing for `watch_video`: find the executables, read a clip's
 * streams, decode one frame at a timestamp, and stitch frames into one contact sheet.
 *
 * Everything runs as an argument array — never a command string — so paths with
 * spaces or CJK characters cannot be re-split by a shell.
 *
 * @module dsh-whale-sight/lib/ffmpeg
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRate } from './plan.js';

/** Executables already probed in this process, keyed by the candidate string. */
const resolved = new Map();

/**
 * Run one program with an argument array.
 * @param {string} command - executable path or name.
 * @param {string[]} args - arguments, passed verbatim.
 * @param {{ signal?: AbortSignal, env?: NodeJS.ProcessEnv }} [options] - cancellation and extra environment.
 * @returns {Promise<{ stdout: Buffer, stderr: string }>} captured output; rejects on a non-zero exit.
 */
export function run(command, args, options = {}) {
  const { signal, env } = options;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env === undefined ? process.env : env,
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('the read was cancelled'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      const text = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}${text.trim() === '' ? '' : `: ${text.trim().slice(-400)}`}`));
        return;
      }
      resolvePromise({ stdout: Buffer.concat(stdout), stderr: text });
    });
  });
}

/**
 * Check one candidate by asking it for its version.
 * @param {string|undefined} candidate - path or PATH name; empty means skip.
 * @returns {Promise<string|undefined>} the working candidate.
 */
async function probeCandidate(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return undefined;
  const key = candidate.trim();
  if (resolved.has(key)) return resolved.get(key);
  try {
    const { stdout } = await run(key, ['-version']);
    const ok = stdout.length > 0;
    resolved.set(key, ok ? key : undefined);
    return ok ? key : undefined;
  } catch {
    resolved.set(key, undefined);
    return undefined;
  }
}

/**
 * Resolve ffmpeg and ffprobe from config, environment, then PATH.
 * @param {{ ffmpegPath?: string, ffprobePath?: string }} config - plugin config.
 * @returns {Promise<{ ffmpeg: string, ffprobe: string }>} absolute-or-PATH executables.
 */
export async function resolveTools(config) {
  const fromConfig = config.ffmpegPath;
  const fromEnv = process.env.DSH_FFMPEG;
  const candidates = [fromConfig, fromEnv, 'ffmpeg'];
  let ffmpeg;
  for (const candidate of candidates) {
    ffmpeg = await probeCandidate(candidate);
    if (ffmpeg !== undefined) break;
  }
  if (ffmpeg === undefined) {
    throw new Error('ffmpeg was not found: set ffmpegPath in the plugin config, DSH_FFMPEG, or put ffmpeg on PATH');
  }

  const sibling = ffmpeg.toLowerCase().endsWith('ffmpeg.exe')
    ? `${ffmpeg.slice(0, -'ffmpeg.exe'.length)}ffprobe.exe`
    : ffmpeg.toLowerCase().endsWith('ffmpeg')
      ? `${ffmpeg.slice(0, -'ffmpeg'.length)}ffprobe`
      : undefined;
  const probeCandidates = [config.ffprobePath, process.env.DSH_FFPROBE, sibling, 'ffprobe'];
  let ffprobe;
  for (const candidate of probeCandidates) {
    ffprobe = await probeCandidate(candidate);
    if (ffprobe !== undefined) break;
  }
  if (ffprobe === undefined) {
    throw new Error('ffprobe was not found: set ffprobePath in the plugin config, DSH_FFPROBE, or put ffprobe on PATH');
  }
  return { ffmpeg, ffprobe };
}

/**
 * Read the first video stream's shape and the container duration.
 * @param {string} ffprobe - resolved ffprobe.
 * @param {string} file - absolute media path.
 * @param {AbortSignal|undefined} signal - cancellation.
 * @returns {Promise<Record<string, unknown>>} media facts for the result envelope.
 */
export async function probeVideo(ffprobe, file, signal) {
  const { stdout } = await run(ffprobe, [
    '-hide_banner', '-v', 'error',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    file,
  ], { signal });
  let parsed;
  try {
    parsed = JSON.parse(stdout.toString('utf8'));
  } catch (error) {
    throw new Error(`ffprobe returned unreadable JSON for this file (${error instanceof Error ? error.message : String(error)})`);
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video');
  if (video === undefined) throw new Error('this file has no video stream');
  const audio = streams.find((stream) => stream?.codec_type === 'audio');
  const subtitleStreams = streams
    .filter((stream) => stream?.codec_type === 'subtitle')
    .map((stream) => {
      const language = typeof stream.tags?.language === 'string' ? stream.tags.language : undefined;
      return {
        index: Number(stream.index),
        ...(language === undefined ? {} : { language }),
        codec: typeof stream.codec_name === 'string' ? stream.codec_name : 'unknown',
        text: ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'].includes(String(stream.codec_name)),
      };
    });
  const duration = Number(parsed.format?.duration ?? video.duration);
  const durationSeconds = Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) / 1000 : undefined;
  const fps = parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate);
  const audioCodec = typeof audio?.codec_name === 'string' ? audio.codec_name : undefined;
  // Undefined values are dropped rather than returned: the host rejects a tool result
  // that does not survive a lossless JSON round trip, and "no audio track" is the
  // absence of a field, not a null.
  return {
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    width: Number(video.width),
    height: Number(video.height),
    ...(fps === undefined ? {} : { fps }),
    videoCodec: typeof video.codec_name === 'string' ? video.codec_name : 'unknown',
    ...(audioCodec === undefined ? {} : { audioCodec }),
    subtitleStreams,
  };
}

/**
 * Extract one text subtitle stream as SRT.
 * @param {string} ffmpeg - resolved ffmpeg.
 * @param {string} file - absolute media path.
 * @param {number} streamIndex - absolute stream index from ffprobe.
 * @param {AbortSignal|undefined} signal - cancellation.
 * @returns {Promise<string>} SRT text; rejects when the stream is not text or cannot be decoded.
 */
export async function grabSubtitles(ffmpeg, file, streamIndex, signal) {
  const { stdout } = await run(ffmpeg, [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-i', file,
    '-map', `0:${streamIndex}`,
    '-f', 'srt',
    'pipe:1',
  ], { signal });
  const text = stdout.toString('utf8');
  if (text.trim() === '') throw new Error('the subtitle stream came back empty');
  return text;
}

/**
 * Extract a mono 16 kHz WAV of a window, for speech-to-text.
 * @param {string} ffmpeg - resolved ffmpeg.
 * @param {string} file - absolute media path.
 * @param {{ start: number, maxSeconds: number, signal?: AbortSignal }} options - window and cap.
 * @returns {Promise<Buffer>} WAV bytes.
 */
export async function grabAudioWav(ffmpeg, file, options) {
  const start = Math.max(0, options.start);
  const span = Math.max(0.1, options.maxSeconds);
  const { stdout } = await run(ffmpeg, [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-ss', start.toFixed(3),
    '-t', span.toFixed(3),
    '-i', file,
    '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', '16000',
    '-f', 'wav',
    'pipe:1',
  ], { signal: options.signal });
  if (stdout.length <= 44) throw new Error('the audio track came back empty');
  return stdout;
}

/** Windows font used for contact-sheet labels; drawtext needs a real file. */
const LABEL_FONTS = [
  'C:/Windows/Fonts/arial.ttf',
  'C:/Windows/Fonts/segoeui.ttf',
  'C:/Windows/Fonts/msyh.ttc',
];

/**
 * Find a font drawtext can use.
 * @returns {string|undefined} the first existing candidate.
 */
export function findLabelFont() {
  return LABEL_FONTS.find((candidate) => existsSync(candidate));
}

let fontConfigPath;

/**
 * A minimal fontconfig file. Some Windows ffmpeg builds refuse drawtext without one,
 * even when `fontfile` is absolute.
 * @returns {string|undefined} path to the generated config.
 */
function fontConfig() {
  if (fontConfigPath !== undefined) return fontConfigPath === '' ? undefined : fontConfigPath;
  try {
    const directory = join(tmpdir(), 'dsh-whale-sight-fontconfig');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, 'fonts.conf');
    if (!existsSync(file)) {
      writeFileSync(file, '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><dir>C:/Windows/Fonts</dir></fontconfig>\n', 'utf8');
    }
    fontConfigPath = file;
    return file;
  } catch {
    fontConfigPath = '';
    return undefined;
  }
}

/**
 * Escape a font path for a drawtext option value. A Windows drive colon must be
 * escaped twice: once for the option parser and once for the filtergraph parser.
 * @param {string} font - host font path.
 * @returns {string} the escaped path.
 */
function escapeFontPath(font) {
  return font.replaceAll('\\', '/').replaceAll('\\', '\\\\').replaceAll(':', '\\\\:');
}

/**
 * Escape one string for a drawtext filter argument.
 * @param {string} text - label text.
 * @returns {string} filter-safe text.
 */
function escapeDrawtext(text) {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll(':', '\\:')
    .replaceAll('%', '\\%');
}

/**
 * Transcribe a WAV with a local whisper.cpp build (fallback when the host mounts no
 * speech-to-text provider). The CLI prints the text on stdout and timings on stderr.
 * @param {string} cli - whisper-cli executable.
 * @param {string} model - ggml model path.
 * @param {Buffer} wav - 16 kHz mono PCM16 WAV bytes.
 * @param {{ language?: string, threads?: number, tmpDir?: string, signal?: AbortSignal }} options - language, CPU threads, temp root, cancellation.
 * @returns {Promise<{ text: string }>} the transcript.
 */
export async function transcribeWithWhisper(cli, model, wav, options) {
  const root = options.tmpDir !== undefined && options.tmpDir !== '' ? options.tmpDir : tmpdir();
  const directory = await mkdtemp(join(root, 'dsh-whale-sight-whisper-'));
  try {
    const file = join(directory, 'audio.wav');
    await writeFile(file, wav);
    const { stdout } = await run(cli, [
      '-m', model,
      '-f', file,
      '-l', options.language === undefined || options.language === '' ? 'auto' : options.language,
      '-t', String(options.threads ?? 4),
      '-nt',
    ], { signal: options.signal });
    const lines = stdout
      .toString('utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('whisper_') && !line.startsWith('system_info'));
    return { text: lines.join(' ').trim() };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Decode one frame at a timestamp into JPEG bytes.
 * @param {string} ffmpeg - resolved ffmpeg.
 * @param {string} file - absolute media path.
 * @param {number} seconds - seek position.
 * @param {{ width: number, quality: number, label?: string, signal?: AbortSignal }} options - target long edge, quality, burned label, cancellation.
 * @returns {Promise<Buffer>} the encoded frame.
 */
export async function grabFrame(ffmpeg, file, seconds, options) {
  const { width, quality, label, signal } = options;
  const evenWidth = Math.max(2, Math.round(width / 2) * 2);
  const filters = [`scale=${evenWidth}:-2`];
  const env = { ...process.env };
  if (typeof label === 'string' && label !== '') {
    const font = findLabelFont();
    const config = fontConfig();
    if (font !== undefined) {
      if (config !== undefined) env.FONTCONFIG_FILE = config;
      filters.push(
        `drawtext=fontfile=${escapeFontPath(font)}:text='${escapeDrawtext(label)}'`
        + ':x=6:y=6:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4',
      );
    }
  }
  const { stdout } = await run(ffmpeg, [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-ss', seconds.toFixed(3),
    '-i', file,
    '-frames:v', '1',
    '-an', '-sn',
    '-vf', filters.join(','),
    '-q:v', String(quality),
    '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
  ], { signal, env });
  if (stdout.length === 0) throw new Error(`no frame could be decoded at ${seconds.toFixed(2)}s`);
  return stdout;
}

/**
 * Stitch already-decoded cells into one JPEG contact sheet.
 * @param {string} ffmpeg - resolved ffmpeg.
 * @param {Buffer[]} cells - JPEG bytes in reading order.
 * @param {{ columns: number, rows: number, quality: number, signal?: AbortSignal }} options - sheet shape and quality.
 * @returns {Promise<Buffer>} the composed sheet.
 */
export async function composeSheet(ffmpeg, cells, options) {
  const { columns, rows, quality, signal } = options;
  const directory = await mkdtemp(join(tmpdir(), 'dsh-whale-sight-sheet-'));
  try {
    for (const [index, cell] of cells.entries()) {
      await writeFile(join(directory, `frame-${String(index).padStart(3, '0')}.jpg`), cell);
    }
    const { stdout } = await run(ffmpeg, [
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-f', 'image2', '-framerate', '1',
      '-i', join(directory, 'frame-%03d.jpg'),
      '-frames:v', '1',
      '-vf', `tile=${columns}x${rows}:padding=4:margin=4:color=black`,
      '-q:v', String(quality),
      '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ], { signal });
    if (stdout.length === 0) throw new Error('the contact sheet came back empty');
    return stdout;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

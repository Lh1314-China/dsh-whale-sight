/**
 * `watch_video` — video understanding for a text-and-image model.
 *
 * The tool probes a clip with ffprobe, samples frames with ffmpeg, commits each sample
 * as a durable image attachment, and returns them beside a timestamped envelope. The
 * model then sees the clip as a storyboard it can describe and reason about.
 *
 * M1 scope: even spacing, contact sheet or per-frame delivery, honest coverage.
 * Later: shot/sentence-aware sampling, audio track, subtitles.
 *
 * @module dsh-whale-sight
 */
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath, basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { clampInt, mapWithConcurrency, planEvenTimestamps, planGridCells, resolveLayout } from './lib/plan.js';
import { composeSheet, grabAudioWav, grabFrame, grabSubtitles, probeVideo, resolveTools, run, transcribeWithWhisper } from './lib/ffmpeg.js';
import { dedupeByThumbnails, detectShotBoundaries, planShotTimestamps, scanActivity } from './lib/activity.js';
import { parseCues, renderCues } from './lib/text.js';
import { buildYtdlpArgs, hostOf, isAllowedHost, isHttpUrl, parseDownloadedPath, BROWSER_UA } from './lib/source.js';
import { buildPlayurlUrl, bvidFromUrl, cookieFromCredential, mixinKey, parseView, pickStreams } from './lib/bilibili.js';
import { declaredContentLength, isUsableMedia, partPath } from './lib/cache.js';
import { parseAudioEvents, renderAudioEvents } from './lib/audio-events.js';

/** Cordis plugin name, also the id used by this package's patch row. */
export const name = 'whale-sight';

/** The tool registry is the only required service. */
export const inject = ['tools'];

/** Effective defaults for every config field. */
const DEFAULTS = {
  ffmpegPath: '',
  ffprobePath: '',
  defaultFrames: 8,
  maxFrames: 20,
  cellWidth: 320,
  frameWidth: 768,
  jpegQuality: 4,
  gridWhenAtLeast: 5,
  maxSeconds: 1200,
  sampling: 'auto',
  motionFps: 6,
  motionScanMaxSeconds: 600,
  shotRatio: 3,
  shotFloor: 0.05,
  minShotSeconds: 0.5,
  minCellNovelty: 0.02,
  transcript: true,
  subtitles: true,
  language: 'zh',
  maxAudioSeconds: 120,
  maxSubtitleChars: 6000,
  audioDir: '',
  frameConcurrency: 4,
  ytdlpPath: '',
  downloadDir: '',
  maxDownloadHeight: 720,
  maxDownloadMB: 2048,
  downloadTimeoutMs: 600000,
  proxy: '',
  cookiesFromBrowser: '',
  curlPath: 'curl.exe',
  mergeTimeoutMs: 300000,
  // Bilibili login: a cookie string or a credential file (JSON with lowercase keys).
  bilibiliCookie: '',
  bilibiliCookieFile: '',
  bilibiliQuality: 80,
  bilibiliMaxHeight: 1080,
  // Optional audio-event tagging: a Python helper plus its environment.
  audioTaggerPath: '',
  pythonPath: '',
  audioTagWindows: 4,
  audioTagTopK: 3,
  audioTagMinScore: 0.15,
  hfEndpoint: 'https://hf-mirror.com',
  hfHome: '',
  audioTagTmpDir: '',
  allowedDomains: ['bilibili.com', 'b23.tv', 'youtube.com', 'youtu.be'],
  whisperCppPath: '',
  whisperModelPath: '',
  whisperThreads: 4,
};

/**
 * Where downloaded videos are cached. An empty config value falls back to the
 * per-user cache directory, so a fresh install never writes to a fixed path.
 * @param {typeof DEFAULTS} config - effective config.
 * @returns {string} absolute directory.
 */
function resolveDownloadDir(config) {
  if (config.downloadDir) return config.downloadDir;
  return join(process.env.LOCALAPPDATA || tmpdir(), 'dsh-whale-sight', 'cache');
}

/** Model-facing parameters. */
const PARAMETERS = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Local video path, or an http(s) URL to download first (hosts limited by the plugin allowlist). A relative path resolves against the session working directory.',
    },
    frames: {
      type: 'number',
      description: 'How many moments to sample (default from config, capped by maxFrames). Ignored when timestamps are given.',
    },
    timestamps: {
      type: 'array',
      items: { type: 'number' },
      description: 'Explicit sample positions in seconds. Overrides frames; capped at maxFrames.',
    },
    start: {
      type: 'number',
      description: 'Start of the sampling window in seconds; defaults to the beginning.',
    },
    end: {
      type: 'number',
      description: 'End of the sampling window in seconds; defaults to the end of the clip.',
    },
    layout: {
      type: 'string',
      enum: ['auto', 'grid', 'frames'],
      description: 'grid sends one labelled contact sheet (cheap, wide coverage), frames sends each moment as its own image, auto picks grid at or above the configured count.',
    },
    width: {
      type: 'number',
      description: 'Long edge of one sampled image in pixels; defaults to cellWidth for a sheet and frameWidth for separate frames.',
    },
    carry: {
      type: 'string',
      description: 'Summary of the part of the clip already read. Pass the previous summary here when reading a long video in chunks.',
    },
    subtitles: {
      type: 'boolean',
      description: 'Include subtitle text the file already carries (an embedded track or a .srt/.vtt file beside it). Defaults to the plugin config.',
    },
    transcript: {
      type: 'boolean',
      description: 'Ask the mounted speech-to-text provider to transcribe the audio track. Defaults to the plugin config.',
    },
    language: {
      type: 'string',
      description: 'Language hint for the transcript and for choosing among subtitle tracks, such as zh or en.',
    },
  },
  required: ['path'],
};

/** Structured result schema: validated before rendering. */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['path'],
    },
    media: {
      type: 'object',
      additionalProperties: false,
      properties: {
        durationSeconds: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        fps: { type: 'number' },
        videoCodec: { type: 'string' },
        audioCodec: { type: 'string' },
      },
      required: ['width', 'height', 'videoCodec'],
    },
    sampling: {
      type: 'object',
      additionalProperties: false,
      properties: {
        strategy: { type: 'string' },
        requested: { type: 'number' },
        delivered: { type: 'number' },
        layout: { type: 'string' },
        shots: { type: 'number' },
        dropped: { type: 'number' },
      },
      required: ['strategy', 'delivered', 'layout'],
    },
    frames: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'number' },
          seconds: { type: 'number' },
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          bytes: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          name: { type: 'string' },
        },
        required: ['index', 'seconds'],
      },
    },
    grid: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachmentId: { type: 'string' },
        mediaType: { type: 'string' },
        bytes: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        name: { type: 'string' },
        columns: { type: 'number' },
        rows: { type: 'number' },
      },
      required: ['attachmentId', 'columns', 'rows'],
    },
    coverage: {
      type: 'object',
      additionalProperties: false,
      properties: {
        start: { type: 'number' },
        end: { type: 'number' },
        firstSample: { type: 'number' },
        lastSample: { type: 'number' },
        maxGapSeconds: { type: 'number' },
      },
      required: ['start', 'end', 'firstSample', 'lastSample', 'maxGapSeconds'],
    },
    subtitles: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: { type: 'string' },
        language: { type: 'string' },
        cueCount: { type: 'number' },
        chars: { type: 'number' },
        truncated: { type: 'boolean' },
        text: { type: 'string' },
      },
      required: ['source', 'cueCount', 'text'],
    },
    subtitleNote: { type: 'string' },
    transcript: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        language: { type: 'string' },
        audioSeconds: { type: 'number' },
        source: { type: 'string' },
      },
      required: ['text'],
    },
    transcriptNote: { type: 'string' },
    audioEvents: {
      type: 'object',
      additionalProperties: false,
      properties: {
        model: { type: 'string' },
        windows: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              start: { type: 'number' },
              end: { type: 'number' },
              events: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    label: { type: 'string' },
                    score: { type: 'number' },
                  },
                  required: ['label', 'score'],
                },
              },
            },
            required: ['start', 'end', 'events'],
          },
        },
      },
      required: ['model', 'windows'],
    },
    audioEventsNote: { type: 'string' },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['source', 'media', 'sampling', 'frames', 'coverage'],
};

/**
 * Merge raw config over the defaults, ignoring wrong types.
 * @param {unknown} rawConfig - the resolved row config.
 * @returns {typeof DEFAULTS} effective config.
 */
function readConfig(rawConfig) {
  const raw = rawConfig !== null && typeof rawConfig === 'object' ? rawConfig : {};
  const config = { ...DEFAULTS };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = raw[key];
    if (typeof fallback === 'string' && typeof value === 'string') config[key] = value;
    if (typeof fallback === 'number' && typeof value === 'number' && Number.isFinite(value)) config[key] = value;
    if (Array.isArray(fallback) && Array.isArray(value)) {
      config[key] = value.filter((item) => typeof item === 'string' && item.trim() !== '');
    }
  }
  return config;
}

/**
 * Whether a host belongs to bilibili, which needs the curl+WBI path on machines whose
 * TLS middlebox resets OpenSSL clients (yt-dlp is Python).
 * @param {string} host - lowercased hostname.
 * @returns {boolean} true for bilibili hosts.
 */
function isBilibiliHost(host) {
  return host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv';
}

/**
 * Run curl and return stdout text. `-o NUL` style callers can ignore the body.
 * @param {typeof DEFAULTS} config - effective config.
 * @param {string[]} args - curl arguments after the common headers.
 * @param {{ signal?: AbortSignal }} exec - execution environment.
 * @returns {Promise<string>} stdout text.
 */
async function curlText(config, args, exec, extraHeaders = []) {
  const { stdout } = await run(config.curlPath, [
    '-sS', '--max-time', '30',
    '-H', `User-Agent: ${BROWSER_UA}`,
    '-H', 'Referer: https://www.bilibili.com/',
    ...extraHeaders.flatMap((header) => ['-H', header]),
    ...args,
  ], { signal: exec.signal });
  return stdout.toString('utf8');
}

/**
 * Resolve the bilibili Cookie header from config (string or credential file).
 * @param {typeof DEFAULTS} config - effective config.
 * @returns {Promise<string|undefined>} cookie header, undefined when anonymous.
 */
async function resolveBilibiliCookie(config) {
  if (config.bilibiliCookieFile !== '') {
    return cookieFromCredential(await readFile(config.bilibiliCookieFile, 'utf8'));
  }
  if (config.bilibiliCookie !== '') return cookieFromCredential(config.bilibiliCookie);
  return undefined;
}

/**
 * Turn a bilibili page or short link into a bvid.
 * @param {typeof DEFAULTS} config - effective config.
 * @param {string} url - caller URL.
 * @param {{ signal?: AbortSignal }} exec - execution environment.
 * @returns {Promise<string>} the BV id.
 */
async function resolveBvid(config, url, exec) {
  const direct = bvidFromUrl(url);
  if (direct !== undefined) return direct;
  const effective = (await curlText(config, ['-sSL', '-o', 'NUL', '-w', '%{url_effective}', url], exec)).trim();
  const resolved = bvidFromUrl(effective);
  if (resolved === undefined) throw new Error(`could not find a BV id behind ${url}`);
  return resolved;
}

/**
 * Download one media URL to a file with curl (schannel TLS).
 * @param {typeof DEFAULTS} config - effective config.
 * @param {string} url - media URL.
 * @param {string} target - destination path.
 * @param {{ signal?: AbortSignal }} exec - execution environment.
 * @returns {Promise<void>} resolves when the file is written.
 */
async function downloadWithCurl(config, url, target, exec, extraHeaders = []) {
  const headersFile = `${target}.headers`;
  try {
    await run(config.curlPath, [
      '-sS', '-L', '--max-time', '600',
      '-D', headersFile,
      '-H', `User-Agent: ${BROWSER_UA}`,
      '-H', 'Referer: https://www.bilibili.com/',
      ...extraHeaders.flatMap((header) => ['-H', header]),
      '-o', target,
      url,
    ], { signal: exec.signal });
    let headers = '';
    try {
      headers = await readFile(headersFile, 'utf8');
    } catch {
      headers = '';
    }
    const declared = declaredContentLength(headers);
    if (declared !== undefined) {
      const actual = (await stat(target)).size;
      if (actual !== declared) {
        throw new Error(`download truncated: got ${actual} bytes but the server announced ${declared}`);
      }
    }
  } finally {
    await rm(headersFile, { force: true });
  }
}

/**
 * Whether an existing cache file is a complete, playable video.
 * @param {typeof DEFAULTS} config - effective config.
 * @param {string} target - candidate cache file.
 * @param {{ signal?: AbortSignal }} exec - execution environment.
 * @returns {Promise<boolean>} true only when ffprobe reports a real video stream.
 */
async function isCachedVideoUsable(config, target, exec) {
  try {
    const { ffprobe } = await resolveTools(config);
    return isUsableMedia(await probeVideo(ffprobe, target, exec.signal));
  } catch {
    return false;
  }
}

/**
 * Run the optional AudioSet tagger over a WAV buffer.
 * @param {typeof DEFAULTS} config - effective config.
 * @param {Buffer} wav - audio samples.
 * @param {number} seconds - length of the clip being read.
 * @param {{ signal?: AbortSignal }} exec - execution environment.
 * @returns {Promise<{ model: string, windows: Array<object> }>} parsed events.
 */
async function tagAudioEvents(config, wav, seconds, exec) {
  const tagDirectory = await mkdtemp(join(tmpdir(), 'dsh-whale-sight-tag-'));
  try {
    const tagWav = join(tagDirectory, 'clip.wav');
    await writeFile(tagWav, wav);
    // Python's tempfile probes TEMP/TMP; inside the host those paths are not
    // writable for the child, so point it at a directory we control.
    const tagTmp = config.audioTagTmpDir !== ''
      ? config.audioTagTmpDir
      : join(config.hfHome !== '' ? config.hfHome : tmpdir(), 'tmp');
    await mkdir(tagTmp, { recursive: true });
    const env = {
      ...process.env,
      TMPDIR: tagTmp,
      TEMP: tagTmp,
      TMP: tagTmp,
      ...(config.hfEndpoint === '' ? {} : { HF_ENDPOINT: config.hfEndpoint }),
      ...(config.hfHome === '' ? {} : { HF_HOME: config.hfHome }),
    };
    const { stdout } = await run(config.pythonPath, [
      config.audioTaggerPath,
      tagWav,
      '--start', '0',
      '--end', String(seconds),
      '--windows', String(config.audioTagWindows),
      '--topk', String(config.audioTagTopK),
    ], { signal: exec.signal, env });
    return parseAudioEvents(stdout.toString('utf8'));
  } finally {
    await rm(tagDirectory, { recursive: true, force: true });
  }
}

/**
 * Bound the merge step (curl downloads are bounded separately).
 * @param {typeof DEFAULTS} config - effective config.
 * @param {{ signal?: AbortSignal }} exec - execution environment.
 * @returns {AbortSignal} combined signal.
 */
function mergeSignal(config, exec) {
  const timeout = AbortSignal.timeout(config.mergeTimeoutMs ?? 300000);
  return exec.signal === undefined ? timeout : AbortSignal.any([exec.signal, timeout]);
}

/**
 * Download a bilibili video through curl + WBI signing, then merge the streams.
 * The merged file is written to `<target>.part` and renamed only after ffmpeg
 * succeeds, so a failed merge never becomes a cache hit.
 * @param {typeof DEFAULTS} config - effective config.
 * @param {string} url - page or short link.
 * @param {{ signal?: AbortSignal }} exec - execution environment.
 * @returns {Promise<string>} absolute path of the merged mp4.
 */
async function downloadBilibili(config, url, exec) {
  const bvid = await resolveBvid(config, url, exec);
  const target = join(resolveDownloadDir(config), `${bvid}.mp4`);
  if (existsSync(target)) {
    if (await isCachedVideoUsable(config, target, exec)) return target;
    await rm(target, { force: true });
  }

  const cookie = await resolveBilibiliCookie(config);
  const authHeaders = cookie === undefined ? [] : [`Cookie: ${cookie}`];
  const quality = cookie === undefined ? Math.min(config.bilibiliQuality, 64) : config.bilibiliQuality;

  const viewPayload = JSON.parse(await curlText(config, ['-H', 'Accept: application/json', `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`], exec, authHeaders));
  const view = parseView(viewPayload);
  const navPayload = JSON.parse(await curlText(config, ['-H', 'Accept: application/json', 'https://api.bilibili.com/x/web-interface/nav'], exec, authHeaders));
  const imgKey = String(navPayload?.data?.wbi_img?.img_url ?? '').split('/').pop().split('.')[0];
  const subKey = String(navPayload?.data?.wbi_img?.sub_url ?? '').split('/').pop().split('.')[0];
  if (imgKey === '' || subKey === '') throw new Error('bilibili nav returned no WBI keys');
  const mixin = mixinKey(imgKey, subKey);

  const playPayload = JSON.parse(await curlText(config, ['-H', 'Accept: application/json', buildPlayurlUrl({ bvid, cid: view.cid, qn: quality }, mixin)], exec, authHeaders));
  if (playPayload?.code !== 0) {
    throw new Error(`bilibili playurl failed: code=${playPayload?.code} ${playPayload?.message ?? ''}`.trim());
  }

  const finalPart = partPath(target);
  const mergeArgs = mergeSignal(config, exec);
  const { ffmpeg } = await resolveTools(config);

  if (playPayload?.data?.dash === undefined) {
    const direct = playPayload?.data?.durl?.[0]?.url;
    if (typeof direct !== 'string') throw new Error('bilibili playurl returned neither dash nor durl streams');
    const flv = `${finalPart}.flv`;
    try {
      await downloadWithCurl(config, direct, flv, exec, authHeaders);
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', flv, '-c', 'copy', '-f', 'mp4', finalPart], { signal: mergeArgs });
      await rename(finalPart, target);
      return target;
    } finally {
      await rm(flv, { force: true });
      await rm(finalPart, { force: true });
    }
  }

  const streams = pickStreams(playPayload.data.dash, { maxHeight: config.bilibiliMaxHeight });
  const videoTmp = `${finalPart}.v.m4s`;
  const audioTmp = `${finalPart}.a.m4s`;
  try {
    await downloadWithCurl(config, streams.videoUrl, videoTmp, exec, authHeaders);
    if (streams.audioUrl !== undefined) await downloadWithCurl(config, streams.audioUrl, audioTmp, exec, authHeaders);
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoTmp];
    if (streams.audioUrl !== undefined) args.push('-i', audioTmp);
    args.push('-c', 'copy', '-f', 'mp4', finalPart);
    await run(ffmpeg, args, { signal: mergeArgs });
    await rename(finalPart, target);
    return target;
  } finally {
    await rm(videoTmp, { force: true });
    await rm(audioTmp, { force: true });
    await rm(finalPart, { force: true });
  }
}

/**
 * Download a video URL into the configured cache directory.
 * @param {typeof DEFAULTS} config - effective config.
 * @param {string} url - validated http(s) URL.
 * @param {{ signal?: AbortSignal }} exec - execution environment.
 * @returns {Promise<string>} absolute path of the downloaded file.
 */
async function downloadVideo(config, url, exec) {
  const host = hostOf(url);
  if (host === undefined) throw new Error('this URL cannot be parsed');
  if (!isAllowedHost(host, config.allowedDomains)) {
    throw new Error(`host "${host}" is not in allowedDomains; add it in the plugin config first`);
  }
  await mkdir(resolveDownloadDir(config), { recursive: true });
  if (isBilibiliHost(host)) return downloadBilibili(config, url, exec);
  if (config.ytdlpPath === '') {
    throw new Error('video URLs need a downloader: set ytdlpPath to a yt-dlp executable in the plugin config');
  }
  const args = buildYtdlpArgs({
    url,
    outputDir: resolveDownloadDir(config),
    maxHeight: config.maxDownloadHeight,
    maxMB: config.maxDownloadMB,
    proxy: config.proxy,
    cookiesFromBrowser: config.cookiesFromBrowser,
  });
  const timeout = AbortSignal.timeout(config.downloadTimeoutMs);
  const signal = exec.signal === undefined ? timeout : AbortSignal.any([exec.signal, timeout]);
  const { stdout } = await run(config.ytdlpPath, args, { signal });
  const file = parseDownloadedPath(stdout.toString('utf8'));
  if (file === undefined) throw new Error('the downloader finished without reporting the downloaded file');
  return file;
}

/**
 * Resolve a caller path to an absolute host path.
 * @param {string} path - caller-supplied path.
 * @returns {string} absolute path.
 */
function absolutePath(path) {
  return isAbsolute(path) ? path : resolvePath(process.cwd(), path);
}

/**
 * Build the model-facing envelope plus the image blocks.
 * @param {Record<string, unknown>} args - caller arguments.
 * @param {Record<string, any>} value - the validated result.
 * @returns {Array<Record<string, unknown>>} content blocks.
 */
function renderVideo(args, value) {
  const { source, media, sampling, frames, grid, coverage, warnings, subtitles, subtitleNote, transcript, transcriptNote, audioEvents, audioEventsNote } = value;
  const duration = media.durationSeconds === undefined ? 'unknown duration' : `${media.durationSeconds.toFixed(2)}s`;
  const lines = [
    `<path>${source.path}</path>`,
    ...(source.url === undefined ? [] : [`<url>${source.url}</url>`]),
    '<type>video</type>',
    '<content>',
    `video, ${duration}, ${media.width}x${media.height} px`
      + `${media.fps === undefined ? '' : `, ${media.fps} fps`}, ${media.videoCodec}`
      + `${media.audioCodec === undefined ? ', no audio track' : `, audio ${media.audioCodec}`}`,
    grid === undefined
      ? `${sampling.delivered} frame${sampling.delivered === 1 ? '' : 's'} sampled ${coverage.firstSample.toFixed(2)}s-${coverage.lastSample.toFixed(2)}s of the ${coverage.start.toFixed(2)}s-${coverage.end.toFixed(2)}s window; each image below is preceded by its timestamp.`
      : `${sampling.delivered} moments sampled ${coverage.firstSample.toFixed(2)}s-${coverage.lastSample.toFixed(2)}s of the ${coverage.start.toFixed(2)}s-${coverage.end.toFixed(2)}s window, delivered as one contact sheet: ${grid.columns} columns x ${grid.rows} rows, read row by row; each cell is labelled "#n <second>s".`,
    `largest unsampled gap (window edges included): ${coverage.maxGapSeconds.toFixed(2)}s`,
    '</content>',
  ];
  if (typeof args?.carry === 'string' && args.carry.trim() !== '') {
    lines.push('<carry>', args.carry.trim(), '</carry>');
  }
  const blocks = [{ type: 'text', text: lines.join('\n') }];

  if (grid !== undefined) {
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: grid.attachmentId,
        mediaType: grid.mediaType,
        bytes: grid.bytes,
        width: grid.width,
        height: grid.height,
        ...(grid.name === undefined ? {} : { name: grid.name }),
      },
    });
    if (grid.rows * grid.columns > frames.length) {
      blocks.push({ type: 'text', text: `(${grid.rows * grid.columns - frames.length} trailing cell(s) are blank)` });
    }
  } else {
    for (const frame of frames) {
      if (frame.attachmentId === undefined) continue;
      blocks.push({ type: 'text', text: `frame ${frame.index}/${frames.length} @ ${frame.seconds.toFixed(2)}s` });
      blocks.push({
        type: 'image',
        attachment: {
          attachmentId: frame.attachmentId,
          mediaType: frame.mediaType,
          bytes: frame.bytes,
          width: frame.width,
          height: frame.height,
          ...(frame.name === undefined ? {} : { name: frame.name }),
        },
      });
    }
  }

  const tail = [
    '<how_to_read>',
    '1. Inventory before describing: people, what is held or shown, background, overlays.',
    '2. State what you think this clip is, and which frame backs that up.',
    '3. Go through the moments in order; say what changed from the previous one.',
    '4. Finish with one paragraph in time order, and name what you could not see.',
    'Never describe a moment that no frame covers; the unsampled gap above is real.',
    '</how_to_read>',
  ];
  if (subtitles !== undefined) {
    tail.push(`<subtitles source="${subtitles.source}" cues="${subtitles.cueCount}"${subtitles.truncated === true ? ' truncated="true"' : ''}>`);
    tail.push(subtitles.text);
    tail.push('</subtitles>');
    if (subtitles.truncated === true) tail.push('(the subtitle text was cut to fit the character budget; read a narrower window for the rest)');
  } else if (subtitleNote !== undefined) {
    tail.push(`<subtitles unavailable="${subtitleNote}"/>`);
  }
  if (transcript !== undefined) {
    tail.push(`<transcript language="${transcript.language ?? 'unknown'}">`);
    tail.push(transcript.text);
    tail.push('</transcript>');
  } else if (transcriptNote !== undefined) {
    tail.push(`<transcript unavailable="${transcriptNote}"/>`);
  }
  if (audioEvents !== undefined) {
    const lines = renderAudioEvents(audioEvents);
    if (lines.length > 0) {
      tail.push(`<audio_events model="${audioEvents.model}">`);
      for (const line of lines) tail.push(line);
      tail.push('</audio_events>');
    }
  } else if (audioEventsNote !== undefined) {
    tail.push(`<audio_events unavailable="${audioEventsNote}"/>`);
  }
  if (Array.isArray(warnings) && warnings.length > 0) {
    tail.push('<warnings>');
    for (const warning of warnings) tail.push(`- ${warning}`);
    tail.push('</warnings>');
  }
  blocks.push({ type: 'text', text: tail.join('\n') });
  return blocks;
}

/**
 * Find a subtitle file saved beside the video.
 * @param {string} file - absolute media path.
 * @returns {Promise<{ path: string, text: string }|undefined>} the sidecar.
 */
async function findSidecar(file) {
  const base = file.replace(/\.[^.]+$/u, '');
  for (const extension of ['.srt', '.vtt']) {
    const candidate = base + extension;
    try {
      return { path: candidate, text: await readFile(candidate, 'utf8') };
    } catch {
      // try the next extension
    }
  }
  return undefined;
}

/**
 * Read one video into frames and attachments.
 * @param {any} ctx - plugin context.
 * @param {typeof DEFAULTS} config - effective config.
 * @param {Record<string, unknown>} args - caller arguments.
 * @param {{ signal?: AbortSignal }} exec - execution environment.
 * @returns {Promise<Record<string, any>>} the structured result.
 */
async function readVideo(ctx, config, args, exec) {
  const requested = typeof args.path === 'string' ? args.path.trim() : '';
  if (requested === '') throw new Error('path must be a non-empty string');
  const remote = isHttpUrl(requested);
  const file = remote ? await downloadVideo(config, requested, exec) : absolutePath(requested);
  const info = await stat(file).catch(() => undefined);
  if (info === undefined || !info.isFile()) throw new Error(`no file at "${file}"`);

  const attachments = ctx.get('attachments');
  if (attachments === undefined) throw new Error('the attachment service is not mounted, so frames cannot be delivered');

  const { ffmpeg, ffprobe } = await resolveTools(config);
  const probed = await probeVideo(ffprobe, file, exec.signal);
  // `subtitleStreams` guides subtitle extraction but is not part of the model-facing
  // media shape, whose schema allows no additional properties.
  const { subtitleStreams, ...media } = probed;
  const duration = media.durationSeconds ?? 0;
  const warnings = [];

  let start = typeof args.start === 'number' && Number.isFinite(args.start) ? Math.max(0, args.start) : 0;
  let end = typeof args.end === 'number' && Number.isFinite(args.end) ? args.end : duration;
  if (end <= start) end = start + 1;
  if (duration > 0 && end > duration) end = duration;
  if (duration > config.maxSeconds && args.end === undefined) {
    end = Math.min(duration, start + config.maxSeconds);
    warnings.push(`the clip is longer than ${config.maxSeconds}s, so this read stops at ${end.toFixed(2)}s; pass start/end to read another part`);
  }

  const wantCount = typeof args.frames === 'number'
    ? clampInt(args.frames, 1, config.maxFrames)
    : clampInt(config.defaultFrames, 1, config.maxFrames);
  /** @type {number[]|undefined} */
  let positions;
  /** @type {'explicit'|'shots'|'even'} */
  let strategy = 'even';
  let shotCount;
  let dropped = 0;

  if (Array.isArray(args.timestamps) && args.timestamps.length > 0) {
    strategy = 'explicit';
    positions = [...new Set(args.timestamps
      .filter((value) => typeof value === 'number' && Number.isFinite(value))
      .map((value) => Math.min(end, Math.max(start, Math.round(value * 1000) / 1000))))]
      .sort((a, b) => a - b)
      .slice(0, config.maxFrames);
  } else if (config.sampling === 'auto' && duration > 0 && end - start >= 1) {
    const windowSeconds = end - start;
    const scanned = Math.min(windowSeconds, config.motionScanMaxSeconds);
    if (scanned < windowSeconds) {
      warnings.push(`this read covers ${windowSeconds.toFixed(2)}s but the motion scan stops at ${scanned}s; the rest was not compared`);
    }
    try {
      const scan = await scanActivity(ffmpeg, file, {
        start,
        spanSeconds: scanned,
        fps: config.motionFps,
        signal: exec.signal,
      });
      const boundaries = detectShotBoundaries(scan.changes, {
        shotRatio: config.shotRatio,
        shotFloor: config.shotFloor,
        minShotSeconds: config.minShotSeconds,
      });
      if (boundaries.length >= 1) {
        const shotPositions = planShotTimestamps({ boundaries, start, end, count: wantCount });
        const deduped = dedupeByThumbnails({
          positions: shotPositions,
          frames: scan.frames,
          fps: scan.fps,
          start,
          minDistance: config.minCellNovelty,
        });
        if (deduped.positions.length >= 2) {
          positions = deduped.positions;
          strategy = 'shots';
          shotCount = boundaries.length + 1;
          dropped = deduped.dropped;
        }
      }
      if (positions === undefined) warnings.push('no shot change stood out in this clip, so frames were spaced evenly');
    } catch (error) {
      warnings.push(`the motion scan failed, so frames were spaced evenly: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (positions === undefined) {
    positions = planEvenTimestamps(start, end, wantCount);
    if (strategy !== 'explicit') strategy = 'even';
  }

  const layout = resolveLayout(args.layout, positions.length, config.gridWhenAtLeast);
  const quality = config.jpegQuality;
  const width = typeof args.width === 'number' && Number.isFinite(args.width)
    ? clampInt(args.width, 64, 2048)
    : (layout === 'grid' ? config.cellWidth : config.frameWidth);

  // A storyboard decodes several independent stills; running a few ffmpeg processes in
  // flight is the difference between a 3s and a 1s read on a 60s clip.
  const outcomes = await mapWithConcurrency(positions, config.frameConcurrency, async (seconds, index) => {
    if (exec.signal?.aborted) throw new Error('the read was cancelled');
    try {
      const bytes = await grabFrame(ffmpeg, file, seconds, {
        width,
        quality,
        label: layout === 'grid' ? `#${index + 1} ${seconds.toFixed(1)}s` : undefined,
        signal: exec.signal,
      });
      return { index, seconds, bytes };
    } catch (error) {
      return { index, seconds, error: error instanceof Error ? error.message : String(error) };
    }
  });

  const frames = [];
  const cells = [];
  for (const outcome of outcomes) {
    if (outcome.error !== undefined) {
      warnings.push(`frame at ${outcome.seconds.toFixed(2)}s could not be decoded: ${outcome.error}`);
      continue;
    }
    if (layout === 'grid') {
      cells.push(outcome.bytes);
      frames.push({ index: frames.length + 1, seconds: outcome.seconds });
      continue;
    }
    try {
      const ref = await attachments.saveImage({
        data: outcome.bytes,
        mediaType: 'image/jpeg',
        name: `${basename(file).replace(/\.[^.]+$/u, '')}@${outcome.seconds.toFixed(2)}s.jpg`,
      });
      frames.push({
        index: frames.length + 1,
        seconds: outcome.seconds,
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      });
    } catch (error) {
      warnings.push(`frame at ${outcome.seconds.toFixed(2)}s was rejected by the attachment service: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (frames.length === 0) throw new Error('no frame could be decoded from this file; is it a video?');

  let grid;
  if (layout === 'grid') {
    if (cells.length >= 2) {
      const { columns, rows } = planGridCells(cells.length);
      try {
        const sheet = await composeSheet(ffmpeg, cells, { columns, rows, quality, signal: exec.signal });
        const ref = await attachments.saveImage({
          data: sheet,
          mediaType: 'image/jpeg',
          name: `${basename(file).replace(/\.[^.]+$/u, '')}-sheet.jpg`,
        });
        grid = {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          columns,
          rows,
          ...(ref.name === undefined ? {} : { name: ref.name }),
        };
      } catch (error) {
        warnings.push(`the contact sheet could not be composed, frames are returned separately: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (grid === undefined) {
      for (const frame of frames) {
        try {
          const bytes = await grabFrame(ffmpeg, file, frame.seconds, { width, quality, signal: exec.signal });
          const ref = await attachments.saveImage({
            data: bytes,
            mediaType: 'image/jpeg',
            name: `${basename(file).replace(/\.[^.]+$/u, '')}@${frame.seconds.toFixed(2)}s.jpg`,
          });
          Object.assign(frame, {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name === undefined ? {} : { name: ref.name }),
          });
        } catch (error) {
          warnings.push(`frame at ${frame.seconds.toFixed(2)}s was rejected by the attachment service: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  const firstSample = positions[0] ?? start;
  const lastSample = positions[positions.length - 1] ?? end;
  const gaps = [firstSample - start];
  for (let index = 1; index < positions.length; index += 1) gaps.push(positions[index] - positions[index - 1]);
  gaps.push(end - lastSample);
  const maxGap = Math.max(0, ...gaps);

  const language = typeof args.language === 'string' && args.language.trim() !== '' ? args.language.trim() : config.language;
  const wantSubtitles = typeof args.subtitles === 'boolean' ? args.subtitles : config.subtitles;
  const wantTranscript = typeof args.transcript === 'boolean' ? args.transcript : config.transcript;
  let subtitles;
  let subtitleNote;
  let transcript;
  let transcriptNote;
  let audioEvents;
  let audioEventsNote;

  if (wantSubtitles) {
    try {
      const sidecar = await findSidecar(file);
      let raw;
      let source;
      if (sidecar !== undefined) {
        raw = sidecar.text;
        source = `sidecar:${basename(sidecar.path)}`;
      } else {
        const track = (subtitleStreams ?? []).find((candidate) => candidate.text === true);
        if (track !== undefined) {
          raw = await grabSubtitles(ffmpeg, file, track.index, exec.signal);
          source = `track:${track.codec}`;
        } else {
          subtitleNote = 'the file carries no text subtitle track and no .srt/.vtt beside it';
        }
      }
      if (raw !== undefined) {
        const cues = parseCues(raw);
        if (cues.length === 0) {
          subtitleNote = 'the subtitle source had no readable cues';
        } else {
          const rendered = renderCues(cues, { maxChars: config.maxSubtitleChars });
          subtitles = {
            source,
            ...(language === '' ? {} : { language }),
            cueCount: rendered.cueCount,
            chars: rendered.chars,
            ...(rendered.truncated ? { truncated: true } : {}),
            text: rendered.text,
          };
        }
      }
    } catch (error) {
      subtitleNote = `subtitles could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    subtitleNote = 'subtitles were disabled for this read';
  }

  if (wantTranscript) {
    if (media.audioCodec === undefined) {
      transcriptNote = 'this file has no audio track';
    } else {
      try {
        const windowSeconds = Math.max(1, end - start);
        const audioSeconds = Math.min(config.maxAudioSeconds, windowSeconds);
        if (audioSeconds < windowSeconds) {
          warnings.push(`only the first ${audioSeconds.toFixed(0)}s of this ${windowSeconds.toFixed(0)}s window was sent to speech-to-text; the rest was not heard`);
        }
        const wav = await grabAudioWav(ffmpeg, file, {
          start,
          maxSeconds: audioSeconds,
          signal: exec.signal,
        });

        if (config.audioTaggerPath !== '' && config.pythonPath !== '') {
          try {
            audioEvents = await tagAudioEvents(config, wav, audioSeconds, exec);
          } catch (error) {
            audioEventsNote = `audio events could not be tagged: ${error instanceof Error ? error.message : String(error)}`;
          }
        }

        const speech = ctx.get('speechToText');
        const providers = speech === undefined ? [] : (speech.snapshot?.()?.providers ?? []);
        const whisperReady = config.whisperCppPath !== '' && config.whisperModelPath !== '';
        let providerProblem;

        // Provider first: it is the host's own recognizer and usually the best one.
        if (providers.length === 0) {
          providerProblem = 'no speech-to-text provider is mounted';
        } else {
          try {
            const spec = speech.resolve({ audio: wav, language });
            const result = await speech.transcribe(spec, exec.signal);
            const spoken = typeof result?.text === 'string' ? result.text.trim() : '';
            if (spoken === '') {
              providerProblem = `the speech-to-text provider returned no text (${language})`;
            } else {
              transcript = {
                text: spoken,
                ...(language === '' ? {} : { language }),
                ...(typeof result?.audioSeconds === 'number' ? { audioSeconds: result.audioSeconds } : {}),
              };
            }
          } catch (error) {
            providerProblem = `the speech-to-text provider failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        }

        // Local fallback: a provider that is mounted but not prepared still fails, so the
        // fallback belongs on the outcome, not on the provider list being empty.
        if (transcript === undefined && whisperReady) {
          try {
            const local = await transcribeWithWhisper(config.whisperCppPath, config.whisperModelPath, wav, {
              language,
              threads: config.whisperThreads,
              tmpDir: config.audioDir,
              signal: exec.signal,
            });
            if (local.text === '') {
              transcriptNote = `${providerProblem}; whisper.cpp heard no speech`;
            } else {
              transcript = {
                text: local.text,
                ...(language === '' ? {} : { language }),
                source: 'whisper.cpp',
              };
              transcriptNote = `${providerProblem}; transcribed with the local whisper.cpp fallback`;
            }
          } catch (error) {
            transcriptNote = `${providerProblem}; the local whisper.cpp fallback failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        } else if (transcript === undefined) {
          const directory = config.audioDir !== '' ? config.audioDir : join(tmpdir(), 'dsh-whale-sight-audio');
          await mkdir(directory, { recursive: true });
          const target = join(directory, `${basename(file).replace(/\.[^.]+$/u, '')}-${start.toFixed(0)}s.wav`);
          await writeFile(target, wav);
          transcriptNote = `${providerProblem}; the audio was saved to ${target} so it can be transcribed separately`;
        }
      } catch (error) {
        transcriptNote = `the audio track could not be transcribed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  } else {
    transcriptNote = 'transcript was disabled for this read';
    // Audio events are a separate sense: do not let a transcript-off read silence them.
    if (media.audioCodec !== undefined && config.audioTaggerPath !== '' && config.pythonPath !== '') {
      try {
        const windowSeconds = Math.max(1, end - start);
        const audioSeconds = Math.min(config.maxAudioSeconds, windowSeconds);
        const wav = await grabAudioWav(ffmpeg, file, {
          start,
          maxSeconds: audioSeconds,
          signal: exec.signal,
        });
        audioEvents = await tagAudioEvents(config, wav, audioSeconds, exec);
      } catch (error) {
        audioEventsNote = `audio events could not be tagged: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  return {
    source: { path: file, ...(remote ? { url: requested } : {}) },
    media,
    sampling: {
      strategy,
      ...(typeof args.frames === 'number' ? { requested: clampInt(args.frames, 1, config.maxFrames) } : {}),
      delivered: frames.length,
      layout: grid === undefined ? 'frames' : 'grid',
      ...(shotCount === undefined ? {} : { shots: shotCount }),
      ...(dropped > 0 ? { dropped } : {}),
    },
    frames,
    ...(grid === undefined ? {} : { grid }),
    coverage: {
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      firstSample: Math.round(firstSample * 1000) / 1000,
      lastSample: Math.round(lastSample * 1000) / 1000,
      maxGapSeconds: Math.round(maxGap * 1000) / 1000,
    },
    ...(subtitles === undefined ? {} : { subtitles }),
    ...(subtitleNote === undefined ? {} : { subtitleNote }),
    ...(transcript === undefined ? {} : { transcript }),
    ...(transcriptNote === undefined ? {} : { transcriptNote }),
    ...(audioEvents === undefined ? {} : { audioEvents }),
    ...(audioEventsNote === undefined ? {} : { audioEventsNote }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/**
 * Register the `watch_video` tool.
 * @param {any} ctx - the plugin context.
 * @param {Record<string, unknown>} [rawConfig] - the resolved row config.
 * @returns {() => void} the tool registration disposer.
 */
export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig);
  return ctx.tools.register({
    name: 'watch_video',
    description:
      'Look at a video file. Probes the clip with ffprobe, samples frames with ffmpeg and returns them as images you can see, '
      + 'either one labelled contact sheet (cheap, wide coverage) or separate timestamped frames, plus duration, resolution, '
      + 'frame rate and codec. Use it to describe what happens in a video, read on-screen text, identify people or actions, '
      + 'or answer questions about specific moments. Positions are in seconds; pass start/end or timestamps to re-read one part. '
      + 'It also accepts an http(s) video URL: the clip is downloaded into the configured cache first, then read the same way.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => renderVideo(args, value),
      presentationMeta: (_args, value) => ({ path: value.source.path }),
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Watch video ${args.path}`,
        kind: 'read',
        locations: [{ path: args.path }],
      };
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return readVideo(ctx, config, args, exec);
    },
  });
}

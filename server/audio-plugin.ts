/**
 * Vite plugin that serves the example's audio endpoints.
 *
 * The same plugin instance is used by `npm run dev` and `npm run preview`, so it
 * installs its middleware through both `configureServer` and
 * `configurePreviewServer`. In each case the hook runs *before* Vite adds its own
 * middlewares (config/transform/static/html), which gives us two properties:
 *
 * 1. the COOP/COEP/CORP headers are set on every response Vite produces, not
 *    just ours — `crossOriginIsolated` (and therefore `SharedArrayBuffer` for the
 *    capture worklet) depends on them being on the HTML document and the module
 *    scripts alike;
 * 2. our routes win over any Vite fallback, while every path we do not own simply
 *    falls through to Vite with `next()`.
 *
 * Endpoints:
 *   GET|HEAD /api/meta         JSON description of the loop (unknown /api/** → 404)
 *   GET|HEAD /audio/track.wav  16-bit PCM WAV, single byte range → 206, bad → 416
 *   GET      /stream/pcm       paced raw f32le interleaved stereo, loops forever
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';

import { STREAM_CHUNK_FRAMES, STREAM_INTERVAL_MS } from '../shared/audio.ts';
import { getAudioAssets } from './assets.ts';

const META_PATH = '/api/meta';
const WAV_PATH = '/audio/track.wav';
const STREAM_PATH = '/stream/pcm';

const FLOAT32_BYTES = 4;

/**
 * Headers that must accompany every response. COOP+COEP are what make the page
 * cross-origin isolated (required for the SharedArrayBuffer worklet ring); CORP
 * keeps those headers from breaking same-origin subresources; no-store stops the
 * media element / fetch cache from hiding changes to the generated track.
 */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

interface ByteRange {
  start: number;
  end: number;
}

/** Pathname of the request, or null when the URL cannot be parsed. */
function parsePathname(requestUrl: string | undefined): string | null {
  if (requestUrl === undefined) return '/';
  try {
    return new URL(requestUrl, 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
}

function isReadMethod(req: IncomingMessage): boolean {
  return req.method === 'GET' || req.method === 'HEAD';
}

/** Write a complete (non-streaming) response; HEAD gets the headers but no body. */
function sendBody(
  req: IncomingMessage,
  res: ServerResponse,
  statusCode: number,
  contentType: string,
  body: Buffer,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
    ...extraHeaders,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendText(
  req: IncomingMessage,
  res: ServerResponse,
  statusCode: number,
  text: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  sendBody(req, res, statusCode, 'text/plain; charset=utf-8', Buffer.from(text), extraHeaders);
}

function sendNotFound(req: IncomingMessage, res: ServerResponse): void {
  sendText(req, res, 404, 'Not found\n');
}

function sendMethodNotAllowed(req: IncomingMessage, res: ServerResponse, allow: string): void {
  sendText(req, res, 405, 'Method Not Allowed\n', { Allow: allow });
}

/**
 * Parse one HTTP `Range` header against a known total size.
 *
 * Returns `null` when there is no range (serve 200), a `ByteRange` for a single
 * satisfiable range (serve 206), or `'invalid'` (serve 416). Multi-range
 * requests are treated as invalid on purpose: the only consumer of this file is
 * an `<audio>` element / `decodeAudioData`, both of which ask for a single range,
 * and implementing multipart/byteranges would add complexity for no benefit.
 */
function parseRange(header: string | undefined, total: number): ByteRange | 'invalid' | null {
  if (header === undefined || header === '') return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === '' && match[2] === '')) return 'invalid';

  let start: number;
  let end: number;
  if (match[1] === '') {
    // Suffix form `bytes=-500`: the last 500 bytes.
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? total - 1 : Math.min(Number(match[2]), total - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'invalid';
  if (start < 0 || start >= total || start > end) return 'invalid';
  return { start, end };
}

/** `GET|HEAD /api/meta` — the loop's JSON description. */
function handleMeta(req: IncomingMessage, res: ServerResponse): void {
  if (!isReadMethod(req)) {
    sendMethodNotAllowed(req, res, 'GET, HEAD');
    return;
  }
  const { meta } = getAudioAssets();
  sendBody(req, res, 200, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(meta)));
}

/**
 * `GET|HEAD /audio/track.wav` — the encoded loop with single-range support.
 *
 * `Accept-Ranges: bytes` advertises support; a well-formed `Range` yields a 206
 * with a `Content-Range` header describing the served slice, while a malformed
 * or unsatisfiable range yields a 416 whose `Content-Range` declares the full
 * length as unsatisfiable.
 */
function handleWav(req: IncomingMessage, res: ServerResponse): void {
  if (!isReadMethod(req)) {
    sendMethodNotAllowed(req, res, 'GET, HEAD');
    return;
  }
  const { wav } = getAudioAssets();
  const total = wav.length;
  const range = parseRange(req.headers.range, total);

  if (range === 'invalid') {
    sendText(req, res, 416, 'Range not satisfiable\n', {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${total}`,
    });
    return;
  }
  if (range === null) {
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(total),
    });
    res.end(req.method === 'HEAD' ? undefined : wav);
    return;
  }
  const body = wav.subarray(range.start, range.end + 1); // subarray: no copy of the file
  res.writeHead(206, {
    'Content-Type': 'audio/wav',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(body.length),
    'Content-Range': `bytes ${range.start}-${range.end}/${total}`,
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * `GET /stream/pcm` — the loop as a live, paced byte stream.
 *
 * One chunk is 20 ms of interleaved stereo f32le (960 frames), written once per
 * `STREAM_INTERVAL_MS` forever; the PCM buffer is looped at byte granularity.
 * The response has no Content-Length, so Node uses chunked transfer encoding and
 * the client's parser sees arbitrary chunk boundaries (which `pcm.ts` handles).
 *
 * Backpressure: `write()` returning false means the socket buffer is full. We
 * then skip ticks instead of queueing audio into memory; the `drain` event clears
 * the flag for the next tick. The interval is cleared when the request or
 * response closes, so a reloaded or aborted page never leaves a timer running.
 */
function handleStream(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(req, res, 'GET');
    return;
  }
  const { meta, pcm } = getAudioAssets();
  const chunkBytes = STREAM_CHUNK_FRAMES * meta.channels * FLOAT32_BYTES;

  let offset = 0;
  let waitingForDrain = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    res.off('drain', onDrain);
    res.off('close', stop);
    res.off('error', stop);
    req.off('close', stop);
    req.off('error', stop);
  };

  const onDrain = (): void => {
    waitingForDrain = false;
  };

  const writeChunk = (): void => {
    if (stopped || waitingForDrain) return;
    const end = Math.min(offset + chunkBytes, pcm.length);
    const chunk = pcm.subarray(offset, end);
    offset = end >= pcm.length ? 0 : end;
    try {
      if (!res.write(chunk)) waitingForDrain = true;
    } catch {
      stop(); // socket already gone; 'close' will also fire, but stop() is idempotent
    }
  };

  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'X-Sample-Rate': String(meta.sampleRate),
    'X-Channels': String(meta.channels),
    'X-Format': 'f32le-interleaved',
  });
  res.flushHeaders(); // no Content-Length → Node emits Transfer-Encoding: chunked

  res.on('drain', onDrain);
  // Either side of the exchange can notice the peer going away first.
  res.on('close', stop);
  res.on('error', stop);
  req.on('close', stop);
  req.on('error', stop);

  timer = setInterval(writeChunk, STREAM_INTERVAL_MS);
  writeChunk(); // first 20 ms immediately: no dead air, still paced afterwards
}

/** The middleware itself: headers first, then our routes, then Vite's stack. */
function audioMiddleware(
  req: Connect.IncomingMessage,
  res: ServerResponse,
  next: Connect.NextFunction,
): void {
  // Set before dispatch so our own 404/416/405 and Vite's responses all carry
  // the isolation headers (Node merges these into the later writeHead call).
  for (const name of Object.keys(BASE_HEADERS)) res.setHeader(name, BASE_HEADERS[name]);

  const pathname = parsePathname(req.url);
  if (pathname === null) {
    sendText(req, res, 400, 'Bad Request\n');
    return;
  }

  if (pathname === META_PATH) {
    handleMeta(req, res);
    return;
  }
  if (pathname === WAV_PATH) {
    handleWav(req, res);
    return;
  }
  if (pathname === STREAM_PATH) {
    handleStream(req, res);
    return;
  }
  // Only the API namespace owned by this plugin 404s; every other path belongs
  // to Vite (index.html, /src/**, /@vite/**, the preview build, ...).
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    sendNotFound(req, res);
    return;
  }
  next();
}

/** Add the audio endpoints middleware to a dev or preview server. */
function installAudioMiddleware(middlewares: Connect.Server): void {
  middlewares.use(audioMiddleware);
}

/** The Vite plugin used by `vite.config.ts`: `audioPlugin()`. */
export function audioPlugin(): Plugin {
  return {
    name: 'wave-gpu:audio',
    // Adding middleware from these hooks puts it before Vite's internal ones.
    configureServer(server) {
      installAudioMiddleware(server.middlewares);
    },
    configurePreviewServer(server) {
      installAudioMiddleware(server.middlewares);
    },
  };
}

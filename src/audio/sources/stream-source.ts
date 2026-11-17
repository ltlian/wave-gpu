/**
 * Entry point #3: a live raw-PCM stream.
 *
 * `GET /stream/pcm` is interleaved stereo f32le @ 48 kHz. There is no decoder:
 * the bytes *are* the samples, so this mode owns the clock end to end.
 *
 *   fetch() bytes ─▶ pcm.appendBytes (whole frames only)
 *                 ─▶ pending queue ─▶ small AudioBuffers scheduled against
 *                                    ctx.currentTime with ~0.2 s lookahead
 *
 * The endpoint can be real-time paced (the dev server writes one 20 ms chunk per
 * 20 ms) or a plain finite file (the deployed site ships the loop as a static
 * asset). Both behave the same here because the client paces its own *reads*:
 * it keeps ~2 s of audio queued and only reads more once the scheduler has
 * drained below that, so bytes that arrive faster than playback cannot outrun
 * the queue. When the body ends it is re-fetched; the queue still holds ~2 s, so
 * the loop restarts without a gap.
 *
 * Two details make it robust:
 *  - network chunks are arbitrary sizes, so the byte tail that does not yet
 *    form a whole stereo frame is carried to the next chunk (`leftover`);
 *  - `AudioBuffer`s are created with `sampleRate: SAMPLE_RATE` (the producer's
 *    rate) rather than the context's rate: the graph resamples on playback, so
 *    the queue stays correct even if the device runs at 44.1 kHz.
 *
 * An initial ~0.25 s prebuffer avoids an immediate underrun. If the playhead
 * ever overtakes the queue (tab throttling, context resume) we jump forward a
 * little instead of scheduling buffers in the past.
 */

import { SAMPLE_RATE, STREAM_CHUNK_FRAMES, STREAM_INTERVAL_MS } from '../../../shared/audio.ts';
import { STREAM_CHANNELS, appendBytes, takeFrames } from '../pcm.ts';
import type { AudioSource, SourceStats } from '../../types.ts';

const STREAM_URL = '/stream/pcm';
/** Audio queued before the first buffer is scheduled. */
const PREBUFFER_FRAMES = Math.round(SAMPLE_RATE * 0.25); // 0.25 s
/** How far ahead of ctx.currentTime buffers are scheduled. */
const LOOKAHEAD_SECONDS = 0.2;
/** Frames in one scheduled AudioBuffer (80 ms at 48 kHz). */
const SCHEDULE_CHUNK_FRAMES = 3_840;
/** Do not schedule fragments smaller than one server chunk (20 ms). */
const MIN_SCHEDULE_FRAMES = STREAM_CHUNK_FRAMES;
/**
 * Read-ahead target: below this the read loop pulls more bytes, above it waits
 * for the scheduler to drain. A single `read()` can return a chunk far larger
 * than the target (the browser buffers a static file while we wait), so the
 * queue is allowed to overshoot instead of being trimmed.
 */
const MAX_PENDING_FRAMES = SAMPLE_RATE * 2;
/**
 * Hard cap, only for a pathological stall (suspended context, throttled tab).
 * Larger than the 12 s loop on purpose: bytes that arrived are kept, because
 * dropping them is exactly the audio gap this pacing exists to avoid.
 */
const HARD_CAP_FRAMES = SAMPLE_RATE * 15;
/** Start with whatever arrived if the stream is slower than we hoped. */
const START_TIMEOUT_MS = 1_500;
/** Top-up cadence, and how long a paused read waits before re-checking the queue. */
const PUMP_INTERVAL_MS = STREAM_INTERVAL_MS;

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name: unknown }).name === 'AbortError'
  );
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

interface StreamState {
  readonly context: AudioContext;
  readonly destination: AudioNode;
  readonly abort: AbortController;
  pending: Float32Array[];
  pendingFrames: number;
  /** < one stereo frame of bytes carried across fetch chunks. */
  leftover: Uint8Array;
  nextStartTime: number;
  scheduled: Set<AudioBufferSourceNode>;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  timer: ReturnType<typeof setInterval> | null;
  started: boolean;
  stopped: boolean;
  resolveStarted: (() => void) | null;
}

export function createStreamSource(onError: (message: string) => void = () => {}): AudioSource {
  const stats: SourceStats = { bytes: 0, chunks: 0 };
  let state: StreamState | null = null;
  /** Bumped by stop() so an in-flight start() knows it was superseded. */
  let generation = 0;

  function release(stream: StreamState): void {
    if (stream.stopped) return;
    stream.stopped = true;
    if (stream.timer !== null) {
      clearInterval(stream.timer);
      stream.timer = null;
    }
    stream.resolveStarted?.();
    stream.resolveStarted = null;
    stream.abort.abort();
    const reader = stream.reader;
    stream.reader = null;
    if (reader !== null) {
      try {
        void reader.cancel().catch(() => {});
      } catch {
        // already released
      }
    }
    for (const node of stream.scheduled) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        // already stopped
      }
      try {
        node.disconnect();
      } catch {
        // already disconnected
      }
    }
    stream.scheduled.clear();
    stream.pending = [];
    stream.pendingFrames = 0;
    stream.leftover = new Uint8Array(0);
  }

  function scheduleBuffer(stream: StreamState, samples: Float32Array, frames: number, now: number): void {
    // Created at the producer's rate: the audio graph resamples on playback.
    const buffer = stream.context.createBuffer(STREAM_CHANNELS, frames, SAMPLE_RATE);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < frames; i += 1) {
      left[i] = samples[STREAM_CHANNELS * i];
      right[i] = samples[STREAM_CHANNELS * i + 1];
    }

    const node = stream.context.createBufferSource();
    node.buffer = buffer;
    node.connect(stream.destination);
    const startAt = Math.max(stream.nextStartTime, now + 0.02);
    node.start(startAt);
    stream.nextStartTime = startAt + buffer.duration;
    stream.scheduled.add(node);
    node.onended = () => {
      stream.scheduled.delete(node);
      try {
        node.disconnect();
      } catch {
        // already disconnected
      }
    };
  }

  function pump(stream: StreamState): void {
    if (stream.stopped || !stream.started) return;
    const now = stream.context.currentTime;
    // Playhead overtook the queue: resync just ahead of now rather than
    // scheduling buffers in the past (which would dump them all at once).
    if (stream.nextStartTime < now - 0.08) stream.nextStartTime = now + 0.04;

    let guard = 0;
    while (
      stream.pendingFrames >= MIN_SCHEDULE_FRAMES &&
      stream.nextStartTime < now + LOOKAHEAD_SECONDS &&
      guard < 4
    ) {
      guard += 1;
      const wanted = Math.min(SCHEDULE_CHUNK_FRAMES, stream.pendingFrames);
      const taken = takeFrames(stream.pending, wanted);
      if (taken.framesTaken === 0) break;
      stream.pending = taken.chunks;
      stream.pendingFrames -= taken.framesTaken;
      scheduleBuffer(stream, taken.samples, taken.framesTaken, now);
    }
  }

  /**
   * Safety valve for a stalled pump: past the hard cap the oldest audio is
   * dropped rather than grown without bound. Steady state never reaches it —
   * the read loop pauses at MAX_PENDING_FRAMES instead.
   */
  function dropOldest(stream: StreamState): void {
    while (stream.pendingFrames > HARD_CAP_FRAMES && stream.pending.length > 0) {
      const head = stream.pending.shift();
      if (head === undefined) break;
      stream.pendingFrames -= head.length / STREAM_CHANNELS;
    }
  }

  function beginPlayback(stream: StreamState): void {
    if (stream.started || stream.stopped) return;
    stream.started = true;
    // A little headroom so the first buffers are scheduled in the future.
    stream.nextStartTime = stream.context.currentTime + 0.1;
    pump(stream);
    stream.resolveStarted?.();
    stream.resolveStarted = null;
  }

  /** Open the endpoint and hand its body to the read loop. */
  async function connect(stream: StreamState): Promise<void> {
    let response: Response;
    try {
      response = await fetch(STREAM_URL, { signal: stream.abort.signal, cache: 'no-store' });
    } catch (error) {
      if (stream.stopped || isAbortError(error)) throw error;
      throw new Error(`could not open ${STREAM_URL}: ${describeError(error)}`);
    }
    if (stream.stopped) return;
    if (!response.ok) throw new Error(`${STREAM_URL} responded HTTP ${response.status}`);
    const body = response.body;
    if (body === null) throw new Error(`${STREAM_URL} has no readable body`);
    stream.reader = body.getReader();
  }

  /**
   * Re-open the endpoint after its body ended (a finite static asset in
   * production, or a connection that dropped). The queue still holds ~2 s, so
   * this is seamless; `false` means the source is dead and has been released.
   */
  async function reconnect(stream: StreamState): Promise<boolean> {
    stream.reader = null;
    try {
      await connect(stream);
      return !stream.stopped;
    } catch (error) {
      if (stream.stopped || isAbortError(error)) return false;
      onError(describeError(error));
      if (state === stream) state = null;
      release(stream);
      return false;
    }
  }

  async function readLoop(stream: StreamState): Promise<void> {
    while (!stream.stopped) {
      const reader = stream.reader;
      if (reader === null) return;

      // Pace reads against playback. A static file can deliver the whole loop
      // in milliseconds, but the scheduler only looks 0.2 s ahead, so only read
      // while there is room in the queue. A server that paces its writes never
      // makes this wait — the bytes arrive just in time by themselves.
      if (stream.pendingFrames >= MAX_PENDING_FRAMES) {
        await sleep(PUMP_INTERVAL_MS);
        continue;
      }

      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (stream.stopped || isAbortError(error)) return;
        if (!(await reconnect(stream))) return;
        continue;
      }
      if (stream.stopped) return;
      if (result.done) {
        if (!(await reconnect(stream))) return;
        continue;
      }

      const value = result.value;
      stats.bytes += value.byteLength;
      stats.chunks += 1;
      const step = appendBytes(stream.leftover, value);
      stream.leftover = step.leftover;
      if (step.samples.length > 0) {
        stream.pending.push(step.samples);
        stream.pendingFrames += step.samples.length / STREAM_CHANNELS;
      }
      if (!stream.started && stream.pendingFrames >= PREBUFFER_FRAMES) beginPlayback(stream);
      dropOldest(stream);
    }
  }

  function stopInternal(target: StreamState | null): void {
    if (target !== null) release(target);
    if (state === target) state = null;
  }

  return {
    id: 'stream',
    get stats() {
      return stats;
    },

    async start(context, destination) {
      // Defensive: never leave two stream loops running.
      const current = ++generation;
      stopInternal(state);
      stats.bytes = 0;
      stats.chunks = 0;

      const stream: StreamState = {
        context,
        destination,
        abort: new AbortController(),
        pending: [],
        pendingFrames: 0,
        leftover: new Uint8Array(0),
        nextStartTime: 0,
        scheduled: new Set(),
        reader: null,
        timer: null,
        started: false,
        stopped: false,
        resolveStarted: null,
      };
      state = stream;

      try {
        await connect(stream);
      } catch (error) {
        stopInternal(stream);
        if (current !== generation || isAbortError(error)) return; // stopped meanwhile
        const message = describeError(error);
        onError(message);
        throw new Error(message);
      }
      if (current !== generation || stream.stopped) {
        stopInternal(stream);
        return;
      }

      stream.timer = setInterval(() => pump(stream), PUMP_INTERVAL_MS);

      const started = new Promise<void>((resolve) => {
        stream.resolveStarted = resolve;
      });
      const timeout = setTimeout(() => beginPlayback(stream), START_TIMEOUT_MS);
      // Read in the background for as long as the source is active; start()
      // resolves once playback has actually begun (or after the timeout).
      void readLoop(stream).catch((error: unknown) => {
        if (stream.stopped) return;
        const message = `stream failed: ${describeError(error)}`;
        onError(message);
        if (state === stream) state = null;
        release(stream);
      });

      try {
        await started;
      } finally {
        clearTimeout(timeout);
      }
    },

    stop() {
      generation += 1;
      stopInternal(state);
    },
  };
}

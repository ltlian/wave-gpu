/**
 * Cross-runtime constants shared by the browser app and the dev-server audio
 * endpoints. Keeping them here is what guarantees that the client schedules
 * exactly the chunk shape the server produces.
 */

/** Producer rate for the synthesized loop and the raw PCM stream. */
export const SAMPLE_RATE = 48_000;
/** Length of one loop of the synthesized track. */
export const TRACK_SECONDS = 12;
export const TRACK_FRAMES = SAMPLE_RATE * TRACK_SECONDS;
export const TRACK_BPM = 100;

/** Raw stream format: one chunk is 20 ms of interleaved stereo f32le. */
export const STREAM_CHUNK_FRAMES = 960;
export const STREAM_INTERVAL_MS = 20;

/** Size of the mono frame handed to the visualizer each animation frame. */
export const FRAME_SAMPLES = 2048;

/** Capacity of the worklet capture ring (power of two). */
export const TAP_CAPACITY = 32_768;

/** Bytes in a canonical 16-bit PCM WAV header. */
export const WAV_HEADER_BYTES = 44;

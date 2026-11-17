/**
 * The two audio sources the demo ships with.
 *
 * The page's track is a real, bundled MP3 — the `element`, `decode` and `file`
 * entry points read it. The raw-PCM `stream` entry plays a short synthesized
 * loop instead: streaming the whole track as headerless f32 samples would be
 * roughly 80 MB (209 s × 48 kHz × 2 ch × 4 B), which is exactly the trade-off
 * that entry point demonstrates.
 */

import { TRACK_SECONDS } from '../../shared/audio.ts';

/** Bundled demo track, copied into `dist/` by Vite from `public/`. */
export const TRACK_URL = '/audio/track.mp3';

const TRACK_FILE = TRACK_URL.split('/').at(-1) ?? TRACK_URL;

/** Readout label for the bundled track. */
export const TRACK_LABEL = `demo · ${TRACK_FILE}`;
/** Readout label for the stream entry's synthesized loop. */
export const STREAM_LOOP_LABEL = `synth loop · ${TRACK_SECONDS} s`;

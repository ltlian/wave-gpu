/**
 * Writes the synthesized loop into `dist/` as plain files.
 *
 * Locally the track is rendered in-process by the Vite audio plugin
 * (`server/audio-plugin.ts`); a deployed site has no server process, so the
 * build renders the same deterministic samples once and ships them as assets:
 *
 *   dist/audio/track.wav   encoded 16-bit PCM loop        → GET /audio/track.wav
 *   dist/stream/pcm        interleaved f32le samples      → GET /stream/pcm
 *   dist/api/meta          the loop's JSON description    → GET /api/meta
 *
 * `GET /stream/pcm` is therefore a *finite* file in production. The client paces
 * its own reads and re-fetches when the body ends (src/audio/sources/stream-source.ts),
 * so the same code keeps working against the dev server's real-time paced stream.
 *
 * Run by `npm run build` after `vite build`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getAudioAssets } from '../server/assets.ts';

const DIST = join(import.meta.dirname, '..', 'dist');

const { meta, wav, pcm } = getAudioAssets();

await Promise.all([
  mkdir(join(DIST, 'audio'), { recursive: true }),
  mkdir(join(DIST, 'stream'), { recursive: true }),
  mkdir(join(DIST, 'api'), { recursive: true }),
]);
await Promise.all([
  writeFile(join(DIST, 'audio', 'track.wav'), wav),
  writeFile(join(DIST, 'stream', 'pcm'), pcm),
  writeFile(join(DIST, 'api', 'meta'), `${JSON.stringify(meta)}\n`),
]);

console.log(
  `build-audio: ${meta.durationSeconds}s loop @ ${meta.sampleRate} Hz → ` +
    `dist/audio/track.wav (${wav.length} B), dist/stream/pcm (${pcm.length} B)`,
);

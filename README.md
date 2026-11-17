# wave-gpu

**Play audio in the browser, read the same samples, and draw them with WebGPU.**

A small, dependency-light project: play audio in the browser while also getting at the stream, to
drive something visual. Four ways of getting audio into the Web Audio graph — an `<audio>` element,
a fully decoded buffer, raw PCM streamed from a server (a Vite plugin in dev, a static file when
deployed), and a local file you drop in — all feed the same tap, which feeds a WebGPU waveform.

The page's track is a real MP3 bundled with the site, played by the `element` and `decode` entries.
The raw-PCM `stream` entry plays a short synthesized loop instead: streaming the whole song as
headerless f32 samples would be ~80 MB, which is exactly the trade-off that entry demonstrates.

The design has three independent layers, and this repo keeps them separate:

```
ingest (playback)  →  tap (read)  →  consume (WebGPU)
```

- **Four entry points** — an `<audio>` element and a fully decoded `AudioBuffer` (both on the
  bundled MP3), raw PCM streamed as a synthesized 12 s loop, and a local file you drop or pick.
  Switch between them while audio plays.
- **Two read paths** — an `AnalyserNode` (easy, windowed) and an `AudioWorklet` (exact contiguous
  frames) publishing through a `SharedArrayBuffer` ring.
- **One GPU consumer** — a 2048-sample frame → compute pass → fragment-shader waveform, with a
  Canvas2D fallback and a display-only auto-gain so quiet, bass-heavy audio still looks alive.

The point is the seams: every entry point feeds the same gain node, so either tap works with all
of them, and swapping the consumer never touches the audio code.

![wave-gpu running: WebGPU waveform, the bundled track playing through the element entry point, SAB ring live](docs/demo.png)

## Run it

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

Click **Start**, then switch **entry point** and **read path** while it plays. Drop an audio file
anywhere on the page (or use **Load file…**) to play your own track. The live readout shows the
entry point, which track it is playing, both taps' RMS/peak, the context rate/latency, whether the
shared ring is active, the GPU backend and the display gain.

```bash
npm test           # node:test — pure logic: synth, PCM chunking, display gain
npm run typecheck  # tsc for the browser app and for the Node/dev-server side
npm run build      # typecheck + production bundle
npm run preview    # http://127.0.0.1:5174 — same demo from the built assets
```

The dynamic endpoints (`/api/meta`, `/stream/pcm`) are served by a tiny Vite plugin in
[`server/audio-plugin.ts`](server/audio-plugin.ts), so the dev server is the only process you need.
The same plugin runs for `vite preview`. The bundled track is a plain static file in
[`public/audio/`](public/audio/), so Vite serves it in dev and the built site serves it from `dist/`.

## Deploy

The built site is plain static files, deployed as a Cloudflare Worker with static assets (no
Worker script, no Pages project): <https://wave.ltlian.com>.

```bash
npm run deploy     # runs `wrangler deploy`, which builds first (see wrangler.jsonc)
```

Pushing to `main` deploys automatically: [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
runs the tests and then `wrangler deploy`, using the `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` repository secrets.

Two details make a static host enough:

- [`scripts/build-audio.ts`](scripts/build-audio.ts) runs after `vite build` and renders the stream
  loop once into `dist/`: `stream/pcm` (the interleaved f32le samples) and `api/meta`. The synth is
  shared with the dev server. The MP3 is copied by Vite from `public/`.
- [`public/_headers`](public/_headers) sets the COOP/COEP/CORP isolation headers on every asset,
  which is what gives the deployed page a real `SharedArrayBuffer` ring.

Because `/stream/pcm` is a finite file in production, the client paces its own reads and re-fetches
when the body ends ([`src/audio/sources/stream-source.ts`](src/audio/sources/stream-source.ts)) —
the same code path that consumes the dev server's real-time paced stream. That also keeps the
deployment free of any per-request compute: every request is served by Cloudflare's asset layer.

## What to look at first

| If you want to understand… | Read |
|---|---|
| how playing and reading stay independent | [`src/types.ts`](src/types.ts) and [`src/main.ts`](src/main.ts) |
| how audio gets into the graph | [`src/audio/sources/`](src/audio/sources/) |
| how a dropped file becomes audio | [`src/audio/sources/file-source.ts`](src/audio/sources/file-source.ts) + [`src/ui/file-drop.ts`](src/ui/file-drop.ts) |
| how the live stream is tapped | [`src/audio/taps/`](src/audio/taps/) and [`src/audio/worklet/capture-worklet.ts`](src/audio/worklet/capture-worklet.ts) |
| how samples become pixels | [`src/gpu/webgpu.ts`](src/gpu/webgpu.ts) + [`src/gpu/shaders.ts`](src/gpu/shaders.ts) |
| which audio the demo ships with | [`src/audio/tracks.ts`](src/audio/tracks.ts) |
| how the demo server works | [`server/`](server/) — deterministic synth, stream endpoints |

Longer write-ups:

- [`docs/architecture.md`](docs/architecture.md) — layers, runtime flow, SAB ring layout, stream
  scheduling, the Vite/AudioWorklet bundling trick, how to extend it.
- [`docs/browser-audio.md`](docs/browser-audio.md) — the browser API map: entry points, read
  paths, WebGPU feed options, streaming trade-offs, gotchas.

## Notes on the implementation

- The page's track is a **bundled MP3** (`public/audio/track.mp3`, 3:29, 48 kHz). The raw-PCM
  `stream` entry instead plays a **synthesized 12 s loop** (100 BPM, Am–F–C–G–Em, rendered
  deterministically by `server/synth.ts`): streaming the whole song as headerless f32 samples would
  be ~80 MB, which is the trade-off that entry point exists to show. The readout's `track` row says
  which one is playing.
- **Local files are never parsed by this code.** A dropped/picked `File` becomes a same-origin
  `blob:` URL and goes through the browser's normal `<audio>` pipeline, then
  `MediaElementAudioSourceNode`. That is format-agnostic by design: MP3, AAC/M4A, Ogg/Opus, FLAC,
  WAV… work if the browser decodes them. No `decodeAudioData`, no full-file allocation in JS, and
  long files stream straight from disk. (The `decode` entry point deliberately shows the other
  approach: whole file → `AudioBuffer` → PCM access.)
- The worklet is TypeScript bundled by Vite via `?worker&url`:
  `import workletUrl from './worklet/capture-worklet.ts?worker&url'`. A plain `?url` import would
  inline raw TypeScript into a data: URL in production and fail to load as a worklet.
- Cross-origin isolation (`COOP: same-origin` + `COEP: require-corp`) is set by the plugin in dev
  and by [`public/_headers`](public/_headers) when deployed, so the page gets a real
  `SharedArrayBuffer`; without it the worklet falls back to `postMessage`.
- The page has a small read-only probe for debugging and automation:
  `window.__wave.probe()` returns context, both taps, stream and GPU state. `window.__wave.start('stream')`
  etc. drive it programmatically (after a real user gesture has unlocked audio, or in a headless
  automation context).

## Verification

Verified in Chrome 157 in the host browser, over the dev server **and** the production build:
`webgpu` backend active with no shader errors, 60 fps, `crossOriginIsolated` + a real
`SharedArrayBuffer` ring, all four entry points audible/visible (the MP3 for `element` and `decode`,
the synth loop for `stream`), both read paths showing live RMS/peak, zero console errors or
exceptions. Local-file playback was exercised through both the drop handler and the picker path
with **WAV** (48 kHz) and **MP3** (44.1 kHz); unsupported files surface a clean error. The host
`AudioContext` came up at 44100 Hz while the loop is produced at 48 kHz — a nice live demonstration
of the resampling path in `docs/browser-audio.md`.
The deployed site was verified the same way: `wave.ltlian.com` served with `crossOriginIsolated`
and a live SAB ring, `webgpu` backend, 60 fps, the MP3 playing through `element` and `decode`, and
the `stream` entry point looping across the 12 s file boundary with no console errors.

`npm test` (29 tests) covers the pure logic: synth determinism, PCM chunking, display gain. The browser/GPU pipeline is verified manually rather than unit-tested.

## License

MIT — see [LICENSE](LICENSE). The bundled demo track (`public/audio/track.mp3`) was generated with
YuE2 and is excluded from that licence; see [CREDITS.md](CREDITS.md) for its provenance and terms.

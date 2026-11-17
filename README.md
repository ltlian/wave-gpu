# wave-gpu

**Play audio in the browser, read the same samples, and draw them with WebGPU.**

A small, dependency-light worked example of a question that comes up whenever you want audio to
drive something visual: *how do I play audio in the browser while also getting at the stream?*

The answer has three independent layers, and this repo keeps them separate:

```
ingest (playback)  →  tap (read)  →  consume (WebGPU)
```

- **Three entry points** — an `<audio>` element, a fully decoded `AudioBuffer`, and raw PCM streamed
  from the dev server. Switch between them while audio plays.
- **Two read paths** — an `AnalyserNode` (easy, windowed) and an `AudioWorklet` (exact contiguous
  frames) publishing through a `SharedArrayBuffer` ring.
- **One GPU consumer** — a 2048-sample frame → compute pass → fragment-shader waveform, with a
  Canvas2D fallback and a display-only auto-gain so quiet, bass-heavy audio still looks alive.

The point is the seams: every entry point feeds the same gain node, so either tap works with all
three, and swapping the consumer never touches the audio code.

![wave-gpu running: WebGPU waveform, stream entry point, SAB ring active](docs/demo.png)

## Run it

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

Click **Start**, then switch **entry point** and **read path** while it plays. The live readout
shows both taps' RMS/peak, the context rate/latency, whether the shared ring is active, the GPU
backend and the display gain.

```bash
npm test           # node:test — pure logic: synth, WAV encoding, PCM chunking, display gain
npm run typecheck  # tsc for the browser app and for the Node/dev-server side
npm run build      # typecheck + production bundle
npm run preview    # http://127.0.0.1:5174 — same demo from the built assets
```

The audio endpoints (`/api/meta`, `/audio/track.wav`, `/stream/pcm`) are served by a tiny Vite
plugin in [`server/audio-plugin.ts`](server/audio-plugin.ts), so the dev server is the only
process you need. The same plugin runs for `vite preview`.

## What to look at first

| If you want to understand… | Read |
|---|---|
| how playing and reading stay independent | [`src/types.ts`](src/types.ts) and [`src/main.ts`](src/main.ts) |
| how audio gets into the graph | [`src/audio/sources/`](src/audio/sources/) |
| how the live stream is tapped | [`src/audio/taps/`](src/audio/taps/) and [`src/audio/worklet/capture-worklet.ts`](src/audio/worklet/capture-worklet.ts) |
| how samples become pixels | [`src/gpu/webgpu.ts`](src/gpu/webgpu.ts) + [`src/gpu/shaders.ts`](src/gpu/shaders.ts) |
| how the demo server works | [`server/`](server/) — deterministic synth, WAV encoder, stream endpoints |

Longer write-ups:

- [`docs/architecture.md`](docs/architecture.md) — layers, runtime flow, SAB ring layout, stream
  scheduling, the Vite/AudioWorklet bundling trick, how to extend it.
- [`docs/browser-audio.md`](docs/browser-audio.md) — the browser API map: entry points, read
  paths, WebGPU feed options, streaming trade-offs, gotchas.

## Notes on the implementation

- The track is **synthesized deterministically at server startup** (100 BPM, 12 s, Am–F–C–G–Em)
  and encoded to 16-bit PCM WAV by hand — no audio files in the repo, byte-identical on every run.
  The same float samples feed the raw PCM stream, so what you see is exactly what you hear.
- The worklet is TypeScript bundled by Vite via `?worker&url`:
  `import workletUrl from './worklet/capture-worklet.ts?worker&url'`. A plain `?url` import would
  inline raw TypeScript into a data: URL in production and fail to load as a worklet.
- Cross-origin isolation (`COOP: same-origin` + `COEP: require-corp`) is set by the plugin so the
  page gets a real `SharedArrayBuffer`; without it the worklet falls back to `postMessage`.
- The page has a small read-only probe for debugging and automation:
  `window.__wave.probe()` returns context, both taps, stream and GPU state. `window.__wave.start('stream')`
  etc. drive it programmatically (after a real user gesture has unlocked audio, or in a headless
  automation context).

## Status

Exploration-grade, intentionally small, no runtime dependencies, no production hardening.

Verified in Chrome 157 in the host browser, over the dev server **and** the production build:
`webgpu` backend active with no shader errors, 60 fps, `crossOriginIsolated` + a real
`SharedArrayBuffer` ring, all three entry points audible/visible, both read paths showing live
RMS/peak, zero console errors or exceptions. The host `AudioContext` came up at 44100 Hz while the
source is 48 kHz — a nice live demonstration of the resampling path in `docs/browser-audio.md`.
`npm test` (34 tests) covers the pure logic: synth determinism, WAV encoding, PCM chunking, display
gain. The browser/GPU pipeline is verified manually rather than unit-tested.

## License

No license file yet — treat it as a personal exploration unless one is added.

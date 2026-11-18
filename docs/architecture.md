# Architecture

The code is organised around one idea:

> **Playing audio and reading audio are separate concerns.**
> The browser's Web Audio graph is the meeting point: any *ingest* path connects to the same
> gain node, any *tap* reads that gain node, and any *consumer* can use the samples.

Keeping those three layers independent is what makes the example easy to read, test and extend.
Nothing in `src/audio/sources/` knows that WebGPU exists; nothing in `src/gpu/` knows whether the
samples came from an `<audio>` element, a decoded buffer, or a network stream.

## Layers

```
                    ┌─────────────────────────── src/audio/ ───────────────────────────┐
 entry point        │  sources/element-source.ts   <audio> + MediaElementAudioSourceNode │
 (ingest)           │  sources/decoded-buffer-source.ts  fetch + decodeAudioData → loop  │
                    │  sources/stream-source.ts    fetch raw f32le + schedule buffers   │
                    │  sources/file-source.ts      dropped file → blob: URL → <audio>   │
                    └───────────────────────────────┬──────────────────────────────────┘
                                                    │ source → masterGain (0.35) → outputGain → destination
                                                    ▼
                    ┌─────────────────────────── src/audio/ ───────────────────────────┐
 read path (tap)    │  taps/analyser-tap.ts   AnalyserNode, latest 2048-frame window     │
                    │  taps/worklet-tap.ts    AudioWorklet → SAB ring / postMessage      │
                    └───────────────────────────────┬──────────────────────────────────┘
                                                    │ readFrame(out: Float32Array)
                                                    ▼
                    ┌─────────────────────────── src/gpu/ ─────────────────────────────┐
 consumer           │  webgpu.ts   compute pass: 256 columns → min/max/centre/rms       │
                    │  canvas2d.ts  same picture, drawn with Canvas2D paths              │
│  svg.ts       same picture, as two retained-mode SVG paths                             │
                    └─────────────────────────────────────────────────────────────────┘
```

`src/main.ts` is the only file that constructs all three layers: it builds the engine and the
visualizer, wires the UI, and assembles the readout snapshot. `src/render-loop.ts` drives them
through the `AudioEngine` and `Visualizer` interfaces and owns the `requestAnimationFrame` loop and
its play/visibility gating; the pipeline trace and accents are separate DOM-only modules.
`src/ui/pipeline-trace.ts` is the only file that knows the three columns form a path: it measures the
selected chips, writes the SVG trace between them, and carries it up into the stage's bottom frame,
reading the selection back from the buttons.
`src/types.ts` holds the contracts that keep the layers honest:

| Interface | Responsibility |
|---|---|
| `AudioSource` | one ingest implementation: `start(ctx, destination)`, `stop()`, optional network stats |
| `SampleTap` | one read implementation: `attach(master, destination)`, `read(out)`, live rms/peak/blocks |
| `AudioEngine` | owns the context, master gain, output gain, sources and taps; switches entry points; pause/resume/mute |
| `Visualizer` | draws a frame of samples; reports backend, errors, frames, display gain |

## Runtime flow

1. **Nothing is created until a user gesture.** `main.ts` calls `engine.start(entry)` from the
   Play button. `ensureContext()` creates the `AudioContext` (interactive latency hint), the
   master gain, the output gain (0 by default), both taps, and resumes the context.
2. **The engine starts one source.** `element`, `decode`, `stream` or `file` — each owns its own
   resources. Sources connect to `masterGain`; switching stops the previous source first.
3. **Both taps sit on `masterGain`, always, before the output gain.** The analyser branch is
   passive. The worklet tap reads through a silent `GainNode(0)` → `destination` so the graph keeps
   pulling it. `outputGain` after the taps starts at 0; the speaker control next to Play ramps it
   to 1, so audio is opt-in while the visualization runs either way.
4. **While audio plays and the stage is on screen**, `render-loop.ts` runs an animation frame loop
   that calls `engine.readFrame(buffer)` (active tap), computes raw RMS/peak, and calls
   `visualizer.render(buffer, meta)`. When paused, or when the stage is scrolled out of view, the
   loop stops; a single static idle frame is drawn at startup, on resize and after a paused backend
   switch so the canvas is never blank.
5. **The visualizer** applies display-only auto-gain (to a copy), then hands the frame to the
   selected backend. WebGPU uploads 2048 floats to a storage buffer, runs a compute pass that
   reduces them to 256 columns, and draws a fullscreen triangle with a fragment shader; Canvas2D
   buckets the samples into columns and fills a gradient envelope with paths; SVG updates two
   retained-mode paths on a sibling `<svg>` element. The dark backdrop, halo, grid and centre line
   are painted once per resize into a cached canvas under both of those backends; WebGPU keeps its
   own in-shader backdrop because its canvas is opaque.
6. **The UI** is refreshed at ~10 Hz from the same engine/visualizer state. Errors from any layer
   go to the error strip (and the `window.__wave` probe). The pipeline panel is the exception: its
   accents are driven from the render loop, which writes one CSS custom property (`--level`) that
   the selected chips and the trace read for glow (60 Hz desktop, 30 Hz mobile), so the panel
   follows the audio rather than the 10 Hz readout.
7. **The renderer column** switches the visualizer between WebGPU, Canvas2D and SVG while it runs.
   Only the drawing changes: the audio graph, tap selection and readout are untouched. Canvas
   backends share one `<canvas>`; because a canvas cannot change context type once it has handed one
   out, a switch swaps in an identical element (`cloneNode`, which copies the backing-store size).
   SVG mounts a sibling `<svg>` and hides the canvas instead. The WebGPU chip is disabled, with the
   failure reason as its tooltip, when the startup attempt failed.

## Interesting details

### The SAB ring (worklet tap)

`capture-worklet.ts` runs on the audio thread and receives 128-frame quanta. It writes a mono
mix into a `SharedArrayBuffer` ring:

```
byte 0..7   Int32Array control   control[0] = monotonic uint32 write counter
byte 8..    Float32Array ring    sample index = counter & (capacity - 1)
```

Samples are written first; `Atomics.store(control, 0, counter)` publishes them afterwards, so the
main thread can `Atomics.load` the counter and read a consistent window without locks. When the
page is not cross-origin isolated (`COOP`+`COEP` absent), `SharedArrayBuffer` is unavailable and
the worklet falls back to transferring a mono `Float32Array` over `postMessage` ~47 times a second.

### Stream scheduling (`stream-source.ts`)

`/stream/pcm` is raw, headerless PCM: interleaved stereo `f32le`, 48 kHz, 20 ms chunks (a
synthesized 12 s loop — see above). The client
does not trust fetch chunk boundaries — it keeps leftover bytes and only decodes whole 8-byte
stereo frames. Playback is scheduled as small `AudioBuffer`s (created with `sampleRate: 48000`)
against `ctx.currentTime`, with a ~0.25 s prebuffer and ~0.2 s lookahead. If the playhead overtakes
the queue, the scheduler jumps forward instead of stacking up old buffers.

The producer is allowed to be either real-time paced (the dev server writes one 20 ms chunk per
20 ms) or much faster (the deployed site serves the loop as a static file), so the source paces its
own *reads*: it pulls bytes only while fewer than ~2 s are queued and lets the scheduler drain the
queue before pulling more. A single `read()` can return far more than that — the browser buffers a
static file while the read loop waits — and the overshoot is kept rather than dropped. When the
body ends the source re-fetches it, which is seamless because a couple of seconds of audio are
still queued.

### Local files (`file-source.ts`)

A dropped or picked file is wrapped in a same-origin `blob:` URL and fed to the same
`<audio>` → `MediaElementAudioSourceNode` path as the `element` entry point. The browser's media
stack does the demuxing and decoding, so **no format-specific code exists here** and MP3, AAC/M4A,
Ogg/Opus, FLAC and WAV all take the identical route. The source waits for `loadedmetadata` to learn
the duration (shown in the readout), reuses one element across loads, and revokes the previous
object URL when it is replaced. Long files stream from disk; nothing is decoded into JS memory.
The drop/picker wiring (document-level `dragenter`/`dragover`/`drop`, a hidden file input, and the
drag-over stage state) lives in `src/ui/file-drop.ts`.

### The producer (`server/`)

The page's track is a bundled MP3 served as a static file; [`src/audio/tracks.ts`](../src/audio/tracks.ts)
points the `element` and `decode` sources at it. The `stream` entry deliberately does not use it:
raw f32 samples of the 3:29 track would be ~80 MB, so that entry plays a short synthesized loop
instead — the same 12 s, 100 BPM, Am–F–C–G–Em piece, rendered by `server/synth.ts`.

For that loop the dev server is a small Vite plugin, not a second process: it synthesizes the loop
at startup, interleaves the floats for `/stream/pcm`, and sets the isolation headers. Everything is
rendered once per process and cached.

A deployed site has no process, so `scripts/build-audio.ts` renders the same loop at build time and
writes `stream/pcm` and `api/meta` into `dist/`; the MP3 is copied there by Vite from `public/`, and
`public/_headers` supplies the isolation headers that the plugin sets in dev. The result is a
purely static deployment — see the Deployment section of the README.

### Display gain is presentation only

The raw mono frames are quiet (master gain 0.35, and a typical 8-sample column of a bass-heavy
mix does not reach full scale), so drawing them directly gives a thin lens shape. `gpu/visualizer.ts`
therefore applies a **display-only** two-stage normalisation to its internal copy:

1. `display-gain.ts` tracks a rolling sample peak (fast attack / slow decay, floor ~0.045, max 20×)
   and scales the copy into ±1 for the GPU upload;
2. a second, slower tracker follows the loudest *column excursion* so the drawn envelope fills the
   canvas.

Raw sample values, the RMS/peak readout and `window.__wave.probe()` are never affected; the applied
gain is surfaced in the readout. Idle preview frames (before first playback) use a fixed pleasing
level instead.

### WebGPU initialisation is time-bounded

`webgpu.ts` reports every failure and returns `null`, which is what lets `visualizer.ts` swap in the
Canvas2D backend. One failure mode needs extra care: a browser whose GPU stack is wedged can leave
`requestAdapter()`/`requestDevice()` pending forever instead of resolving or rejecting, and the
page then waits on a black canvas with no error. Each awaited initialisation call is therefore
wrapped in `awaitWithin()` (5 s): on timeout it reports why and the Canvas2D fallback takes over.
The error strip is mirrored to the console (`ui/errors.ts`), so the reason is visible in DevTools.
A failed attempt also disables the WebGPU option in the renderer control, with the same reason as
its tooltip.

### AudioWorklet in a Vite build

The worklet is TypeScript, loaded with:

```ts
import workletUrl from './worklet/capture-worklet.ts?worker&url';
await ctx.audioWorklet.addModule(workletUrl);
```

`?worker&url` is the Vite-supported path that bundles and emits a real JS asset in production.
(A plain `?url` import of a `.ts` file gets inlined as a data: URL containing raw TypeScript in
the production build — audio worklets cannot load that.)

## Performance tiers

`src/quality.ts` chooses one of two tiers: `low` on coarse pointers or devices reporting four or
fewer cores, `high` otherwise. `?quality=low` / `?quality=high` overrides the detection so the
tradeoff can be compared on one device.

| | high | low |
| --- | --- | --- |
| render loop | 60 fps | 30 fps (with a tolerance so 60 Hz vsync cannot silently drop it to 20) |
| backing store | DPR 2 | DPR 1 |
| Canvas2D columns / glow | 256 / `shadowBlur` | 128 / none |
| SVG columns / glow | 64 / drop-shadow | 32 / none |
| pipeline accents | 60 Hz | 30 Hz, second trace pulse hidden |

The loop does no work while paused or while the stage is off screen; the stage also has a cached
backdrop so a frame only clears the canvas and draws the waveform. The mobile tier is intentionally
a visible quality drop — this is a worked example, not a visual showcase.


## File map

| Path | What it is |
|---|---|
| `src/main.ts` | wiring and readout assembly |
| `src/render-loop.ts` | rAF loop, play/visibility gating, static idle frame |
| `src/types.ts` | the layer contracts |
| `src/audio/engine.ts` | AudioContext, master gain, source switching, pause/resume |
| `src/audio/sources/*.ts` | the four entry points (element, decode, stream, file) |
| `src/audio/taps/*.ts` | `AnalyserNode` tap and `AudioWorklet` tap |
| `src/audio/worklet/capture-worklet.ts` | audio-thread processor, SAB ring, stats |
| `src/audio/pcm.ts` | pure interleaved-f32 chunk helpers (unit-tested) |
| `src/quality.ts` | high/low tier selection and the numbers each tier uses |
| `src/gpu/stage-backdrop.ts` | cached backdrop, halo, grid and centre line for Canvas2D/SVG |
| `src/gpu/envelope.ts` | shared per-column amplitude summary for Canvas2D/SVG |
| `src/gpu/visualizer.ts` | backend selection + runtime switching, errors, display gain |
| `src/gpu/webgpu.ts`, `shaders.ts` | compute + render pipeline, WGSL |
| `src/gpu/canvas2d.ts` | Canvas2D renderer (fallback / selectable) |
| `src/gpu/svg.ts` | SVG/DOM renderer (third selectable consumer) |
| `src/gpu/display-gain.ts` | pure rolling-peak normalisation (unit-tested) |
| `src/ui/*.ts` | controls, trace/accents, readout, error strip, file drop/picker (DOM only) |
| `server/audio-plugin.ts` | Vite middleware + audio endpoints |
| `server/synth.ts`, `assets.ts` | deterministic loop, cached assets |
| `src/audio/tracks.ts` | the bundled MP3 and the stream loop's labels |
| `public/audio/track.mp3` | the bundled demo track (not MIT — see [CREDITS.md](../CREDITS.md)) |
| `shared/audio.ts` | constants shared by browser and server |

## Extending it

- **Another ingest path** (mic, WebCodecs, MSE): implement `AudioSource`, register it in
  `engine.ts` and give the UI a button. Nothing else changes.
- **Another read path** (recording, FFT feature extractor): implement `SampleTap` and add it to
  the engine's tap registry.
- **Another consumer** (spectrogram texture, particles, oscilloscope): implement `Visualizer`,
  or call `engine.readFrame()` from your own loop.

## Deliberate non-goals

No production hardening, no codec handling (the stream is raw PCM), no seeking/gapless playback,
no mobile layout work, no unit tests for browser APIs (tests cover the pure logic; the browser
pipeline is verified manually in a browser).

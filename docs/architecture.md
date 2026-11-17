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
                                                    │ source → masterGain (0.35)
                                                    ▼
                    ┌─────────────────────────── src/audio/ ───────────────────────────┐
 read path (tap)    │  taps/analyser-tap.ts   AnalyserNode, latest 2048-frame window     │
                    │  taps/worklet-tap.ts    AudioWorklet → SAB ring / postMessage      │
                    └───────────────────────────────┬──────────────────────────────────┘
                                                    │ readFrame(out: Float32Array)
                                                    ▼
                    ┌─────────────────────────── src/gpu/ ─────────────────────────────┐
 consumer           │  webgpu.ts   compute pass: 256 columns → min/max/centre/rms       │
                    │  canvas2d.ts fallback if WebGPU is unavailable                     │
                    └─────────────────────────────────────────────────────────────────┘
```

`src/main.ts` is the only file that knows about all three layers. It builds the engine and the
visualizer, wires the UI, runs a `requestAnimationFrame` loop, and assembles the readout snapshot.
`src/types.ts` holds the contracts that keep the layers honest:

| Interface | Responsibility |
|---|---|
| `AudioSource` | one ingest implementation: `start(ctx, destination)`, `stop()`, optional network stats |
| `SampleTap` | one read implementation: `attach(master, destination)`, `read(out)`, live rms/peak/blocks |
| `AudioEngine` | owns the context + master gain + sources + taps; switches entry points; pause/resume |
| `Visualizer` | draws a frame of samples; reports backend, errors, frames, display gain |

## Runtime flow

1. **Nothing is created until a user gesture.** `main.ts` calls `engine.start(entry)` from the
   Start button. `ensureContext()` creates the `AudioContext` (interactive latency hint), the
   master gain, both taps, and resumes the context.
2. **The engine starts one source.** `element`, `decode`, `stream` or `file` — each owns its own
   resources. Sources connect to `masterGain`; switching stops the previous source first.
3. **Both taps sit on `masterGain`, always.** The analyser branch is passive. The worklet tap
   reads through a silent `GainNode(0)` → `destination` so the graph keeps pulling it.
4. **Each animation frame**, `main.ts` calls `engine.readFrame(buffer)` (active tap), computes raw
   RMS/peak, and calls `visualizer.render(buffer, meta)`. If no audio is flowing, an idle preview
   supplies a synthetic frame — the canvas never goes black.
5. **The visualizer** applies display-only auto-gain (to a copy), uploads 2048 floats to a GPU
   storage buffer, runs a compute pass that reduces them to 256 columns, then draws a fullscreen
   triangle with a fragment shader that reads those columns.
6. **The UI** is refreshed at ~10 Hz from the same engine/visualizer state. Errors from any layer
   go to the error strip (and the `window.__wave` probe).

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

`/stream/pcm` is raw, headerless PCM: interleaved stereo `f32le`, 48 kHz, 20 ms chunks. The client
does not trust fetch chunk boundaries — it keeps leftover bytes and only decodes whole 8-byte
stereo frames. Playback is scheduled as small `AudioBuffer`s (created with `sampleRate: 48000`)
against `ctx.currentTime`, with a ~0.25 s prebuffer and ~0.2 s lookahead. If the playhead overtakes
the queue, the scheduler jumps forward instead of stacking up old buffers.

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

The dev server is a small Vite plugin, not a second process. It synthesizes a deterministic 12 s
loop (100 BPM, Am–F–C–G–Em) at startup, encodes it as 16-bit PCM WAV for `/audio/track.wav`, and
interleaves the same floats for `/stream/pcm`. It also sets the isolation headers. Everything is
rendered once per process and cached.

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

### AudioWorklet in a Vite build

The worklet is TypeScript, loaded with:

```ts
import workletUrl from './worklet/capture-worklet.ts?worker&url';
await ctx.audioWorklet.addModule(workletUrl);
```

`?worker&url` is the Vite-supported path that bundles and emits a real JS asset in production.
(A plain `?url` import of a `.ts` file gets inlined as a data: URL containing raw TypeScript in
the production build — audio worklets cannot load that.)

## File map

| Path | What it is |
|---|---|
| `src/main.ts` | wiring, rAF loop, readout assembly, idle preview fallback |
| `src/types.ts` | the layer contracts |
| `src/audio/engine.ts` | AudioContext, master gain, source switching, pause/resume |
| `src/audio/sources/*.ts` | the four entry points (element, decode, stream, file) |
| `src/audio/taps/*.ts` | `AnalyserNode` tap and `AudioWorklet` tap |
| `src/audio/worklet/capture-worklet.ts` | audio-thread processor, SAB ring, stats |
| `src/audio/pcm.ts` | pure interleaved-f32 chunk helpers (unit-tested) |
| `src/gpu/visualizer.ts` | backend selection, errors, display gain |
| `src/gpu/webgpu.ts`, `shaders.ts` | compute + render pipeline, WGSL |
| `src/gpu/canvas2d.ts` | fallback renderer |
| `src/gpu/display-gain.ts` | pure rolling-peak normalisation (unit-tested) |
| `src/ui/*.ts` | controls, readout, error strip, file drop/picker (DOM only) |
| `server/audio-plugin.ts` | Vite middleware + audio endpoints |
| `server/synth.ts`, `wav.ts`, `assets.ts` | deterministic track, WAV encoder, cached assets |
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
pipeline is verified manually — see the README).

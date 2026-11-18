# Browser audio: playing it *and* reading it

A condensed map of the browser APIs this project uses, and of the alternatives you would consider
for a similar experiment.

## The three layers

1. **Ingest / playback** — where the audio comes from.
2. **Tap / read** — how you get at the samples while it plays.
3. **Consume** — what you do with them (here: WebGPU, Canvas2D or SVG).

The layers are independent. A tap reads whatever arrives at a node in the Web Audio graph, so one
read path can serve every ingest path. **Streaming from a server is normal and fully supported**;
loading the whole file is optional.

## Entry points for ingest / playback

| Entry point | What you get | Best for | Main limit |
|---|---|---|---|
| `<audio src>` + `MediaElementAudioSourceNode` | browser-managed progressive HTTP + decode | playing a URL | not sample-exact; CORS rules |
| **local `File`** + a `blob:` URL → the same `<audio>` path | any file the browser can decode, streamed from disk | user-provided audio, MP3/WAV/…, large files | no format access in JS; decoder support varies |
| `fetch` + `decodeAudioData` → `AudioBufferSourceNode` | the whole file decoded to PCM in memory | "I want all samples" | must download first; memory |
| `fetch`/WebSocket/WebTransport raw PCM → scheduled buffers | you own the clock and the bytes | low latency, no decoder | you handle pacing/drift |
| Media Source Extensions (`SourceBuffer`) | segmented compressed stream into an element | long/live/adaptive (HLS/DASH) | needs segments; tap via element |
| WebCodecs `AudioDecoder` | compressed chunks → decoded `AudioData` | compressed transport *and* samples | you demux the container |
| `getUserMedia` / `MediaStreamAudioSourceNode` | mic / line-in | live input | device latency; permission |

This project implements the first three plus local files:

- `sources/element-source.ts` — `<audio>` element, `createMediaElementSource()`, `loop`, `play()`.
  The browser handles HTTP, buffering and decoding. Latency includes media buffering, so it is
  ideal for visualization but not sample-accurate. A CORS-cross-origin element tapped this way
  outputs **silence**.
- `sources/decoded-buffer-source.ts` — `fetch('/audio/track.mp3')` → `decodeAudioData()` → looping
  `AudioBufferSourceNode`. This is the simplest way to get *all* PCM (`buffer.getChannelData()`),
  at the cost of holding it in memory. `decodeAudioData` resamples to the context rate.
- `sources/stream-source.ts` — `fetch('/stream/pcm')` + `ReadableStream`, raw `f32le` interleaved
  stereo, reassembled across arbitrary chunk boundaries and scheduled as small `AudioBuffer`s
  against `ctx.currentTime`. No decoder: the bytes *are* the samples. You own pacing, prebuffering
  and drift handling.
- `sources/file-source.ts` — a user-dropped or picked `File` wrapped in a same-origin `blob:` URL,
  played through the same `<audio>` element path as above. This is **format-agnostic by design**:
  the browser's media stack demuxes and decodes whichever container/codec it supports, so an MP3
  and a WAV need no different handling in our code. Metadata (`duration`) comes from
  `loadedmetadata`; long files stream from disk. The alternative for a local file is
  `fetch`-equivalent `file.arrayBuffer()` → `decodeAudioData()` if you specifically want all the
  PCM in memory (that is what the `decode` entry point demonstrates for the bundled track).

## Ways to read the live stream

| Tap | Granularity | What you see | Cost | Sample-accurate? |
|---|---|---|---|---|
| `AnalyserNode` | polled at any rate | most recent `fftSize` frames, mono-downmixed | tiny | no |
| `AudioWorklet` | every 128-frame render quantum | exact contiguous frames in `process()` | none on the main thread | yes |
| `OfflineAudioContext` | one offline render | whole-file `AudioBuffer` | offline | offline only |
| WebCodecs `AudioData` | per decoded chunk | PCM of chunks you decoded | low | for your decode |

- `taps/analyser-tap.ts` is the easy path: `an.fftSize = 2048; an.smoothingTimeConstant = 0.8` and
  `getFloatTimeDomainData(out)`. It is a **sliding window, not a queue** — no timestamps, no
  cursor; polling faster duplicates samples, polling slower skips them. Perfect for an
  oscilloscope or RMS meter, wrong for recording.
- `taps/worklet-tap.ts` is the exact path: a processor receives 128-frame `Float32Array`s per
  channel on the audio thread. To get them out, it publishes a mono mix into a
  `SharedArrayBuffer` ring with `Atomics` (zero allocation, main thread reads whenever it likes).
  `SharedArrayBuffer` is only available in a **cross-origin isolated** page, which needs
  `COOP: same-origin` + `COEP: require-corp` — the Vite plugin sets those headers. Without them,
  the fallback transfers a `Float32Array` over `postMessage` (~47 Hz).

Why not read the analyser and call it a day? Because it gives you a window, not a stream, and it
may skip/duplicate samples. If the visualization only needs "some honest signal", the analyser is
fine; if you want a real frame of audio at 60 fps, use the worklet.

## Getting samples into WebGPU

- **Main thread → `device.queue.writeBuffer`** — 2048 floats is 8 KiB/frame, ~0.5 MB/s at 60 fps.
  Trivial; this is what `gpu/webgpu.ts` does.
- **Worker owns `navigator.gpu` + `OffscreenCanvas`** — read the SAB ring in a worker and render
  off-thread. Good when the page thread is busy; `navigator.gpu` is exposed on `WorkerNavigator`.
- **Compute-shader reduction first** — the demo reduces 2048 samples to 256 columns (min/max/
  centre/rms) in a compute pass, then the fragment shader draws from those columns.
- **Spectrogram-as-texture** — paint a 2D canvas (or OffscreenCanvas) and upload with
  `copyExternalImageToTexture` when the data is naturally image-like.
- **The `AudioWorklet` cannot touch WebGPU.** Its global scope has no `navigator` (only
  `registerProcessor`, `currentFrame`, `currentTime`, `sampleRate`, `port`), and GPU work on the
  real-time audio thread would be a hazard anyway. Shared memory to a window/worker is the right
  boundary.

## Streaming from a server: the trade-offs

| Path | Latency | Seek | Gapless | Sample access | Bandwidth (stereo) | Effort |
|---|---|---|---|---|---|---|
| progressive MP3/AAC via `<audio src>` | buffered (100s of ms) | yes | imperfect (encoder delay) | tap only | ~0.1–0.3 Mbit/s | minimal |
| MSE / HLS / DASH | segment-sized | yes | yes | tap only | adaptive | high |
| raw PCM over chunked HTTP/WebSocket | pacing + lookahead (~50–250 ms) | no | yes | **all samples** | 3.07 Mbit/s f32 48 kHz (1.54 for 16-bit) | low |
| WebCodecs over compressed chunks | decoder + jitter buffer | if you demux | yes | all samples | compressed | medium–high |
| `decodeAudioData` (whole file) | full download + decode | trivial | yes | all samples | file size | minimal |

This project uses chunked raw PCM because it is the least mechanism that still exposes *bytes as
samples*, and it keeps the example dependency-free. For a real app, codec-compressed transport
(progressive or WebCodecs) is usually the better bandwidth trade.

## Gotchas worth knowing

- **Autoplay.** `AudioContext` starts suspended and `play()` can reject without a user gesture.
  This demo only creates the context from the Start button (or `window.__wave.start()` in
  automation) and resumes it there.
- **Sample rates are not uniform.** The device/context rate is often 44.1 or 48 kHz; browsers
  resample. This demo's source is 48 kHz but the context may come up at 44100 Hz — the readout
  shows the real rate, and stream buffers are explicitly created at 48 kHz so Web Audio resamples
  them on playback.
- **SAB needs isolation.** COOP+COEP on every response; cross-origin subresources then need
  CORP/CORS. The plugin sets COOP/COEP/CORP.
- **CORS.** A CORS-cross-origin media element connected to `MediaElementAudioSourceNode` is
  silent; `fetch` must succeed for `decodeAudioData`/WebCodecs.
- **Latency numbers are estimates.** `baseLatency`/`outputLatency` are useful for display, not for
  building a sync scheme.
- **Clicks and drift.** Never schedule a buffer per network chunk without lookahead; keep the
  leftover bytes; jump forward when the playhead overtakes the queue.
- **Headless browsers** can run the graph against a null audio sink; the clock advances, so probes
  still work (that is how this project's screenshots were verified).

## Further reading

- Web Audio API spec: <https://webaudio.github.io/web-audio-api/>
- `AnalyserNode`: <https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode>
- `AudioWorklet`: <https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet>
- `decodeAudioData`: <https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData>
- `SharedArrayBuffer` + cross-origin isolation: <https://web.dev/articles/coop-coep>
- WebCodecs: <https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API>
- Media Source Extensions: <https://developer.mozilla.org/en-US/docs/Web/API/MediaSource>
- WebGPU: <https://gpuweb.github.io/gpuweb/> and <https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API>

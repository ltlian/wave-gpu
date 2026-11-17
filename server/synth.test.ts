import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SAMPLE_RATE,
  TRACK_BPM,
  TRACK_FRAMES,
  TRACK_SECONDS,
} from '../shared/audio.ts';
import { renderTrack } from './synth.ts';

// Rendering once and sharing the result keeps the suite fast while still
// re-rendering inside the determinism test (which is the point of that test).
const track = renderTrack();

test('renderTrack: shape matches the shared constants', () => {
  assert.equal(track.sampleRate, SAMPLE_RATE);
  assert.equal(track.channels, 2);
  assert.equal(track.bpm, TRACK_BPM);
  assert.equal(track.durationSeconds, TRACK_SECONDS);
  assert.equal(track.frames, TRACK_FRAMES);
  assert.equal(track.frames, 576_000);
  assert.equal(track.channelsData.length, 2);
  assert.equal(track.channelsData[0].length, track.frames);
  assert.equal(track.channelsData[1].length, track.frames);
});

test('renderTrack: deterministic — two renders are sample-identical', () => {
  const again = renderTrack();
  assert.notEqual(again.channelsData[0], track.channelsData[0]); // fresh buffers
  for (let channel = 0; channel < 2; channel += 1) {
    assert.deepEqual(again.channelsData[channel], track.channelsData[channel]);
  }
});

test('renderTrack: every sample is finite and the peak is exactly 0.8', () => {
  let peak = 0;
  for (const channel of track.channelsData) {
    for (const sample of channel) {
      if (!Number.isFinite(sample)) assert.fail(`non-finite sample: ${sample}`);
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
    }
  }
  // Samples live in float32, so 0.8 is stored as 0.800000011920929. The tolerance
  // is far below one 16-bit quantisation step, i.e. the normalisation is exact
  // for every practical purpose.
  assert.ok(Math.abs(peak - 0.8) < 1e-6, `peak was ${peak}`);
});

test('renderTrack: no long DC offset', () => {
  for (const channel of track.channelsData) {
    let sum = 0;
    for (const sample of channel) sum += sample;
    assert.ok(Math.abs(sum / channel.length) < 1e-4, 'whole-track DC');

    // A slowly drifting offset could cancel globally; check each second too.
    for (let second = 0; second < TRACK_SECONDS; second += 1) {
      const start = second * SAMPLE_RATE;
      let windowSum = 0;
      for (let i = start; i < start + SAMPLE_RATE; i += 1) windowSum += channel[i];
      const windowMean = windowSum / SAMPLE_RATE;
      assert.ok(Math.abs(windowMean) < 0.005, `DC in second ${second}: ${windowMean}`);
    }
  }
});

test('renderTrack: the loop seam is continuous', () => {
  // Folding the one-second tail back over the start should make the wrap from
  // the last rendered sample to the first one inaudible. With a peak of 0.8, a
  // jump of a couple of percent of full scale is well within "no click".
  for (const [index, channel] of track.channelsData.entries()) {
    const jump = Math.abs(channel[0] - channel[channel.length - 1]);
    assert.ok(jump < 0.02, `seam jump on channel ${index}: ${jump}`);
  }
});

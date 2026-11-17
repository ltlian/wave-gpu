import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_DISPLAY_GAIN_OPTIONS,
  createDisplayGain,
} from './display-gain.ts';
import type { DisplayGainOptions } from './display-gain.ts';

const EPSILON = 1e-6;

function closeTo(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) < EPSILON,
    `expected ${actual} to be within ${EPSILON} of ${expected}`,
  );
}

/** Coefficients of 1 make attack/decay instantaneous, which keeps the maths exact. */
const EXACT: DisplayGainOptions = { attack: 1, decay: 1, floor: 0.045, maxGain: 20 };

test('default options use a fast attack, slow decay, a floor and a gain cap', () => {
  assert.ok(DEFAULT_DISPLAY_GAIN_OPTIONS.attack > DEFAULT_DISPLAY_GAIN_OPTIONS.decay);
  assert.ok(DEFAULT_DISPLAY_GAIN_OPTIONS.attack > 0.25);
  assert.ok(DEFAULT_DISPLAY_GAIN_OPTIONS.decay < 0.2);
  assert.equal(DEFAULT_DISPLAY_GAIN_OPTIONS.floor, 0.045);
  assert.equal(DEFAULT_DISPLAY_GAIN_OPTIONS.maxGain, 20);
});

test('apply() normalises a frame to full scale and returns the gain', () => {
  const displayGain = createDisplayGain(EXACT);
  const samples = new Float32Array([0.5, -0.25, 0.1, -0.5]);

  const gain = displayGain.apply(samples);

  closeTo(gain, 2);
  closeTo(displayGain.gain, 2);
  closeTo(displayGain.peak, 0.5);
  closeTo(samples[0], 1);
  closeTo(samples[1], -0.5);
  closeTo(samples[3], -1);
});

test('attack rises immediately while decay releases slowly', () => {
  const displayGain = createDisplayGain({ attack: 1, decay: 0.1, floor: 0.01, maxGain: 20 });

  // Attack: measured peak becomes the tracked peak in one call.
  const loud = new Float32Array([0.8, -0.8]);
  const attackGain = displayGain.apply(loud);
  closeTo(displayGain.peak, 0.8);
  closeTo(attackGain, 1.25);
  closeTo(loud[0], 1);
  closeTo(loud[1], -1);

  // Release: a silent frame only moves the peak 10% of the way down.
  const quiet = new Float32Array([0, 0]);
  const releaseGain = displayGain.apply(quiet);
  closeTo(displayGain.peak, 0.8 * (1 - 0.1));
  closeTo(releaseGain, 1 / (0.8 * 0.9));
  assert.ok(releaseGain > attackGain, 'gain should grow as the signal decays');
  assert.ok(releaseGain < 1 / 0.8 + 1, 'release must be gradual, not instantaneous');
});

test('the rolling peak is asymmetric: fast up, slow down', () => {
  const displayGain = createDisplayGain({ attack: 0.5, decay: 0.05, floor: 0.001, maxGain: 20 });

  displayGain.apply(new Float32Array([0.01]));
  const restingPeak = displayGain.peak;

  // A single loud frame moves halfway from the current peak towards the target.
  displayGain.apply(new Float32Array([1]));
  closeTo(displayGain.peak, restingPeak + (1 - restingPeak) * 0.5);
  assert.ok(displayGain.peak > 0.4, 'attack must respond strongly in one frame');

  // The same ratio applied downwards moves only 5% of the way.
  const beforeRelease = displayGain.peak;
  displayGain.apply(new Float32Array([0]));
  closeTo(displayGain.peak, beforeRelease * 0.95);
});

test('gain is capped by maxGain when the signal is near silence', () => {
  const displayGain = createDisplayGain(); // defaults: floor 0.045, max 20

  const silence = new Float32Array(8); // all zero
  const gain = displayGain.apply(silence);

  // 1 / floor would be ~22.2; the cap keeps it at 20.
  closeTo(gain, 20);
  closeTo(displayGain.gain, 20);
  for (const value of silence) assert.equal(value, 0, 'silent input stays silent');
});

test('samples are clamped to ±1 even for out-of-range input', () => {
  const displayGain = createDisplayGain(EXACT);
  const samples = new Float32Array([3, -4, 0.5, -0.25]);

  const gain = displayGain.apply(samples); // measured peak 4 -> gain 0.25
  closeTo(gain, 0.25);
  closeTo(samples[0], 0.75);
  closeTo(samples[1], -1);
  closeTo(samples[2], 0.125);
  closeTo(samples[3], -0.0625);
  for (const value of samples) assert.ok(value >= -1 && value <= 1);
});

test('non-finite samples are neutralised instead of poisoning the buffer', () => {
  const displayGain = createDisplayGain(EXACT);
  const samples = new Float32Array([Number.NaN, Number.POSITIVE_INFINITY, 0.5, -0.5]);

  displayGain.apply(samples);

  assert.equal(samples[0], 0);
  assert.equal(samples[1], 0);
  closeTo(samples[2], 1);
  closeTo(samples[3], -1);
});

test('reset() forgets the rolling peak', () => {
  const displayGain = createDisplayGain(EXACT);
  displayGain.apply(new Float32Array([0.5]));
  closeTo(displayGain.peak, 0.5);

  displayGain.reset();

  assert.equal(displayGain.peak, EXACT.floor);
  assert.equal(displayGain.gain, 1);
});

test('the same gain is returned and exposed on the object', () => {
  const displayGain = createDisplayGain(EXACT);
  const gain = displayGain.apply(new Float32Array([0.2, -0.2]));
  assert.equal(gain, displayGain.gain);
  closeTo(gain, 5);
});

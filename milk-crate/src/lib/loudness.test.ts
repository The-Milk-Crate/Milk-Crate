import { describe, expect, it } from "vitest";
import { CEILING_DBTP, MEASURE_RATE, TARGET_LUFS, integratedLoudness, measureLoudness, normalizerGainDb, truePeak } from "./loudness";

const sine = (hz: number, dbfs: number, seconds: number, phase = 0) => {
  const a = 10 ** (dbfs / 20);
  return Float32Array.from({ length: Math.round(MEASURE_RATE * seconds) }, (_, i) => a * Math.sin((2 * Math.PI * hz * i) / MEASURE_RATE + phase));
};

describe("integratedLoudness", () => {
  it("reads a 997 Hz stereo sine at its level (BS.1770 calibration)", () => {
    const s = sine(997, -20, 5);
    expect(integratedLoudness([s, s])).toBeCloseTo(-20, 1);
  });
  it("treats mono as both speakers", () => {
    expect(integratedLoudness([sine(997, -20, 5)])).toBeCloseTo(-20, 1);
  });
  it("gates out silence", () => {
    const s = sine(997, -20, 5);
    const withSilence = new Float32Array(s.length * 2);
    withSilence.set(s);
    expect(integratedLoudness([withSilence, withSilence])).toBeCloseTo(-20, 0); // blocks straddling the edge count, per the standard
  });
  it("is -Infinity for silence", () => {
    const z = new Float32Array(MEASURE_RATE * 2);
    expect(integratedLoudness([z, z])).toBe(-Infinity);
  });
});

describe("truePeak", () => {
  it("finds peaks between samples", () => {
    // A sine at a quarter of the sample rate, sampled 45° off its peaks: samples sit 3 dB under the true peak.
    const s = sine(MEASURE_RATE / 4, -6, 1, Math.PI / 4);
    const samplePeak = 20 * Math.log10(Math.max(...Array.from(s, Math.abs)));
    expect(samplePeak).toBeCloseTo(-9, 0);
    expect(truePeak([s, s])).toBeCloseTo(-6, 0);
  });
});

describe("normalizerGainDb", () => {
  it("brings a loud master down to the target", () => {
    expect(normalizerGainDb({ lufs: -8, peak: -0.1 })).toBeCloseTo(TARGET_LUFS + 8);
  });
  it("turns a quiet song up to the target when there's headroom", () => {
    expect(normalizerGainDb({ lufs: -18, peak: -8 })).toBeCloseTo(5);
  });
  it("stops short of the target rather than peak over the ceiling", () => {
    expect(normalizerGainDb({ lufs: -18, peak: -3 })).toBeCloseTo(CEILING_DBTP + 3);
  });
  it("leaves silence alone", () => {
    expect(normalizerGainDb({ lufs: -Infinity, peak: -Infinity })).toBe(0);
  });
  it("lands a measured song at the target", () => {
    const s = sine(997, -20, 4);
    const l = measureLoudness([s, s]);
    expect(l.lufs + normalizerGainDb(l)).toBeCloseTo(TARGET_LUFS, 1);
    expect(l.peak + normalizerGainDb(l)).toBeLessThanOrEqual(CEILING_DBTP + 0.01);
  });
});

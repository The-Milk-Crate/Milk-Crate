import { describe, expect, it } from "vitest";
import { analyzeSamples, soundDistance } from "./sound";

const SR = 22050;
const make = (secs: number, fn: (t: number, i: number) => number) => Float32Array.from({ length: SR * secs }, (_, i) => fn(i / SR, i));
/** A drum-like click track: short decaying noise bursts on every beat. */
const clicks = (bpm: number, secs = 30) => {
  const period = 60 / bpm;
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  return make(secs, (t) => {
    const since = t % period;
    return since < 0.05 ? noise() * Math.exp(-since * 60) * 0.8 : 0.002 * noise();
  });
};
const tone = (hz: number, amp = 0.5, secs = 20) => make(secs, (t) => amp * Math.sin(2 * Math.PI * hz * t));

describe("sound profiles", () => {
  it("finds the tempo", () => {
    expect(analyzeSamples(clicks(120), SR).tempo).toBeGreaterThan(116);
    expect(analyzeSamples(clicks(120), SR).tempo).toBeLessThan(124);
    expect(Math.abs(analyzeSamples(clicks(90), SR).tempo - 90)).toBeLessThan(4);
    expect(Math.abs(analyzeSamples(clicks(150), SR).tempo - 150)).toBeLessThan(6);
  });
  it("hears brightness", () => {
    const low = analyzeSamples(tone(300), SR).brightness;
    const high = analyzeSamples(tone(3000), SR).brightness;
    expect(low).toBeGreaterThan(200);
    expect(low).toBeLessThan(500);
    expect(high).toBeGreaterThan(2700);
    expect(high).toBeLessThan(3300);
  });
  it("hears loudness and dynamics", () => {
    const loud = analyzeSamples(tone(440, 0.9), SR);
    const quiet = analyzeSamples(tone(440, 0.05), SR);
    expect(loud.energy).toBeGreaterThan(quiet.energy + 20);
    expect(loud.dynamics).toBeLessThan(2);
    const swells = analyzeSamples(make(20, (t) => (Math.floor(t) % 2 ? 0.8 : 0.03) * Math.sin(2 * Math.PI * 440 * t)), SR);
    expect(swells.dynamics).toBeGreaterThan(18);
  });
  it("compares sounds", () => {
    const a = analyzeSamples(clicks(120), SR), b = analyzeSamples(clicks(124), SR), c = analyzeSamples(tone(220, 0.05), SR);
    expect(soundDistance(a, b)).toBeLessThan(soundDistance(a, c));
  });
});

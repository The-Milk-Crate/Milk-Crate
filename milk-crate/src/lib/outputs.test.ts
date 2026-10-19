import { describe, expect, it } from "vitest";
import { kindOf } from "./outputs";
import { songEnds } from "./vinyl";

describe("kindOf", () => {
  it("guesses a device's kind from its name", () => {
    expect(kindOf("Headphones (WH-1000XM4 Stereo)")).toBe("bluetooth");
    expect(kindOf("Speakers (Realtek(R) Audio)")).toBe("builtin");
    expect(kindOf("LG ULTRAGEAR (NVIDIA High Definition Audio)")).toBe("hdmi");
    expect(kindOf("Speakers (Focusrite USB Audio)")).toBe("usb");
  });
});

describe("songEnds", () => {
  it("runs each song up to the next unless it was cut short", () => {
    expect(songEnds({ start: 2, cuts: [100, 200], end: 300, ends: [null, 190, null] })).toEqual([100, 190, 300]);
  });
  it("keeps a cut-short end between its own start and the next song", () => {
    expect(songEnds({ start: 0, cuts: [100], end: 200, ends: [150, 50] })).toEqual([100, 101]);
  });
});

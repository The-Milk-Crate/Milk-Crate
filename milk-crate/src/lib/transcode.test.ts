import { describe, expect, it } from "vitest";
import { bitrateFor, needsStreamingCopy } from "./transcode";

const file = (ext: string, mb: number) => ({ blob: { size: mb * 1048576 } as Blob, ext, type: "" });

describe("streaming copies", () => {
  it("converts uncompressed and lossless files, keeps small compressed ones", () => {
    expect(needsStreamingCopy(file("wav", 30))).toBe(true);
    expect(needsStreamingCopy(file("flac", 20))).toBe(true);
    expect(needsStreamingCopy(file("mp3", 10))).toBe(false);
    expect(needsStreamingCopy(file("m4a", 49.9))).toBe(true); // too close to the limit
  });
  it("uses 320 kbps for normal-length songs and steps down for long ones", () => {
    expect(bitrateFor(6 * 60)).toBe(320);
    expect(bitrateFor(20 * 60)).toBe(320);
    expect(bitrateFor(30 * 60)).toBe(192);
    expect(bitrateFor(80 * 60)).toBe(null);
  });
});

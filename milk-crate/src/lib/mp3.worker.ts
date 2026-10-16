/// <reference lib="webworker" />
// Encodes decoded audio to MP3 off the main thread so the app stays responsive.
import { Mp3Encoder } from "@breezystack/lamejs";

interface Job { left: Float32Array; right?: Float32Array; sampleRate: number; kbps: number }

self.onmessage = (e: MessageEvent<Job>) => {
  try {
    const { left, right, sampleRate, kbps } = e.data;
    const encoder = new Mp3Encoder(right ? 2 : 1, sampleRate, kbps);
    const BLOCK = 1152 * 32;
    const l16 = new Int16Array(BLOCK);
    const r16 = new Int16Array(BLOCK);
    const chunks: Uint8Array[] = [];
    let lastPct = -1;
    for (let i = 0; i < left.length; i += BLOCK) {
      const n = Math.min(BLOCK, left.length - i);
      for (let j = 0; j < n; j++) {
        l16[j] = toInt16(left[i + j]);
        if (right) r16[j] = toInt16(right[i + j]);
      }
      const out = encoder.encodeBuffer(l16.subarray(0, n), right ? r16.subarray(0, n) : undefined);
      if (out.length) chunks.push(new Uint8Array(out));
      const pct = Math.floor(((i + n) / left.length) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        self.postMessage({ type: "progress", pct });
      }
    }
    const tail = encoder.flush();
    if (tail.length) chunks.push(new Uint8Array(tail));
    self.postMessage({ type: "done", chunks });
  } catch (err) {
    self.postMessage({ type: "error", message: (err as Error).message });
  }
};

function toInt16(x: number) {
  const s = x < -1 ? -1 : x > 1 ? 1 : x;
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}

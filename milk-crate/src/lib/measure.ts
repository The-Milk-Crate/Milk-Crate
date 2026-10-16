/** Measures how an audio file sounds (see sound.ts). Returns null if it can't be read. */
import type { SoundProfile } from "./sound";

const RATE = 22050;

export async function measureSound(blob: Blob): Promise<SoundProfile | null> {
  try {
    const ctx = new OfflineAudioContext(1, 1, RATE);
    const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const ch = audio.getChannelData(c);
      for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / audio.numberOfChannels;
    }
    return await new Promise<SoundProfile | null>((resolve) => {
      const worker = new Worker(new URL("./sound.worker.ts", import.meta.url), { type: "module" });
      const done = (p: SoundProfile | null) => { worker.terminate(); resolve(p); };
      worker.onmessage = (e) => done(e.data.ok ? e.data.profile : null);
      worker.onerror = () => done(null);
      worker.postMessage({ samples: mono, sampleRate: audio.sampleRate }, [mono.buffer]);
    });
  } catch {
    return null;
  }
}

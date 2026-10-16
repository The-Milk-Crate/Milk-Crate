/**
 * Where the player's sound goes: volume, plus a 6-band equalizer.
 *
 * The equalizer uses the Web Audio API. It's only wired in once someone turns
 * it on, because routing audio through Web Audio requires the audio to be
 * loaded with CORS (Milk Crate's server and the desktop app's file access both
 * allow it). Before that, the audio element plays directly.
 */

export interface EqBand { hz: number; label: string; type: BiquadFilterType }
export const EQ_BANDS: EqBand[] = [
  { hz: 60, label: "60", type: "lowshelf" },
  { hz: 150, label: "150", type: "peaking" },
  { hz: 400, label: "400", type: "peaking" },
  { hz: 1000, label: "1k", type: "peaking" },
  { hz: 2400, label: "2.4k", type: "peaking" },
  { hz: 15000, label: "15k", type: "highshelf" },
];
export const EQ_MAX_DB = 12;
export const FLAT = [0, 0, 0, 0, 0, 0];
export const EQ_PRESETS: Record<string, number[]> = {
  Flat: FLAT,
  "Bass boost": [6, 4, 1, 0, 0, 0],
  Warm: [3, 2, 1, 0, -1, -3],
  Vocal: [-2, -1, 2, 4, 3, 0],
  Bright: [0, 0, 0, 1, 4, 6],
  Loudness: [5, 2, 0, -1, 2, 4],
};

/** Slider position (0–1) to gain. Squared so the slider feels even to the ear. */
export const volumeToGain = (v: number) => Math.max(0, Math.min(1, v)) ** 2;

export class AudioOut {
  private ctx?: AudioContext;
  private filters: BiquadFilterNode[] = [];
  private gain?: GainNode;
  private volume = 1;
  private muted = false;
  private eqOn = false;
  private gains = FLAT;

  constructor(private el: HTMLAudioElement) {}

  /** True once the equalizer has been wired in (from then on audio must load with CORS). */
  get routed() {
    return !!this.ctx;
  }

  /** Call before setting a new source. */
  prepare(src: string) {
    if (this.ctx && !src.startsWith("blob:")) this.el.crossOrigin = "anonymous";
    else this.el.removeAttribute("crossorigin");
  }

  /** Call on play (a user gesture), so the audio context is allowed to run. */
  resume() {
    if (this.ctx?.state === "suspended") void this.ctx.resume();
  }

  setVolume(v: number, muted: boolean) {
    this.volume = v;
    this.muted = muted;
    this.apply();
  }

  setEq(on: boolean, gains: number[]) {
    this.eqOn = on;
    this.gains = gains;
    if (on && !this.ctx) this.wire();
    this.apply();
  }

  private wire() {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    // Reload the current source with CORS so Web Audio can hear it, keeping the position.
    const el = this.el;
    const src = el.currentSrc || el.src;
    if (src && !src.startsWith("blob:") && el.crossOrigin !== "anonymous") {
      const at = el.currentTime;
      const wasPlaying = !el.paused;
      el.crossOrigin = "anonymous";
      el.src = src;
      el.addEventListener("loadedmetadata", () => {
        el.currentTime = at;
        if (wasPlaying) void el.play().catch(() => {});
      }, { once: true });
    }
    const source = ctx.createMediaElementSource(el);
    this.filters = EQ_BANDS.map((b) => {
      const f = ctx.createBiquadFilter();
      f.type = b.type;
      f.frequency.value = b.hz;
      if (b.type === "peaking") f.Q.value = 1.1;
      return f;
    });
    this.gain = ctx.createGain();
    let node: AudioNode = source;
    for (const f of this.filters) { node.connect(f); node = f; }
    node.connect(this.gain);
    this.gain.connect(ctx.destination);
    this.ctx = ctx;
    if (!el.paused) void ctx.resume();
  }

  private apply() {
    const level = this.muted ? 0 : volumeToGain(this.volume);
    if (this.ctx && this.gain) {
      this.el.volume = 1;
      this.gain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.015);
      this.filters.forEach((f, i) => f.gain.setTargetAtTime(this.eqOn ? this.gains[i] ?? 0 : 0, this.ctx!.currentTime, 0.02));
    } else {
      this.el.volume = level;
    }
  }
}

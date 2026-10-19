import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Play, RotateCcw, Square } from "lucide-react";
import type { Track } from "../lib/types";
import { playableSrc } from "../lib/localFiles";
import { clock } from "../lib/vinylSplit";
import { Button } from "./ui";

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Cuts the start and/or end off a song you ripped or recorded (changes its file on this computer). */
export const trimSong = (path: string, cutStart: number, cutEnd: number) => call<number>("cd_trim", { path, cutStart, cutEnd });

const BARS = 180;
/** The shortest a song can be trimmed to (seconds). */
const MIN = 1;

/**
 * Trimming one song, under its row on the album page: drag the handles at either end of the song to
 * where it should start and end. Letting go of a handle plays a few seconds there to check.
 */
export function TrimSong({ track, onDone, onClose }: { track: Track; onDone: (seconds: number) => void; onClose: () => void }) {
  const path = track.id.replace(/^local:/, "");
  const [length, setLength] = useState(track.duration || 0);
  const [env, setEnv] = useState<number[] | null>(null);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState<number | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const stopAt = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<0 | 1 | null>(null);

  // The song's shape (its loudness over time) and real length, from the file.
  useEffect(() => {
    let live = true;
    call<{ envelope: number[]; seconds: number }>("cd_envelope", { path })
      .then((r) => { if (live) { setEnv(r.envelope); setLength(r.seconds); } })
      .catch(() => { if (live) setEnv([]); });
    void playableSrc(track).then((src) => {
      if (!live || !src) return;
      const a = new Audio(src);
      a.preload = "metadata";
      a.addEventListener("loadedmetadata", () => { if (live && Number.isFinite(a.duration)) setLength((l) => l || a.duration); });
      a.addEventListener("timeupdate", () => {
        setNow(a.currentTime);
        if (a.currentTime >= stopAt.current) a.pause();
      });
      a.addEventListener("pause", () => setNow(null));
      audio.current = a;
    });
    return () => { live = false; audio.current?.pause(); audio.current = null; };
  }, [track, path]);

  const [a, b] = range ?? [0, length];
  const changed = !!range && (a > 0.05 || b < length - 0.05);

  const bars = useMemo(() => {
    if (!env?.length) return null;
    const per = env.length / BARS;
    const peak = Math.max(0.05, ...env);
    return Array.from({ length: BARS }, (_, i) => {
      let m = 0;
      for (let k = Math.floor(i * per); k < Math.min(env.length, Math.floor((i + 1) * per)); k++) m = Math.max(m, env[k]);
      return Math.max(4, Math.min(100, (m / peak) * 100));
    });
  }, [env]);

  const pct = (t: number) => `${length ? Math.min(100, Math.max(0, (t / length) * 100)) : 0}%`;
  const timeAt = (x: number) => {
    const r = box.current!.getBoundingClientRect();
    return Math.max(0, Math.min(length, ((x - r.left) / r.width) * length));
  };
  const cur = useRef<[number, number]>([0, 0]);
  cur.current = [a, b];
  const move = (which: 0 | 1, to: number) => setRange((r) => {
    const [x, y] = r ?? [0, length];
    const t = Math.round(to * 10) / 10;
    const next: [number, number] = which === 0 ? [Math.max(0, Math.min(y - MIN, t)), y] : [x, Math.min(length, Math.max(x + MIN, t))];
    cur.current = next;
    return next;
  });

  const play = (from: number, to: number) => {
    const el = audio.current;
    if (!el) return;
    stopAt.current = to;
    el.currentTime = from;
    void el.play().catch(() => setNow(null));
  };
  const stop = () => audio.current?.pause();
  // Just after the new start, or just before the new end.
  const check = (which: 0 | 1, [x, y]: [number, number]) => (which === 0 ? play(x, Math.min(y, x + 5)) : play(Math.max(x, y - 5), y));

  const down = (which: 0 | 1) => (e: PointerEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    stop();
    setDrag(which);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const dragMove = (which: 0 | 1) => (e: PointerEvent<HTMLButtonElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) move(which, timeAt(e.clientX));
  };
  const up = (which: 0 | 1) => () => {
    if (drag === null) return;
    setDrag(null);
    check(which, cur.current);
  };
  const key = (which: 0 | 1) => (e: KeyboardEvent) => {
    const d = ({ ArrowLeft: -1, ArrowRight: 1 } as Record<string, number>)[e.key];
    if (!d) return;
    e.preventDefault();
    move(which, (which === 0 ? a : b) + d * (e.shiftKey ? 5 : 0.5));
  };

  const save = async () => {
    stop();
    setSaving(true);
    setError("");
    try {
      onDone(await trimSong(path, a, Math.max(0, length - b)));
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  const playing = now !== null;
  return (
    <div className="trim-panel" role="group" aria-label={`Trim ${track.title}`}>
      <div className="trim-head">
        <strong>Trim “{track.title}”</strong>
        <span className="numeral muted">{clock(length)} → {clock(b - a)}</span>
      </div>
      <p className="caption muted" style={{ margin: 0 }}>Drag the handles to where the song should start and end. Letting go plays a few seconds there.</p>

      <div className={`trim-wave${drag !== null ? " is-dragging" : ""}`}>
        <div ref={box} className="trim-wave-inner" onPointerDown={(e) => { if (length) { const t = timeAt(e.clientX); play(t, b); } }}>
          <div className="trim-bars" aria-hidden="true">
            {(bars ?? Array.from({ length: BARS }, () => (env ? 40 : 20))).map((h, i) => {
              const at = ((i + 0.5) / BARS) * length;
              return <span key={i} className={at < a || at > b ? "is-cut" : undefined} style={{ height: `${h}%` }} />;
            })}
          </div>
          <span className="trim-shade" style={{ left: 0, width: pct(a) }} aria-hidden="true" />
          <span className="trim-shade" style={{ left: pct(b), right: 0 }} aria-hidden="true" />
          {playing && <span className="vinyl-now" style={{ left: pct(now!) }} />}
          {([0, 1] as const).map((which) => {
            const at = which === 0 ? a : b;
            return (
              <button key={which} type="button" className={`trim-handle${which === 0 ? " is-start" : " is-end"}`} style={{ left: pct(at) }}
                role="slider" aria-label={which === 0 ? "Where the song starts" : "Where the song ends"}
                aria-valuemin={0} aria-valuemax={Math.round(length)} aria-valuenow={Math.round(at * 10) / 10} aria-valuetext={clock(at)}
                onPointerDown={down(which)} onPointerMove={dragMove(which)} onPointerUp={up(which)} onPointerCancel={() => setDrag(null)}
                onKeyDown={key(which)} onKeyUp={(e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") check(which, [a, b]); }}>
                <span className="trim-handle-tag numeral">{clock(at)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="trim-foot">
        <Button size="sm" variant="ghost" onClick={() => (playing ? stop() : play(a, b))} disabled={!length}>
          {playing ? <><Square size={14} aria-hidden="true" /> Stop</> : <><Play size={14} aria-hidden="true" /> Play the trimmed song</>}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { stop(); setRange(null); }} disabled={!changed}><RotateCcw size={14} aria-hidden="true" /> Reset</Button>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()} disabled={saving || !length || !changed}>{saving ? "Saving…" : "Save"}</Button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <span className="caption muted">Changes the song's file on this computer. The cut part can't be brought back (but you can record or rip it again).</span>
    </div>
  );
}

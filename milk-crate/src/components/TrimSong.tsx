import { useEffect, useRef, useState } from "react";
import { Play, Square } from "lucide-react";
import type { Track } from "../lib/types";
import { playableSrc } from "../lib/localFiles";
import { clock } from "../lib/vinylSplit";
import { Button } from "./ui";

/** Cuts the start and/or end off a song you ripped or recorded (changes its file on this computer). */
export async function trimSong(path: string, cutStart: number, cutEnd: number): Promise<number> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("cd_trim", { path, cutStart, cutEnd });
}

/**
 * Trimming one song, under its row on the album page: how much to cut from the start and the end,
 * with a listen to the new start and ending before saving.
 */
export function TrimSong({ track, onDone, onClose }: { track: Track; onDone: (seconds: number) => void; onClose: () => void }) {
  const [length, setLength] = useState(track.duration || 0);
  const [cut, setCut] = useState({ start: 0, end: 0 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState<"start" | "end" | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const stopAt = useRef(0);

  // The song's real length (the list may not know it yet), from the file.
  useEffect(() => {
    let live = true;
    void playableSrc(track).then((src) => {
      if (!live || !src) return;
      const a = new Audio(src);
      a.preload = "metadata";
      a.addEventListener("loadedmetadata", () => { if (live && Number.isFinite(a.duration)) setLength(a.duration); });
      a.addEventListener("timeupdate", () => { if (a.currentTime >= stopAt.current) { a.pause(); setPlaying(null); } });
      a.addEventListener("pause", () => setPlaying(null));
      audio.current = a;
    });
    return () => { live = false; audio.current?.pause(); audio.current = null; };
  }, [track]);

  const left = Math.max(0, length - cut.start - cut.end);
  const set = (which: "start" | "end", to: number) => setCut((c) => {
    const other = which === "start" ? c.end : c.start;
    const v = Math.round(Math.max(0, Math.min(length - other - 1, to)) * 10) / 10;
    return { ...c, [which]: v };
  });
  const listen = (which: "start" | "end") => {
    const a = audio.current;
    if (!a) return;
    if (playing === which) { a.pause(); return; }
    const from = which === "start" ? cut.start : Math.max(cut.start, length - cut.end - 6);
    stopAt.current = which === "start" ? Math.min(length - cut.end, cut.start + 6) : length - cut.end;
    a.currentTime = from;
    void a.play().then(() => setPlaying(which)).catch(() => setPlaying(null));
  };
  const save = async () => {
    audio.current?.pause();
    setSaving(true);
    setError("");
    try {
      onDone(await trimSong(track.id.replace(/^local:/, ""), cut.start, cut.end));
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  const field = (which: "start" | "end", label: string) => (
    <div className="trim-field">
      <span className="catalog eyebrow">{label}</span>
      <div className="trim-row">
        <span className="vinyl-nudge">
          <button type="button" aria-label={`${label}: a second less`} onClick={() => set(which, cut[which] - 1)}>−1s</button>
        </span>
        <label className="trim-input">
          <input type="number" min={0} step={0.1} value={cut[which]} aria-label={`${label} (seconds)`}
            onChange={(e) => set(which, Number(e.target.value) || 0)} />
          <span className="caption muted">sec</span>
        </label>
        <span className="vinyl-nudge">
          <button type="button" aria-label={`${label}: a second more`} onClick={() => set(which, cut[which] + 1)}>+1s</button>
        </span>
        <Button size="sm" variant="ghost" onClick={() => listen(which)} disabled={!length}>
          {playing === which ? <Square size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
          {which === "start" ? " Play the new start" : " Play the new ending"}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="trim-panel" role="group" aria-label={`Trim ${track.title}`}>
      <div className="trim-head">
        <strong>Trim “{track.title}”</strong>
        <span className="numeral muted">{clock(length)} → {clock(left)}</span>
      </div>
      <div className="trim-bar" aria-hidden="true">
        <span style={{ left: `${length ? (cut.start / length) * 100 : 0}%`, right: `${length ? (cut.end / length) * 100 : 0}%` }} />
      </div>
      <div className="trim-fields">
        {field("start", "Cut from the start")}
        {field("end", "Cut from the end")}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="trim-foot">
        <span className="caption muted" style={{ flex: 1 }}>Changes the song's file on this computer. The cut part can't be brought back (but you can record or rip it again).</span>
        <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={() => void save()} disabled={saving || !length || (cut.start === 0 && cut.end === 0)}>{saving ? "Saving…" : "Save"}</Button>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Disc3, Pause, Play, Plus, Search, X } from "lucide-react";
import type { Go } from "../App";
import { Button } from "./ui";
import { Select } from "./Select";
import { useAddRipped } from "../lib/ripped";
import { albumKey } from "../lib/fileTags";
import {
  cancelSide, chooseRecord, chooseSide, enterByHand, loadInputs, pauseSide, playFrom, resetVinyl, saveSide, searchRecords,
  setVinyl, startSide, stopPreview, stopSide, useVinyl, type Side,
} from "../lib/vinyl";
import { ENV_RATE, clock } from "../lib/vinylSplit";

/**
 * Recording a record from the turntable (Your Shelf › Vinyl): pick it, record each side as it
 * plays, check where the songs start, save. Keeps recording while you're elsewhere in the app.
 */
export function VinylRipper({ go, onClose }: { go: Go; onClose: () => void }) {
  const v = useVinyl();
  const addRipped = useAddRipped();
  useEffect(() => {
    setVinyl({ shown: true, notice: null });
    if (!v.inputs.length) void loadInputs();
    return () => setVinyl({ shown: false });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const side = v.sides[v.side];

  const save = async () => {
    try {
      const files = await saveSide();
      await addRipped(files, "Vinyl");
    } catch { /* shown */ }
  };
  const openAlbum = () => {
    const key = albumKey({ id: "local:", tags: { album: v.album.trim() || "Unknown Album", albumArtist: v.artist.trim() || "Unknown Artist", media: "Vinyl" } });
    go(key ? { name: "computer", album: key } : { name: "computer" });
  };

  return (
    <section className="panel vinyl-ripper" aria-label="Record a record">
      <header className="vinyl-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="catalog eyebrow">Vinyl · record a record</span>
          <h2 className="display-md">{v.step === "pick" ? "Which record is on?" : v.album || "Your record"}</h2>
        </div>
        {!v.recording && !v.take && (
          <button type="button" className="mc-icon-btn" aria-label="Close the recorder" onClick={() => { stopPreview(); onClose(); }}><X size={18} aria-hidden="true" /></button>
        )}
      </header>

      {v.error && <p className="form-error" role="alert">{v.error}</p>}

      {v.step === "pick" && <Pick />}
      {v.step === "record" && (v.recording ? <Recording side={side} /> : <NextSide saved={v.saved.length} />)}
      {v.step === "check" && <Check side={side} onSave={() => void save()} />}
      {v.step === "done" && (
        <div className="vinyl-done">
          <p><strong>{v.album}</strong> is saved: {v.saved.length} {v.saved.length === 1 ? "song" : "songs"} in Music › Milk Crate. It's on Your Shelf under Vinyl.</p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Button variant="primary" onClick={openAlbum}>Open the album</Button>
            <Button onClick={resetVinyl}>Record another</Button>
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------- 1. Pick the record ---------- */

function Pick() {
  const v = useVinyl();
  const [q, setQ] = useState(v.query);
  const ready = v.sides.length > 0 && v.sides[v.side]?.tracks.length > 0;
  return (
    <div className="vinyl-pick">
      <div className="vinyl-col">
        <form className="vinyl-search" onSubmit={(e) => { e.preventDefault(); void searchRecords(q); }}>
          <label className="field" style={{ flex: 1 }}>
            <span className="catalog eyebrow">Artist and album, or the barcode</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="pearl jam ten" autoFocus />
          </label>
          <Button type="submit" disabled={v.searching}><Search size={16} aria-hidden="true" /> {v.searching ? "Looking…" : "Search"}</Button>
        </form>
        <ul className="vinyl-results">
          {v.results.map((r) => (
            <li key={r.releaseId}>
              <button type="button" aria-pressed={v.releaseId === r.releaseId} onClick={() => void chooseRecord(r)}>
                <strong>{r.title}</strong>
                <span className="caption muted">{r.artist}{r.detail ? ` · ${r.detail}` : ""}{r.tracks ? ` · ${r.tracks} songs` : ""}</span>
                {!r.vinyl && <span className="caption muted">Not a record pressing</span>}
              </button>
            </li>
          ))}
          {!v.searching && v.query && !v.results.length && <li className="caption muted">Nothing found. Try fewer words, or type the songs in yourself.</li>}
        </ul>
        <button type="button" className="link-btn caption" onClick={enterByHand}>Not listed? Type the songs in yourself</button>
      </div>

      {v.sides.length > 0 && (
        <div className="vinyl-col vinyl-chosen">
          <div className="vinyl-album-fields">
            {v.cover ? <img src={v.cover} alt="" className="vinyl-cover" /> : <span className="vinyl-cover is-empty" aria-hidden="true"><Disc3 size={28} /></span>}
            <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minWidth: 0 }}>
              <label className="field"><span className="caption">Album</span><input value={v.album} onChange={(e) => setVinyl({ album: e.target.value })} /></label>
              <div style={{ display: "flex", gap: 8 }}>
                <label className="field" style={{ flex: 1 }}><span className="caption">Artist</span><input value={v.artist} onChange={(e) => setVinyl({ artist: e.target.value })} /></label>
                <label className="field" style={{ width: 90 }}><span className="caption">Year</span><input value={v.year} inputMode="numeric" maxLength={4} onChange={(e) => setVinyl({ year: e.target.value.replace(/\D/g, "") })} /></label>
              </div>
            </div>
          </div>
          <SidesEditor />
          <div className="vinyl-start">
            <div className="field" style={{ minWidth: 0 }}>
              <span id="vinyl-input" className="caption">Listening to</span>
              {v.inputs.length ? (
                <Select labelledBy="vinyl-input" value={v.device} onChange={(d) => setVinyl({ device: d })}
                  options={v.inputs.map((i) => ({ value: i.name, label: i.name }))} />
              ) : (
                <span className="caption muted">No sound input found. Plug the turntable in by USB (or into an audio interface), then <button type="button" className="link-btn" onClick={() => void loadInputs()}>look again</button>.</span>
              )}
            </div>
            <SidePicker />
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <Button variant="primary" onClick={() => void startSide()} disabled={!ready || !v.inputs.length}>Record side {v.sides[v.side]?.label}</Button>
              <span className="caption muted">Press it, then drop the needle.</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The record's sides, always editable: MusicBrainz sometimes gets them wrong. Retitle a song,
 * move it to the side before or after, add or take out songs, add a side.
 */
function SidesEditor() {
  const v = useVinyl();
  const total = (s: Side) => s.tracks.reduce((n, t) => n + (t.seconds ?? 0), 0);
  const edit = (f: (sides: Side[]) => Side[]) => setVinyl((st) => ({ sides: f(st.sides.map((x) => ({ ...x, tracks: [...x.tracks] }))) }));
  const move = (from: number, k: number, to: number) => edit((sides) => {
    const [t] = sides[from].tracks.splice(k, 1);
    // Moving forward: it becomes the first song of the next side; back: the last of the one before.
    if (to > from) sides[to].tracks.unshift(t); else sides[to].tracks.push(t);
    return sides;
  });
  const addSide = () => setVinyl((st) => {
    const n = st.sides.length;
    return { sides: [...st.sides, { label: String.fromCharCode(65 + n), disc: Math.floor(n / 2) + 1, tracks: [] }], discs: Math.max(st.discs, Math.floor(n / 2) + 1) };
  });
  const removeSide = (i: number) => setVinyl((st) => ({
    sides: st.sides.filter((_, j) => j !== i).map((x, j) => ({ ...x, label: String.fromCharCode(65 + j), disc: Math.floor(j / 2) + 1 })),
    side: Math.min(st.side, st.sides.length - 2),
  }));
  return (
    <div className="vinyl-sides-edit">
      <div className="vinyl-sides">
        {v.sides.map((s, i) => (
          <div key={i} className={`vinyl-side${i === v.side ? " is-next" : ""}`}>
            <div className="vinyl-side-head">
              <span className="catalog eyebrow">Side {s.label}{total(s) ? ` · ${clock(total(s))}` : ""}</span>
              {v.sides.length > 1 && !s.tracks.length && (
                <button type="button" className="mc-icon-btn" aria-label={`Take out side ${s.label}`} title="Take out this side" onClick={() => removeSide(i)}><X size={14} aria-hidden="true" /></button>
              )}
            </div>
            <ol>
              {s.tracks.map((t, k) => (
                <li key={k}>
                  <span className="numeral muted">{k + 1}</span>
                  <input aria-label={`Side ${s.label}, song ${k + 1}`} value={t.title} placeholder="Song title"
                    onChange={(e) => { const title = e.target.value; edit((sides) => { sides[i].tracks[k] = { ...sides[i].tracks[k], title }; return sides; }); }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      edit((sides) => { sides[i].tracks.splice(k + 1, 0, { title: "", artist: "" }); return sides; });
                      setTimeout(() => (document.querySelector(`[aria-label="Side ${s.label}, song ${k + 2}"]`) as HTMLInputElement | null)?.focus(), 0);
                    }} />
                  <span className="vinyl-song-tools">
                    {i > 0 && <button type="button" aria-label={`Move ${t.title || "this song"} to side ${v.sides[i - 1].label}`} title={`Move to side ${v.sides[i - 1].label}`} onClick={() => move(i, k, i - 1)}><ChevronLeft size={14} aria-hidden="true" /></button>}
                    {i < v.sides.length - 1 && <button type="button" aria-label={`Move ${t.title || "this song"} to side ${v.sides[i + 1].label}`} title={`Move to side ${v.sides[i + 1].label}`} onClick={() => move(i, k, i + 1)}><ChevronRight size={14} aria-hidden="true" /></button>}
                    <button type="button" aria-label={`Take out ${t.title || "this song"}`} title="Take it out" onClick={() => edit((sides) => { sides[i].tracks.splice(k, 1); return sides; })}><X size={14} aria-hidden="true" /></button>
                  </span>
                </li>
              ))}
            </ol>
            <button type="button" className="link-btn caption" onClick={() => {
              edit((sides) => { sides[i].tracks.push({ title: "", artist: "" }); return sides; });
              setTimeout(() => (document.querySelector(`[aria-label="Side ${s.label}, song ${s.tracks.length + 1}"]`) as HTMLInputElement | null)?.focus(), 0);
            }}>
              <Plus size={12} aria-hidden="true" /> Add a song
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="link-btn caption" onClick={addSide}>Add a side</button>
    </div>
  );
}

/* ---------- 2. Recording ---------- */

/** The side as bars: loudness from the envelope, `of` seconds wide. With `marks`, each song's start is a marker you drag. */
function Wave({ env, of, marks, selected, onMove, onSelect, now }: {
  env: number[]; of: number; marks?: number[]; selected?: number;
  onMove?: (i: number, at: number) => void; onSelect?: (i: number) => void; now?: number;
}) {
  const BARS = 220;
  const box = useRef<HTMLDivElement>(null);
  const bars = useMemo(() => {
    const per = Math.max(1, (of * ENV_RATE) / BARS);
    const peak = Math.max(0.05, ...env);
    return Array.from({ length: BARS }, (_, i) => {
      const from = Math.floor(i * per);
      if (from >= env.length) return null;
      let m = 0;
      for (let k = from; k < Math.min(env.length, Math.floor((i + 1) * per)); k++) m = Math.max(m, env[k]);
      return Math.max(3, Math.min(100, (m / peak) * 100));
    });
  }, [env, of]);
  const pct = (at: number) => `${Math.min(100, Math.max(0, (at / of) * 100))}%`;
  const timeAt = (x: number) => {
    const r = box.current!.getBoundingClientRect();
    return Math.max(0, Math.min(of, ((x - r.left) / r.width) * of));
  };
  return (
    <div className={`vinyl-wave${onMove ? " is-editable" : ""}`}>
      <div ref={box} className="vinyl-wave-inner"
        onPointerDown={onMove && selected !== undefined ? (e) => { if ((e.target as HTMLElement).closest(".vinyl-marker")) return; onMove(selected, timeAt(e.clientX)); } : undefined}>
        <div className="vinyl-bars" aria-hidden="true">
          {bars.map((h, i) => <span key={i} className={h === null ? "is-ahead" : undefined} style={{ height: `${h ?? 6}%` }} />)}
        </div>
        {marks?.map((at, i) => (
          <button key={i} type="button" className={`vinyl-marker${i === selected ? " is-selected" : ""}`} style={{ left: pct(at) }}
            aria-label={`Song ${i + 1} starts at ${clock(at)}. Drag, or use the arrow keys.`}
            onPointerDown={(e) => { e.stopPropagation(); onSelect?.(i); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
            onPointerMove={(e) => { if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) onMove?.(i, timeAt(e.clientX)); }}
            onKeyDown={(e) => {
              const d = ({ ArrowLeft: -1, ArrowRight: 1 } as Record<string, number>)[e.key];
              if (d) { e.preventDefault(); onMove?.(i, at + d * (e.shiftKey ? 5 : 0.5)); }
            }}
            onFocus={() => onSelect?.(i)}>
            <span className="vinyl-marker-tag">{i + 1}</span>
          </button>
        ))}
        {now !== undefined && <span className="vinyl-now" style={{ left: pct(now) }} />}
      </div>
    </div>
  );
}

function Meter({ level, clipped }: { level: number; clipped?: boolean }) {
  const lit = Math.round(Math.min(1, level) * 12);
  return (
    <span className="vinyl-meter" aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => <span key={i} className={i < lit ? (i >= 11 || clipped && i >= 10 ? "is-red" : i >= 9 ? "is-hot" : "is-on") : undefined} />)}
    </span>
  );
}

function Recording({ side }: { side?: Side }) {
  const v = useVinyl();
  const of = Math.max(v.seconds + 60, 180);
  const level = Math.max(v.left, v.right);
  const ending = v.quietFor >= 10 && v.seconds - v.quietFor > 15;
  return (
    <div className="vinyl-recording">
      <div className="vinyl-rec-head">
        <span className="catalog eyebrow vinyl-live"><span aria-hidden="true" />{v.paused ? "Paused" : "Recording"} · Side {side?.label}</span>
        <span className="vinyl-clock numeral">{clock(v.seconds)}</span>
      </div>
      {v.dead && <NoSound device={v.device} />}
      <Wave env={v.env} of={of} now={v.seconds} />
      <div className="vinyl-rec-foot">
        <div style={{ display: "flex", flexDirection: "column", gap: 4, width: 300 }}>
          <span className="catalog eyebrow">Level</span>
          <Meter level={level} clipped={v.clipped} />
          <span className="caption muted">
            {v.clipped ? "Too loud in places: turn the turntable's gain down a little."
              : ending ? `Quiet for ${Math.floor(v.quietFor)}s. Stops after a minute of quiet (the end of the side).`
              : level < 0.05 && v.seconds > 5 ? "Very quiet. Is the needle down?"
              : "Stops on its own after a minute of quiet at the end of the side."}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <Button variant="ghost" onClick={() => void cancelSide()}>Cancel</Button>
        <Button onClick={() => void pauseSide(!v.paused)}>{v.paused ? <><Play size={16} aria-hidden="true" /> Resume</> : <><Pause size={16} aria-hidden="true" /> Pause</>}</Button>
        <Button variant="primary" onClick={() => void stopSide()}>Stop</Button>
      </div>
    </div>
  );
}

/** Nothing at all is coming in (not even the hiss of a quiet record). */
function NoSound({ device }: { device: string }) {
  const mac = /Mac/i.test(navigator.userAgent);
  return (
    <div className="vinyl-nosound" role="alert">
      <strong>Milk Crate isn't hearing anything from {device || "this input"}.</strong>
      <ul>
        {mac ? (
          <li>Allow it: System Settings › Privacy &amp; Security › Microphone, turn on <b>Milk Crate</b>, then quit and reopen Milk Crate. (A turntable counts as a microphone to macOS.)</li>
        ) : (
          <li>Allow it: Settings › Privacy &amp; security › Microphone, turn on <b>Microphone access</b> and <b>Let desktop apps access your microphone</b>.</li>
        )}
        <li>Check the turntable: switched on, USB plugged straight into the computer, and its <b>Line/Phono</b> switch set the way its manual says for USB.</li>
        <li>Check {mac ? "System Settings › Sound › Input" : "Settings › System › Sound › Input"}: does {device || "it"} show a level moving while a record plays?</li>
      </ul>
      <Button size="sm" onClick={() => void cancelSide()}>Stop and try again</Button>
    </div>
  );
}

/** Which side you're about to record: you pick it (sides already saved are marked). */
function SidePicker() {
  const v = useVinyl();
  if (v.sides.length < 2) return null;
  return (
    <div className="vinyl-side-pick" role="group" aria-label="Which side">
      <span className="catalog eyebrow">Recording</span>
      {v.sides.map((s, i) => (
        <button key={i} type="button" className="chip" aria-pressed={i === v.side} onClick={() => chooseSide(i)}>
          Side {s.label}{v.doneSides.includes(i) ? " ✓" : ""}
        </button>
      ))}
    </div>
  );
}

function NextSide({ saved }: { saved: number }) {
  const v = useVinyl();
  const side = v.sides[v.side];
  return (
    <div className="vinyl-next">
      <p>{saved ? <>Saved {saved} {saved === 1 ? "song" : "songs"}. Flip the record, pick the side and record it.</> : <>Pick the side that's on the turntable.</>}</p>
      <SidePicker />
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <Button variant="primary" onClick={() => void startSide()} disabled={!side?.tracks.length}>Record side {side?.label}</Button>
        <span className="caption muted">Press it, then drop the needle.</span>
        {saved > 0 && <Button variant="ghost" onClick={() => setVinyl({ step: "done" })}>I'm done</Button>}
      </div>
    </div>
  );
}

/* ---------- 3. Where each song starts ---------- */

function Check({ side, onSave }: { side?: Side; onSave: () => void }) {
  const v = useVinyl();
  const [sel, setSel] = useState(0);
  if (!v.take || !side) return null;
  const starts = [v.start, ...v.cuts];
  const bounds = [...starts, v.end];
  // Song i's start stays between the songs around it (at least a second each).
  const move = (i: number, to: number) => setVinyl((s) => {
    const all = [s.start, ...s.cuts];
    const lo = i === 0 ? 0 : all[i - 1] + 1;
    const hi = i === all.length - 1 ? s.end - 1 : all[i + 1] - 1;
    all[i] = Math.max(lo, Math.min(hi, to));
    return { start: all[0], cuts: all.slice(1) };
  });
  const others = v.sides.filter((_, i) => i !== v.side && !v.doneSides.includes(i));
  return (
    <div className="vinyl-check">
      <p className="caption muted">Side {side.label}, {clock(v.take.seconds)} recorded. Drag each numbered marker to where its song starts (or pick a song and click the wave), and play a few seconds to check.</p>
      <Wave env={v.take.envelope} of={v.take.seconds} marks={starts} selected={sel} onSelect={setSel} onMove={move} />
      <ol className="vinyl-songs">
        {side.tracks.map((t, i) => (
          <li key={i} className={i === sel ? "is-selected" : undefined} onClick={() => setSel(i)}>
            <span className="numeral muted">{String(i + 1).padStart(2, "0")}</span>
            <button type="button" className="vinyl-play" aria-label={`Play the start of ${t.title || `song ${i + 1}`}`} onClick={(e) => { e.stopPropagation(); void playFrom(bounds[i]); }}><Play size={12} aria-hidden="true" /></button>
            <input aria-label={`Title of song ${i + 1}`} value={t.title}
              onChange={(e) => setVinyl((s) => ({ sides: s.sides.map((x, j) => j === s.side ? { ...x, tracks: x.tracks.map((y, k) => k === i ? { ...y, title: e.target.value } : y) } : x) }))} />
            <span className="numeral muted vinyl-start-at">starts {clock(bounds[i])}</span>
            <span className="vinyl-nudge">
              <button type="button" aria-label="Start a second earlier" onClick={(e) => { e.stopPropagation(); setSel(i); move(i, bounds[i] - 1); }}>−1s</button>
              <button type="button" aria-label="Start a second later" onClick={(e) => { e.stopPropagation(); setSel(i); move(i, bounds[i] + 1); }}>+1s</button>
            </span>
            <span className="numeral">{clock(bounds[i + 1] - bounds[i])}</span>
          </li>
        ))}
      </ol>
      <div className="vinyl-check-foot">
        <span className="caption muted" style={{ flex: 1 }}>Saved as FLAC with the cover, in its own folder next to any CD of the same album.</span>
        <Button variant="ghost" onClick={() => { stopPreview(); void cancelSide(); }} disabled={v.saving}>Record it again</Button>
        <Button variant="primary" onClick={() => { stopPreview(); onSave(); }} disabled={v.saving}>
          {v.saving ? "Saving…" : others.length ? "Save, then the next side" : "Save"}
        </Button>
      </div>
    </div>
  );
}

/** In the corner while a side records (or has just ended) and you're elsewhere. */
export function VinylNotice({ go }: { go: Go }) {
  const v = useVinyl();
  if (v.shown || (!v.recording && !v.notice)) return null;
  return (
    <div className="rip-notice" role="status">
      <Disc3 className={v.recording ? "spin-slow" : undefined} size={20} strokeWidth={1.75} aria-hidden="true" />
      <button type="button" className="rip-notice-text" onClick={() => { setVinyl({ notice: null }); go({ name: "shelf", format: "vinyl" }); }}>
        <strong>{v.recording ? `Recording ${v.album || "your record"}` : v.notice}</strong>
        <span className="caption muted">{v.recording ? `Side ${v.sides[v.side]?.label ?? ""} · ${clock(v.seconds)}` : "Open the recorder"}</span>
      </button>
      {!v.recording && <button type="button" className="mc-icon-btn" aria-label="Close" onClick={() => setVinyl({ notice: null })}><X size={16} aria-hidden="true" /></button>}
    </div>
  );
}

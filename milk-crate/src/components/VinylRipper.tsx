import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Disc3, Pause, Play, Plus, Search, X } from "lucide-react";
import type { Go } from "../App";
import { Button } from "./ui";
import { Select } from "./Select";
import { useAddRipped } from "../lib/ripped";
import { albumKey } from "../lib/fileTags";
import {
  cancelSide, chooseRecord, enterByHand, loadInputs, pauseSide, playFrom, resetVinyl, saveSide, searchRecords,
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
  const sideName = side ? `Side ${side.label}` : "the side";

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
      {v.step === "record" && (v.recording ? <Recording side={side} /> : <NextSide sideName={sideName} saved={v.saved.length} />)}
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

/** The side as bars: loudness from the envelope, `of` seconds wide. */
function Wave({ env, of, marks = [], cuts, selected, onPick, now }: {
  env: number[]; of: number; marks?: { at: number; label: string }[]; cuts?: { at: number; unsure: boolean }[];
  selected?: number; onPick?: (at: number) => void; now?: number;
}) {
  const BARS = 220;
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
  return (
    <div className={`vinyl-wave${onPick ? " is-editable" : ""}`}>
      <div className="vinyl-wave-inner"
        onClick={onPick ? (e) => { const r = e.currentTarget.getBoundingClientRect(); onPick(((e.clientX - r.left) / r.width) * of); } : undefined}>
        <div className="vinyl-bars" aria-hidden="true">
          {bars.map((h, i) => <span key={i} className={h === null ? "is-ahead" : undefined} style={{ height: `${h ?? 6}%` }} />)}
        </div>
        {marks.map((m) => <span key={m.label + m.at} className="vinyl-mark" style={{ left: pct(m.at) }}><span>{m.label}</span></span>)}
        {cuts?.map((c, i) => <span key={i} className={`vinyl-cut${c.unsure ? " is-unsure" : ""}${i === selected ? " is-selected" : ""}`} style={{ left: pct(c.at) }} />)}
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
  const expected = side?.tracks.reduce((n, t) => n + (t.seconds ?? 0), 0) ?? 0;
  const of = Math.max(expected + 20, v.seconds + 30, 120);
  const marks = useMemo(() => {
    let at = 4;
    return (side?.tracks ?? []).map((t) => { const m = { at, label: t.title }; at += t.seconds ?? 0; return m; }).filter((_m, i) => i === 0 || (side?.tracks[i - 1].seconds ?? 0) > 0);
  }, [side]);
  const now = marks.filter((m) => m.at <= v.seconds).length;
  const level = Math.max(v.left, v.right);
  return (
    <div className="vinyl-recording">
      <div className="vinyl-rec-head">
        <span className="catalog eyebrow vinyl-live"><span aria-hidden="true" />{v.paused ? "Paused" : "Recording"} · Side {side?.label} of {v.sides.length}</span>
        <span className="vinyl-clock numeral">{clock(v.seconds)}{expected ? <span className="muted"> of about {clock(expected)}</span> : null}</span>
      </div>
      {now > 0 && side && <p className="caption muted">Now: {side.tracks[now - 1]?.title}, song {now} of {side.tracks.length}</p>}
      <Wave env={v.env} of={of} marks={marks} now={v.seconds} />
      <div className="vinyl-rec-foot">
        <div style={{ display: "flex", flexDirection: "column", gap: 4, width: 280 }}>
          <span className="catalog eyebrow">Level</span>
          <Meter level={level} clipped={v.clipped} />
          <span className="caption muted">{v.clipped ? "Too loud in places: turn the turntable's gain down a little." : level < 0.05 && v.seconds > 5 ? "Very quiet. Is the needle down?" : "Stops on its own when the side ends."}</span>
        </div>
        <div style={{ flex: 1 }} />
        <Button variant="ghost" onClick={() => void cancelSide()}>Cancel</Button>
        <Button onClick={() => void pauseSide(!v.paused)}>{v.paused ? <><Play size={16} aria-hidden="true" /> Resume</> : <><Pause size={16} aria-hidden="true" /> Pause</>}</Button>
        <Button variant="primary" onClick={() => void stopSide()}>Stop and check songs</Button>
      </div>
    </div>
  );
}

function NextSide({ sideName, saved }: { sideName: string; saved: number }) {
  return (
    <div className="vinyl-next">
      <p>{saved ? <>Saved {saved} {saved === 1 ? "song" : "songs"}. Flip the record to <strong>{sideName}</strong>.</> : <>Ready for <strong>{sideName}</strong>.</>}</p>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <Button variant="primary" onClick={() => void startSide()}>Record {sideName}</Button>
        <span className="caption muted">Press it, then drop the needle.</span>
        {saved > 0 && <Button variant="ghost" onClick={() => setVinyl({ step: "done" })}>I'm done</Button>}
      </div>
    </div>
  );
}

/* ---------- 3. Check the songs ---------- */

function Check({ side, onSave }: { side?: Side; onSave: () => void }) {
  const v = useVinyl();
  const [sel, setSel] = useState(0);
  if (!v.take || !side) return null;
  const bounds = [v.start, ...v.cuts, v.end];
  const move = (i: number, to: number) => setVinyl((s) => {
    const lo = i === 0 ? s.start + 1 : s.cuts[i - 1] + 1;
    const hi = i === s.cuts.length - 1 ? s.end - 1 : s.cuts[i + 1] - 1;
    const cuts = [...s.cuts];
    cuts[i] = Math.max(lo, Math.min(hi, to));
    const unsure = [...s.unsure];
    unsure[i] = false;
    return { cuts, unsure };
  });
  const next = v.side < v.sides.length - 1 ? v.sides[v.side + 1] : null;
  return (
    <div className="vinyl-check">
      <p className="caption muted">Found {side.tracks.length} songs on side {side.label} ({clock(v.take.seconds)} recorded). Pick a split below, then click the wave where that song starts, or nudge it. Play a few seconds to check.</p>
      <Wave env={v.take.envelope} of={v.take.seconds} cuts={v.cuts.map((at, i) => ({ at, unsure: v.unsure[i] }))} selected={sel - 1}
        onPick={v.cuts.length ? (at) => move(Math.max(0, sel - 1), at) : undefined} />
      <ol className="vinyl-songs">
        {side.tracks.map((t, i) => (
          <li key={i} className={i === sel ? "is-selected" : undefined} onClick={() => setSel(i)}>
            <span className="numeral muted">{String(i + 1).padStart(2, "0")}</span>
            <button type="button" className="vinyl-play" aria-label={`Play the start of ${t.title || `song ${i + 1}`}`} onClick={(e) => { e.stopPropagation(); void playFrom(bounds[i]); }}><Play size={12} aria-hidden="true" /></button>
            <input aria-label={`Title of song ${i + 1}`} value={t.title}
              onChange={(e) => setVinyl((s) => ({ sides: s.sides.map((x, j) => j === s.side ? { ...x, tracks: x.tracks.map((y, k) => k === i ? { ...y, title: e.target.value } : y) } : x) }))} />
            <span>{i > 0 && v.unsure[i - 1] && <span className="vinyl-flag" title="It wasn't clearly quiet here, or it's far from where this song should start. Give it a listen.">Check</span>}</span>
            <span className="numeral muted vinyl-start-at">starts {clock(bounds[i] - v.start)}</span>
            {i > 0 ? (
              <span className="vinyl-nudge">
                <button type="button" aria-label="Start a second earlier" onClick={(e) => { e.stopPropagation(); move(i - 1, v.cuts[i - 1] - 1); }}>−1s</button>
                <button type="button" aria-label="Start a second later" onClick={(e) => { e.stopPropagation(); move(i - 1, v.cuts[i - 1] + 1); }}>+1s</button>
              </span>
            ) : <span className="vinyl-nudge" />}
            <span className="numeral">{clock(bounds[i + 1] - bounds[i])}</span>
          </li>
        ))}
      </ol>
      <div className="vinyl-check-foot">
        <span className="caption muted" style={{ flex: 1 }}>Saved as FLAC with the cover, in its own folder next to any CD of the same album.</span>
        <Button variant="ghost" onClick={() => { stopPreview(); void cancelSide(); }} disabled={v.saving}>Record it again</Button>
        <Button variant="primary" onClick={() => { stopPreview(); onSave(); }} disabled={v.saving}>
          {v.saving ? "Saving…" : next ? `Save and record side ${next.label}` : "Save"}
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

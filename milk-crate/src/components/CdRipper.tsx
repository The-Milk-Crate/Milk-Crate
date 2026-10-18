import { useEffect, useRef } from "react";
import { Disc3, ImagePlus, LoaderCircle, Lock, X } from "lucide-react";
import { albumFolder, cancelRip, ejectDisc, fetchCover, findDiscs, imageAsDataUrl, lookupDisc, ripDisc, type CdMatch, type Disc } from "../lib/cd";
import { pickImage } from "../lib/localFiles";
import { ripState, useRip, setRip, type Draft } from "../lib/ripSession";
import { formatTime } from "../lib/format";
import { Button, Sleeve } from "./ui";


const blank = (d: Disc): Draft => ({
  album: "",
  artist: "",
  year: "",
  titles: d.tracks.map((t) => `Track ${String(t.number).padStart(2, "0")}`),
  artists: d.tracks.map(() => ""),
  cover: null,
  disc: 1,
  discs: 1,
});

const fromMatch = (m: CdMatch): Draft => ({
  album: m.title,
  artist: m.artist,
  year: m.year ?? "",
  titles: m.tracks.map((t) => t.title),
  // A song's own artist only when it differs from the album's (features, compilations).
  artists: m.tracks.map((t) => (t.artist === m.artist ? "" : t.artist)),
  cover: null,
  disc: m.disc || 1,
  discs: Math.max(m.discs || 1, m.disc || 1),
});

/**
 * Your Computer › Rip a CD: finds the audio CD, fills in the album from MusicBrainz (names, order,
 * cover), lets you fix anything, then saves each song as a tagged FLAC in Music › Milk Crate.
 */
export function CdRipper({ onClose, onRipped }: { onClose: () => void; onRipped: (files: string[]) => Promise<string | undefined> }) {
  // All of this lives outside the page (src/lib/ripSession.ts), so a rip carries on while you
  // browse the rest of the app, and it's all still here when you come back.
  const [disc, setDisc] = useRip("disc");
  const [matches, setMatches] = useRip("matches");
  const [pick, setPick] = useRip("pick");
  const [found, setFound] = useRip("found");
  const [draft, setDraft] = useRip("draft");
  const [coverBusy, setCoverBusy] = useRip("coverBusy");
  const [progress] = useRip("progress");
  const [ripping] = useRip("ripping");
  const [done, setDone] = useRip("done");
  const [error, setError] = useRip("error");
  const [notes, setNotes] = useRip("notes");
  const [nextDisc] = useRip("nextDisc");

  // On screen: a rip that finishes now needs no notice.
  useEffect(() => {
    setRip({ shown: true, notice: null });
    return () => setRip({ shown: false });
  }, []);

  // Watch the drives until there's a CD (and notice when it's taken out).
  const discId = disc?.discId;
  const busy = useRef(false);
  busy.current = ripping;
  useEffect(() => {
    let live = true;
    const check = async () => {
      if (busy.current) return;
      const found = await findDiscs().catch((e) => ({ discs: [] as Disc[], notes: [`Couldn't check the CD drives: ${String(e)}`] }));
      if (!live) return;
      setNotes(found.notes);
      const d = found.discs[0] ?? null;
      setDisc((old) => (old?.discId === d?.discId && old?.id === d?.id ? old : d));
    };
    void check();
    const timer = setInterval(check, 3000);
    return () => { live = false; clearInterval(timer); };
  }, []);

  // A new disc: look it up (not again for the same disc when you come back to the page).
  useEffect(() => {
    if (!disc || ripState().lookedUp === disc.discId) return;
    setRip({ lookedUp: disc.discId });
    let live = true;
    setDone(null);
    setError("");
    setFound("looking");
    setMatches([]);
    setPick(0);
    // The next disc of a set: it keeps the album's name, artist, year and cover.
    const next = ripState().nextDisc;
    const carry = (d: Draft): Draft => (next ? { ...d, album: next.album, artist: next.artist, year: next.year, cover: next.cover, disc: next.disc, discs: next.discs } : d);
    setDraft(carry(blank(disc)));
    lookupDisc(disc.id)
      .then((m) => {
        if (!live) return;
        // Same release, this disc of it, first (MusicBrainz knows which disc of the set it is).
        const at = next ? m.findIndex((x) => x.releaseId === next.releaseId && x.disc === next.disc) : -1;
        const list = at > 0 ? [m[at], ...m.filter((_, i) => i !== at)] : m;
        setMatches(list);
        setFound(list.length ? "found" : "unknown");
        if (next && at >= 0) {
          setRip({ coverFor: list[0].releaseId });
          setDraft({ ...fromMatch(list[0]), album: next.album, artist: next.artist, year: next.year, cover: next.cover });
        } else if (list.length && !next) setDraft(fromMatch(list[0]));
        else if (list.length && next) setDraft(carry({ ...fromMatch(list[0]) }));
        if (next) setRip({ nextDisc: null });
      })
      .catch(() => live && setFound("offline"));
    return () => { live = false; };
  }, [discId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The chosen edition's cover.
  const chosen = matches[pick];
  useEffect(() => {
    if (!chosen || ripState().coverFor === chosen.releaseId) return;
    setRip({ coverFor: chosen.releaseId });
    let live = true;
    setCoverBusy(true);
    fetchCover(chosen.releaseId)
      .then((c) => live && setDraft((d) => (d ? { ...d, cover: c ?? null } : d)))
      .catch(() => {})
      .finally(() => live && setCoverBusy(false));
    return () => { live = false; };
  }, [chosen?.releaseId]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (i: number) => {
    setPick(i);
    setDraft(fromMatch(matches[i]));
  };

  const chooseCover = async () => {
    const src = await pickImage();
    if (!src) return;
    const url = await imageAsDataUrl(src).catch(() => null);
    if (url) setDraft((d) => (d ? { ...d, cover: url } : d));
    else setError("That picture needs to be a JPEG or PNG.");
  };

  /** `only`: just these track numbers (trying skipped songs again). */
  const rip = async (only?: number[]) => {
    if (!disc || !draft) return;
    setRip({ error: "", ripping: true, progress: null });
    const artist = draft.artist.trim() || "Unknown Artist";
    const album = draft.album.trim() || "Unknown Album";
    try {
      const { files, skipped } = await ripDisc(
        disc.id,
        {
          album,
          albumArtist: artist,
          year: draft.year.trim() || null,
          releaseId: chosen?.releaseId ?? null,
          disc: draft.disc,
          discs: draft.discs,
          tracks: disc.tracks
            .map((t, i) => ({ number: t.number, title: draft.titles[i]?.trim() || `Track ${String(t.number).padStart(2, "0")}`, artist: draft.artists[i]?.trim() ?? "" }))
            .filter((t) => !only || only.includes(t.number)),
          cover: draft.cover,
        },
        (p) => setRip({ progress: p }),
      );
      const albumKey = await onRipped(files);
      // Trying skipped songs again: count them with the ones saved the first time.
      const before = ripState().done;
      const result = { count: files.length + (only && before ? before.count : 0), folder: albumFolder(artist, album), skipped, album, artist, albumKey };
      // Finished while you were elsewhere in the app: say so in the corner.
      setRip((s) => ({ done: result, notice: s.shown ? null : result }));
      // One disc of a set: ask for the next one.
      if (!only && draft.discs > draft.disc) {
        setRip({
          nextDisc: { disc: draft.disc + 1, discs: draft.discs, album, artist, year: draft.year, cover: draft.cover, releaseId: chosen?.releaseId, after: disc.discId },
        });
        // Out it comes, ready for the next one.
        void ejectDisc(disc.id).catch(() => {});
      }
    } catch (e) {
      const msg = String(e);
      setRip({ error: msg === "Stopped" ? "Stopped. Songs already saved are kept." : msg });
    } finally {
      setRip({ ripping: false });
    }
  };

  const eject = () => {
    if (disc) void ejectDisc(disc.id).catch((e) => setError(String(e)));
  };

  const edit = (k: "titles" | "artists", i: number, v: string) =>
    setDraft((d) => (d ? { ...d, [k]: d[k].map((x, j) => (j === i ? v : x)) } : d));

  const variousArtists = !!draft && draft.artists.some((a) => a.trim());
  const current = progress && disc ? draft?.titles[progress.at - 1] : undefined;

  return (
    <section className="panel cd-ripper" aria-labelledby="cd-ripper-title">
      <div className="cd-ripper-head">
        <h2 id="cd-ripper-title" className="display-md">Rip a CD</h2>
        <button type="button" className="mc-icon-btn" aria-label="Close" onClick={onClose} disabled={ripping}><X size={18} aria-hidden="true" /></button>
      </div>

      {nextDisc && !ripping && (
        <div className="cd-ripper-next" role="status">
          <Disc3 size={22} strokeWidth={1.6} aria-hidden="true" />
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}>
            <strong>Disc {nextDisc.disc - 1} is done. Put in disc {nextDisc.disc} of {nextDisc.discs}.</strong>
            <span className="caption muted">{nextDisc.album} keeps its name, artist and cover, and the songs go in a Disc {nextDisc.disc} folder beside the others.</span>
          </div>
          {disc && disc.discId === nextDisc.after && <Button size="sm" onClick={eject}>Eject</Button>}
          <button type="button" className="link-btn caption" onClick={() => setRip({ nextDisc: null })}>That's all of them</button>
        </div>
      )}
      {disc === undefined && <p className="muted cd-ripper-wait"><LoaderCircle className="spin" size={16} aria-hidden="true" /> Checking your CD drive…</p>}
      {disc === null && (
        <div className="empty cd-ripper-empty">
          <Disc3 size={28} strokeWidth={1.5} aria-hidden="true" />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span>Put an audio CD in your drive. It'll show up here.</span>
            {notes.map((n) => <span key={n} className="caption muted">{n}</span>)}
          </div>
        </div>
      )}

      {disc && draft && (
        <>
          <div className="cd-ripper-album">
            <div className="cd-ripper-cover">
              <Sleeve src={draft.cover ?? undefined} seed={`${draft.album}|${draft.artist}|${disc.discId}`} alt={draft.album ? `${draft.album} cover` : "Cover"} />
              {coverBusy && <span className="cd-ripper-cover-busy"><LoaderCircle className="spin" size={20} aria-hidden="true" /></span>}
              <button type="button" className="link-btn caption" onClick={() => void chooseCover()} disabled={ripping}>
                <ImagePlus size={14} aria-hidden="true" /> {draft.cover ? "Change cover" : "Add a cover"}
              </button>
            </div>
            <div className="cd-ripper-fields">
              <span className="catalog eyebrow">
                {disc.label} · {disc.tracks.length} songs · {formatTime(disc.seconds)}
              </span>
              <p className="caption muted" role="status">
                {found === "looking" && "Looking up this CD on MusicBrainz…"}
                {found === "unknown" && "This CD isn't on MusicBrainz. Type in the names and they'll be saved in the files."}
                {found === "offline" && "Couldn't reach MusicBrainz. Type in the names, or check your connection."}
              </p>
              {matches.length > 1 && (
                <label className="field">
                  <span className="caption">Edition</span>
                  <select value={pick} onChange={(e) => choose(Number(e.target.value))} disabled={ripping}>
                    {matches.map((m, i) => (
                      <option key={`${m.releaseId}-${m.disc}`} value={i}>
                        {m.title} — {m.artist}{m.detail ? ` (${m.detail})` : ""}{m.discs > 1 ? ` · disc ${m.disc} of ${m.discs}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="field">
                <span className="caption">Album</span>
                <input value={draft.album} placeholder="Unknown Album" onChange={(e) => setDraft({ ...draft, album: e.target.value })} disabled={ripping} />
              </label>
              <div className="cd-ripper-row">
                <label className="field" style={{ flex: "1 1 220px" }}>
                  <span className="caption">Artist</span>
                  <input value={draft.artist} placeholder="Unknown Artist" onChange={(e) => setDraft({ ...draft, artist: e.target.value })} disabled={ripping} />
                </label>
                <label className="field" style={{ flex: "0 0 96px" }}>
                  <span className="caption">Year</span>
                  <input value={draft.year} inputMode="numeric" maxLength={4} onChange={(e) => setDraft({ ...draft, year: e.target.value.replace(/\D/g, "") })} disabled={ripping} />
                </label>
                {/* A set of several CDs: which one this is, and how many there are. */}
                <div className="field cd-ripper-discs" role="group" aria-label="Disc">
                  <span className="caption">Disc</span>
                  <span className="cd-ripper-discs-row">
                    <input aria-label="This disc" inputMode="numeric" value={draft.disc} disabled={ripping}
                      onChange={(e) => { const n = Math.max(1, Math.min(20, Number(e.target.value.replace(/\D/g, "")) || 1)); setDraft({ ...draft, disc: n, discs: Math.max(draft.discs, n) }); }} />
                    <span className="caption muted">of</span>
                    <input aria-label="Discs in this album" inputMode="numeric" value={draft.discs} disabled={ripping}
                      onChange={(e) => { const n = Math.max(1, Math.min(20, Number(e.target.value.replace(/\D/g, "")) || 1)); setDraft({ ...draft, discs: n, disc: Math.min(draft.disc, n) }); }} />
                  </span>
                </div>
              </div>
            </div>
          </div>

          <ol className="cd-ripper-tracks">
            {disc.tracks.map((t, i) => {
              const state = progress && ripping ? (i + 1 < progress.at ? "done" : i + 1 === progress.at ? "now" : "")
                : done ? (done.skipped.some((s) => s.number === t.number) ? "skipped" : "done") : "";
              return (
                <li key={t.number} className={`cd-ripper-track ${state}`}>
                  <span className="numeral muted">{String(t.number).padStart(2, "0")}</span>
                  <input aria-label={`Song ${t.number} title`} value={draft.titles[i] ?? ""} onChange={(e) => edit("titles", i, e.target.value)} disabled={ripping} />
                  {variousArtists && (
                    <input className="cd-ripper-track-artist" aria-label={`Song ${t.number} artist`} placeholder={draft.artist || "Artist"} value={draft.artists[i] ?? ""} onChange={(e) => edit("artists", i, e.target.value)} disabled={ripping} />
                  )}
                  <span className="numeral muted">{formatTime(t.seconds)}</span>
                </li>
              );
            })}
          </ol>

          {ripping && (
            <div className="cd-ripper-progress" role="status">
              <div className="mc-progress-rail"><div className="mc-progress-fill" style={{ width: `${Math.round((progress?.overall ?? 0) * 100)}%` }} /></div>
              <span className="caption muted">
                {progress ? `Ripping ${progress.at} of ${progress.of}${current ? ` · ${current}` : ""} · ${Math.round(progress.overall * 100)}%` : "Starting…"}
              </span>
            </div>
          )}
          {done && !ripping && (
            <p className="form-info" role="status">
              Saved {done.count} {done.count === 1 ? "song" : "songs"} as FLAC in {done.folder}. They're in Your Computer now.
              {done.skipped.length > 0 && (
                <> Skipped {done.skipped.map((s) => `${s.number} · ${s.title}`).join(", ")}: {done.skipped.length === 1 ? "it couldn't" : "they couldn't"} be read, so the disc may be scratched or dirty there. Wipe it with a soft cloth, from the middle out, and try {done.skipped.length === 1 ? "it" : "them"} again.</>
              )}
            </p>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}

          <p className="caption muted private-note">
            <Lock size={13} aria-hidden="true" />
            <span>Only rip CDs you own, for your own listening. Ripped music stays on this computer and is never uploaded or shared.</span>
          </p>
          <div className="cd-ripper-actions">
            {ripping ? (
              <Button onClick={() => void cancelRip()}>Stop</Button>
            ) : (
              <>
                {done && done.skipped.length > 0 ? (
                  <Button variant="primary" onClick={() => void rip(done.skipped.map((s) => s.number))}>
                    <Disc3 size={16} aria-hidden="true" /> Try the skipped {done.skipped.length === 1 ? "song" : "songs"} again
                  </Button>
                ) : null}
                <Button variant={done && done.skipped.length > 0 ? "quiet" : "primary"} onClick={() => void rip()} disabled={found === "looking"}>
                  <Disc3 size={16} aria-hidden="true" /> {done ? "Rip the whole CD again" : "Rip to FLAC"}
                </Button>
                <Button variant="ghost" onClick={eject}>Eject</Button>
              </>
            )}
            {!ripping && <span className="caption muted">Saves to {albumFolder(draft.artist || "Unknown Artist", draft.album || "Unknown Album")}</span>}
          </div>
        </>
      )}
    </section>
  );
}

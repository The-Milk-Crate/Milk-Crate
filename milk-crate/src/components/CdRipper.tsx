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
});

const fromMatch = (m: CdMatch): Draft => ({
  album: m.title,
  artist: m.artist,
  year: m.year ?? "",
  titles: m.tracks.map((t) => t.title),
  // A song's own artist only when it differs from the album's (features, compilations).
  artists: m.tracks.map((t) => (t.artist === m.artist ? "" : t.artist)),
  cover: null,
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
    setDraft(blank(disc));
    lookupDisc(disc.id)
      .then((m) => {
        if (!live) return;
        setMatches(m);
        setFound(m.length ? "found" : "unknown");
        if (m.length) setDraft(fromMatch(m[0]));
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
          disc: chosen?.disc ?? 1,
          discs: chosen?.discs ?? 1,
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

import { useEffect, useRef, useState } from "react";
import { Disc3, ImagePlus, LoaderCircle, X } from "lucide-react";
import { albumFolder, cancelRip, ejectDisc, fetchCover, findDiscs, imageAsDataUrl, lookupDisc, ripDisc, type CdMatch, type Disc, type RipProgress } from "../lib/cd";
import { pickImage } from "../lib/localFiles";
import { formatTime } from "../lib/format";
import { Button, Sleeve } from "./ui";

type Found = "looking" | "found" | "unknown" | "offline";

interface Draft {
  album: string;
  artist: string;
  year: string;
  titles: string[];
  artists: string[];
  cover: string | null;
}

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
export function CdRipper({ onClose, onRipped }: { onClose: () => void; onRipped: (files: string[]) => Promise<void> }) {
  const [disc, setDisc] = useState<Disc | null | undefined>(undefined);
  const [matches, setMatches] = useState<CdMatch[]>([]);
  const [pick, setPick] = useState(0);
  const [found, setFound] = useState<Found>("looking");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [coverBusy, setCoverBusy] = useState(false);
  const [progress, setProgress] = useState<RipProgress | null>(null);
  const [ripping, setRipping] = useState(false);
  const [done, setDone] = useState<{ count: number; folder: string } | null>(null);
  const [error, setError] = useState("");

  // Watch the drives until there's a CD (and notice when it's taken out).
  const discId = disc?.discId;
  const busy = useRef(false);
  busy.current = ripping;
  useEffect(() => {
    let live = true;
    const check = async () => {
      if (busy.current) return;
      const all = await findDiscs().catch(() => [] as Disc[]);
      if (!live) return;
      const d = all[0] ?? null;
      setDisc((old) => (old?.discId === d?.discId && old?.id === d?.id ? old : d));
    };
    void check();
    const timer = setInterval(check, 3000);
    return () => { live = false; clearInterval(timer); };
  }, []);

  // A new disc: look it up.
  useEffect(() => {
    if (!disc) return;
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
    if (!chosen) return;
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

  const rip = async () => {
    if (!disc || !draft) return;
    setError("");
    setRipping(true);
    setProgress(null);
    const artist = draft.artist.trim() || "Unknown Artist";
    const album = draft.album.trim() || "Unknown Album";
    try {
      const files = await ripDisc(
        disc.id,
        {
          album,
          albumArtist: artist,
          year: draft.year.trim() || null,
          releaseId: chosen?.releaseId ?? null,
          disc: chosen?.disc ?? 1,
          discs: chosen?.discs ?? 1,
          tracks: disc.tracks.map((t, i) => ({ number: t.number, title: draft.titles[i]?.trim() || `Track ${String(t.number).padStart(2, "0")}`, artist: draft.artists[i]?.trim() ?? "" })),
          cover: draft.cover,
        },
        setProgress,
      );
      await onRipped(files);
      setDone({ count: files.length, folder: albumFolder(artist, album) });
    } catch (e) {
      const msg = String(e);
      setError(msg === "Stopped" ? "Stopped. Songs already saved are kept." : msg);
    } finally {
      setRipping(false);
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
          <span>Put an audio CD in your drive. It'll show up here.</span>
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
                {found === "found" && (chosen?.exact ? "Found it on MusicBrainz. Fix anything that's off before you rip." : "Found a close match on MusicBrainz. Check the names before you rip.")}
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
              const state = progress && ripping ? (i + 1 < progress.at ? "done" : i + 1 === progress.at ? "now" : "") : done ? "done" : "";
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
            <p className="form-info" role="status">Saved {done.count} songs as FLAC in {done.folder}. They're in Your Computer now.</p>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}

          <div className="cd-ripper-actions">
            {ripping ? (
              <Button onClick={() => void cancelRip()}>Stop</Button>
            ) : (
              <>
                <Button variant="primary" onClick={() => void rip()} disabled={found === "looking"}>
                  <Disc3 size={16} aria-hidden="true" /> {done ? "Rip again" : "Rip to FLAC"}
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

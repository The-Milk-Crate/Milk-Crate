import { useState } from "react";
import { ArrowDown, ArrowUp, FileAudio, FileText, ImagePlus, Music, Trash2, Undo2 } from "lucide-react";
import { ReleaseDateField } from "../components/ReleaseDate";
import type { Go } from "../App";
import { useCatalog } from "../lib/catalog";
import { formatTime } from "../lib/format";
import { pickAudioFiles, pickImage, readDuration } from "../lib/localFiles";
import { sleeveSeed } from "../lib/sleeve";
import type { Release } from "../lib/types";
import { Button, Sleeve } from "../components/ui";

/** A song in the editor. `id` = already published; `src` = a new file (new song, or replacing the old audio). */
interface Row { key: string; id?: string; title: string; duration: number; src?: string; fileName?: string; lyrics: string; credits: string }

/**
 * Edit a published release: its title, type, year, cover and release date, and
 * its songs: rename, reorder, add lyrics and credits, replace a song's audio,
 * remove songs or add new ones.
 * A song that stays (even with new audio) keeps its streams, favorites and
 * place in people's playlists.
 */
export function EditRelease({ releaseId, go }: { releaseId: string; go: Go }) {
  const c = useCatalog();
  const release = c.myReleases.find((r) => r.id === releaseId);
  const [title, setTitle] = useState(release?.title ?? "");
  const [kind, setKind] = useState<Release["kind"]>(release?.kind ?? "EP");
  const [year, setYear] = useState(release?.year ?? new Date().getFullYear());
  /** undefined = keep, null = remove, string = new file. */
  const [art, setArt] = useState<string | null | undefined>(undefined);
  const [releaseAt, setReleaseAt] = useState<string | null>(release?.releaseAt && Date.parse(release.releaseAt) > Date.now() ? release.releaseAt : null);
  const [openInfo, setOpenInfo] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>(() =>
    (release?.trackIds ?? []).map((id) => c.trackById[id]).filter(Boolean).map((t) => ({ key: t.id, id: t.id, title: t.title, duration: t.duration, lyrics: t.lyrics ?? "", credits: t.credits ?? "" })),
  );
  const [removed, setRemoved] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  if (!c.myProfile) return <div className="screen"><p className="muted">Sign in to your artist account to edit releases.</p></div>;
  if (!release) return <div className="screen"><p className="muted">That release isn't one of yours, or it was removed.</p><div><Button onClick={() => go({ name: "upload" })}>Back to For Artists</Button></div></div>;

  const shownArt = art === undefined ? release.art : art ?? undefined;
  const move = (i: number, to: number) => setRows((rs) => {
    if (to < 0 || to >= rs.length) return rs;
    const next = [...rs];
    const [r] = next.splice(i, 1);
    next.splice(to, 0, r);
    return next;
  });
  const remove = (row: Row) => {
    setRows((rs) => rs.filter((r) => r.key !== row.key));
    if (row.id) setRemoved((rs) => [...rs, row]);
  };
  const undoRemove = (row: Row) => {
    setRemoved((rs) => rs.filter((r) => r.key !== row.key));
    setRows((rs) => [...rs, row]);
  };
  const addSongs = async () => {
    const picked = await pickAudioFiles();
    if (!picked.length) return;
    setLoading(true);
    const added = await Promise.all(picked.map(async (t) => ({ key: `new-${t.id}-${Math.random()}`, title: t.title, src: t.src!, duration: await readDuration(t.src!), fileName: t.title, lyrics: "", credits: "" })));
    setRows((rs) => [...rs, ...added]);
    setLoading(false);
  };
  const replaceFile = async (row: Row) => {
    const [picked] = await pickAudioFiles();
    if (!picked) return;
    setLoading(true);
    const duration = await readDuration(picked.src!);
    setRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, src: picked.src!, duration, fileName: picked.title } : r)));
    setLoading(false);
  };
  const undoReplace = (row: Row) => {
    const t = row.id ? c.trackById[row.id] : undefined;
    if (t) setRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, src: undefined, fileName: undefined, duration: t.duration } : r)));
  };

  const save = async () => {
    if (!title.trim()) return setError("Give the release a title.");
    if (!rows.length) return setError("A release needs at least one song. To take the whole release down, use Remove on the For Artists screen.");
    if (rows.some((r) => !r.title.trim())) return setError("Every song needs a title.");
    setError("");
    setSaved(false);
    try {
      await c.updateRelease(releaseId, { title: title.trim(), kind, year, art, releaseAt },
        rows.map((r) => ({ id: r.id, title: r.title.trim(), duration: r.duration, src: r.src, lyrics: r.lyrics.trim(), credits: r.credits.trim() })), setProgress);
      setArt(undefined);
      setRemoved([]);
      setSaved(true);
    } catch (e) {
      setProgress("");
      setError(`Couldn't save everything: ${(e as Error).message}`);
    }
  };

  const busy = !!progress || loading;
  const total = rows.reduce((s, r) => s + r.duration, 0);

  return (
    <div className="screen" style={{ maxWidth: 900 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="catalog eyebrow">Edit release</span>
        <h1 className="display-lg" style={{ overflowWrap: "anywhere" }}>{release.title}</h1>
        <p className="caption muted" style={{ maxWidth: 620 }}>Changes go live for everyone as soon as you save. Songs you keep (even with a new audio file) keep their streams, favorites and spots in people's playlists.</p>
      </header>

      <section className="panel">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
          <div style={{ width: 180, flex: "none", display: "flex", flexDirection: "column", gap: 8 }}>
            <Sleeve src={shownArt} seed={sleeveSeed(title || release.title, c.myProfile.name)} alt="Cover art" />
            <Button size="sm" disabled={busy} onClick={async () => { const a = await pickImage(); if (a) setArt(a); }}>
              <ImagePlus size={16} strokeWidth={1.75} aria-hidden="true" /> {shownArt ? "Change cover" : "Add cover art"}
            </Button>
            {shownArt && <button type="button" className="link-btn caption" disabled={busy} onClick={() => setArt(null)}>Remove cover (use a made-up sleeve)</button>}
            {art !== undefined && <button type="button" className="link-btn caption" disabled={busy} onClick={() => setArt(undefined)}>Undo cover change</button>}
          </div>
          <div style={{ flex: "1 1 320px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
            <label className="field">
              <span className="catalog eyebrow">Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
              <div className="field">
                <span className="catalog eyebrow" id="edit-kind-label">Type</span>
                <div role="group" aria-labelledby="edit-kind-label" style={{ display: "flex", gap: 8 }}>
                  {(["Single", "EP", "LP"] as const).map((k) => (
                    <button key={k} type="button" className="chip" aria-pressed={kind === k} onClick={() => setKind(k)}>{k}</button>
                  ))}
                </div>
              </div>
              <label className="field" style={{ width: 110 }}>
                <span className="catalog eyebrow">Year</span>
                <input type="number" value={year} min={1900} max={2100} onChange={(e) => setYear(Number(e.target.value))} />
              </label>
            </div>
            <ReleaseDateField value={releaseAt} onChange={setReleaseAt} />
            {release.releaseAt && !releaseAt && Date.parse(release.releaseAt) > Date.now() && <p className="caption muted">Saving puts it out right away.</p>}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span className="catalog eyebrow">Songs · {rows.length} · {formatTime(total)}</span>
            <Button size="sm" onClick={addSongs} disabled={busy}>
              <Music size={16} strokeWidth={1.75} aria-hidden="true" /> {loading ? "Reading files…" : "Add songs"}
            </Button>
          </div>
          <ol className="upload-tracks edit-tracks">
            {rows.map((r, i) => (
              <li key={r.key}>
                <span className="numeral muted" style={{ width: 24, textAlign: "center" }}>{String(i + 1).padStart(2, "0")}</span>
                <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: "1 1 auto", minWidth: 0 }}>
                  <input aria-label={`Song ${i + 1} title`} value={r.title} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, title: e.target.value } : x)))} />
                  {!r.id && <span className="caption edit-note">New song</span>}
                  {r.id && r.src && (
                    <span className="caption edit-note">
                      New audio: {r.fileName} · <button type="button" className="link-btn caption" onClick={() => undoReplace(r)}>keep the old file</button>
                    </span>
                  )}
                </span>
                <span className="numeral muted">{r.duration ? formatTime(r.duration) : "—"}</span>
                <span className="edit-actions">
                  <button type="button" className="mc-icon-btn" aria-label={`Move ${r.title} up`} disabled={i === 0} onClick={() => move(i, i - 1)}><ArrowUp size={16} strokeWidth={1.75} aria-hidden="true" /></button>
                  <button type="button" className="mc-icon-btn" aria-label={`Move ${r.title} down`} disabled={i === rows.length - 1} onClick={() => move(i, i + 1)}><ArrowDown size={16} strokeWidth={1.75} aria-hidden="true" /></button>
                  <button type="button" className={`mc-icon-btn${r.lyrics || r.credits ? " has-info" : ""}`} aria-label={`Lyrics and credits for ${r.title}`} title="Lyrics and credits"
                    aria-expanded={openInfo === r.key} onClick={() => setOpenInfo(openInfo === r.key ? null : r.key)}><FileText size={16} strokeWidth={1.75} aria-hidden="true" /></button>
                  {r.id && <button type="button" className="mc-icon-btn" aria-label={`Replace the audio file for ${r.title}`} title="Replace the audio file" disabled={busy} onClick={() => void replaceFile(r)}><FileAudio size={16} strokeWidth={1.75} aria-hidden="true" /></button>}
                  <button type="button" className="mc-icon-btn" aria-label={`Remove ${r.title}`} onClick={() => remove(r)}><Trash2 size={16} strokeWidth={1.75} aria-hidden="true" /></button>
                </span>
                {openInfo === r.key && (
                  <div className="song-info-edit">
                    <label className="field">
                      <span className="catalog eyebrow">Lyrics</span>
                      <textarea rows={8} maxLength={20000} value={r.lyrics} placeholder="The words, as you'd like people to read them."
                        onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, lyrics: e.target.value } : x)))} />
                    </label>
                    <label className="field">
                      <span className="catalog eyebrow">Credits</span>
                      <textarea rows={8} maxLength={4000} value={r.credits} placeholder={"One per line, like:\nVocals, guitar: Sam Ortiz\nDrums: Lee Park\nRecorded at Kingsbury Studio"}
                        onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, credits: e.target.value } : x)))} />
                    </label>
                  </div>
                )}
              </li>
            ))}
          </ol>
          {removed.length > 0 && (
            <div className="edit-removed" role="status">
              <span className="caption">
                Removing {removed.map((r) => `"${r.title}"`).join(", ")} when you save. {removed.length === 1 ? "Its" : "Their"} streams and favorites go too.
              </span>
              {removed.map((r) => (
                <button key={r.key} type="button" className="link-btn caption" onClick={() => undoRemove(r)}><Undo2 size={12} aria-hidden="true" /> Keep "{r.title}"</button>
              ))}
            </div>
          )}
        </div>

        {error && <p role="alert" className="form-error">{error}</p>}
        {saved && !progress && <p role="status" className="form-info">Saved. It's live for everyone.</p>}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>{progress || "Save changes"}</Button>
          <Button variant="ghost" onClick={() => go({ name: "album", releaseId })} disabled={!!progress}>See the album page</Button>
        </div>
      </section>
    </div>
  );
}

import { useState } from "react";
import { COUNTRY_NAMES } from "../lib/geo";
import { Trash2, ImagePlus, Music, Pencil } from "lucide-react";
import type { Go } from "../App";
import { formatTime } from "../lib/format";
import { useCatalog } from "../lib/catalog";
import { useAuth } from "../lib/auth";
import { pickAudioFiles, pickImage, readDuration } from "../lib/localFiles";
import { sleeveSeed } from "../lib/sleeve";
import type { Release } from "../lib/types";
import { Button, ReleaseCard, Sleeve } from "../components/ui";
import { ArtistThumb } from "../components/ArtistBanner";
import { PageDesigner } from "./PageDesigner";
import { AuthForm } from "../components/AuthForm";
import { CityPicker } from "../components/CityPicker";
import { ReleaseDateField, shortReleaseDate } from "../components/ReleaseDate";
import { isUpcoming } from "../lib/types";
import { useLocation } from "../lib/location";
import type { Place } from "../lib/geo";

/** Profile colors offered by default; any color can be picked with the custom swatch. */
const PROFILE_COLORS = ["#ff5b3a", "#f0a35e", "#ffd43b", "#9be15d", "#a7e3b7", "#5fd4d0", "#7aa2ff", "#c2b1f8", "#ff8fc7", "#f3ede3"];

interface DraftTrack { key: string; title: string; src: string; duration: number }

/**
 * For artists. Artist accounts are separate from listener accounts. A new
 * artist applies (profile + where to hear them); a reviewer approves them;
 * then they can upload releases, which show up for every listener.
 */
export function Upload({ go }: { go: Go }) {
  const auth = useAuth();
  const c = useCatalog();
  if (!auth.ready) return <div className="screen"><p className="muted">Loading…</p></div>;
  if (!auth.session) return <ArtistSignIn />;
  if (auth.kind === "listener") return <ListenerSignedIn />;
  // Remount once the profile loads so the form starts filled in.
  return <ArtistTools key={c.myProfile?.id ?? "new"} go={go} />;
}

function ArtistSignIn() {
  return (
    <div className="screen" style={{ maxWidth: 600 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="catalog eyebrow">For Artists</span>
        <h1 className="display-lg">Put your music in the crate</h1>
        <p className="muted">
          Artist accounts are separate from listener accounts. To keep Milk Crate full of real local artists (not a flood of uploads),
          new artists are reviewed before their music goes live. Apply below; while you wait, you can set up your profile and design your page.
        </p>
      </header>
      <AuthForm kind="artist" signUpLabel="Apply to join" initialMode="signup" />
    </div>
  );
}

function ListenerSignedIn() {
  const auth = useAuth();
  return (
    <div className="screen" style={{ maxWidth: 600 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="catalog eyebrow">For Artists</span>
        <h1 className="display-lg">This is a listener account</h1>
        <p className="muted">
          You're signed in as {auth.email}, a listener account. Artist accounts are separate: sign out, then apply to join as an artist with a different email.
        </p>
      </header>
      <div><Button onClick={() => auth.signOut()}>Sign out</Button></div>
    </div>
  );
}

function ArtistTools({ go }: { go: Go }) {
  const auth = useAuth();
  const c = useCatalog();
  const me = c.myProfile;
  const approved = me?.status === "approved";

  /* ---------- profile ---------- */
  const [editing, setEditing] = useState(!me);
  const [name, setName] = useState(me?.name ?? "");
  const loc = useLocation();
  const [city, setCity] = useState<Place | null>(me ? loc.placeOf(me) : loc.home);
  const [genre, setGenre] = useState(me?.genres.join(", ") ?? "");
  const [bio, setBio] = useState(me?.bio ?? "");
  const [color, setColor] = useState(me?.accent ?? PROFILE_COLORS[7]);
  const [profileError, setProfileError] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);

  const saveProfile = async () => {
    if (!name.trim()) return setProfileError("Add your artist or band name.");
    if (!city) return setProfileError("Pick your home city or town from the list.");
    setSavingProfile(true);
    setProfileError("");
    try {
      await c.saveProfile({
      name: name.trim(),
      // Outside the US the country is part of the label: "Perth, WA, Australia" (WA is Washington too).
      place: city.country === "US" ? `${city.name}, ${city.state}` : `${city.name}, ${city.state}, ${COUNTRY_NAMES[city.country]}`,
      city: city.name,
      state: city.state,
      country: city.country,
      lat: city.lat,
      lng: city.lng,
      genres: genre.split(",").map((g) => g.trim()).filter(Boolean),
      bio: bio.trim(),
      accent: color,
      since: me?.since ?? new Date().getFullYear(),
      });
      setEditing(false);
    } catch (e) {
      setProfileError(`Couldn't save your profile: ${(e as Error).message}`);
    }
    setSavingProfile(false);
  };

  /* ---------- release ---------- */
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<Release["kind"]>("EP");
  const [year, setYear] = useState(new Date().getFullYear());
  const [art, setArt] = useState<string | null>(null);
  const [releaseAt, setReleaseAt] = useState<string | null>(null);
  const [tracks, setTracks] = useState<DraftTrack[]>([]);
  const [rights, setRights] = useState(false);
  const [releaseError, setReleaseError] = useState("");
  const [loading, setLoading] = useState(false);

  const addTracks = async () => {
    const picked = await pickAudioFiles();
    if (!picked.length) return;
    setLoading(true);
    const withLengths = await Promise.all(
      picked.map(async (t) => ({ key: t.id + Math.random(), title: t.title, src: t.src!, duration: await readDuration(t.src!) })),
    );
    setTracks((ts) => [...ts, ...withLengths]);
    setLoading(false);
  };

  const [progress, setProgress] = useState("");

  const publish = async () => {
    if (!me) return setReleaseError("Set up your artist profile first.");
    if (!title.trim()) return setReleaseError("Give the release a title.");
    if (!tracks.length) return setReleaseError("Add at least one audio file.");
    if (tracks.some((t) => !t.title.trim())) return setReleaseError("Every track needs a title.");
    if (!rights) return setReleaseError("Confirm you own or control the rights to this music.");
    setReleaseError("");
    try {
      await c.publishRelease(
        { title: title.trim(), kind, year, art: art ?? undefined, releaseAt: releaseAt ?? undefined },
        tracks.map((t) => ({ title: t.title.trim(), duration: t.duration, src: t.src })),
        setProgress,
      );
    } catch (e) {
      setProgress("");
      return setReleaseError(`Couldn't publish: ${(e as Error).message}`);
    }
    setTitle("");
    setArt(null);
    setReleaseAt(null);
    setTracks([]);
    setRights(false);
    go({ name: "artist", artistId: me.id });
  };

  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const total = tracks.reduce((s, t) => s + t.duration, 0);

  return (
    <div className="screen" style={{ maxWidth: 960 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="catalog eyebrow">For Artists</span>
        <h1 className="display-lg">{approved ? "Put your music in the crate" : me ? "Your application" : "Apply to join Milk Crate"}</h1>
        <p className="muted" style={{ maxWidth: 600 }}>
          {approved
            ? "Upload a release. Listeners can stream it, rate the album, favorite its songs, and find you as a dot on your scene's map, in your color."
            : me
              ? "While we review your application, you can polish your profile and design your page. Only you can see them until you're approved."
              : "Step 1: your artist profile. Step 2: tell us where to hear your music. A Milk Crate reviewer will take a look."}
        </p>
        <p className="caption muted" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          Signed in as {auth.email}
          <Button size="sm" onClick={() => auth.signOut()}>Sign out</Button>
        </p>
        {c.status === "offline" && (
          <p role="alert" className="form-error">Can't reach the Milk Crate server right now{c.error ? ` (${c.error})` : ""}. Check your connection, or that the database setup in supabase/schema.sql has been run.</p>
        )}
      </header>

      {/* ---------- Profile ---------- */}
      <section className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 className="display-md">Your artist profile</h2>
          {me && !editing && <Button size="sm" onClick={() => setEditing(true)}>Edit profile</Button>}
        </div>

        {me && !editing ? (
          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <ArtistThumb artist={me} size={48} />
            <div style={{ flex: "1 1 240px", display: "flex", flexDirection: "column" }}>
              <span style={{ fontWeight: 650, fontSize: 16 }}>{me.name}</span>
              <span className="caption muted">{[me.place, me.genres.join(", ")].filter(Boolean).join(" · ")}</span>
            </div>
            <Button size="sm" variant="ghost" onClick={() => go({ name: "artist", artistId: me.id })}>View your page</Button>
            <Button size="sm" variant="ghost" onClick={() => go({ name: "stats" })}>Your stats</Button>
          </div>
        ) : (
          <>
            <div className="form-grid">
              <label className="field">
                <span className="catalog eyebrow">Artist or band name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pink Insulation" />
              </label>
              <CityPicker label="Home city or town" value={city} onChange={setCity} />
              <label className="field">
                <span className="catalog eyebrow">Genres</span>
                <input value={genre} onChange={(e) => setGenre(e.target.value)} placeholder="Indie rock, shoegaze" />
              </label>
            </div>
            <label className="field">
              <span className="catalog eyebrow">Bio</span>
              <textarea rows={3} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="A sentence or two, in your own words." />
            </label>
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="catalog eyebrow" style={{ marginBottom: 8 }}>Profile color</legend>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                {PROFILE_COLORS.map((col) => (
                  <button key={col} type="button" className="swatch" aria-label={`Color ${col}`} aria-pressed={color === col}
                    onClick={() => setColor(col)} style={{ background: col }} />
                ))}
                <label className="swatch swatch-custom" title="Pick any color">
                  <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Custom profile color" />
                </label>
              </div>
              <p className="caption muted" style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
                <span aria-hidden="true" style={{ width: 12, height: 12, borderRadius: "50%", background: color }} />
                Your dot on the Scenes map and the header of your artist page.
              </p>
            </fieldset>
            {profileError && <p role="alert" className="form-error">{profileError}</p>}
            <div style={{ display: "flex", gap: 12 }}>
              <Button variant="primary" onClick={saveProfile} disabled={savingProfile}>{savingProfile ? "Saving…" : me ? "Save profile" : "Continue"}</Button>
              {me && <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
            </div>
          </>
        )}
      </section>

      {me && me.status !== "approved" && <ApplicationPanel />}

      {me && !editing && <PageDesigner go={go} />}

      {/* ---------- New release ---------- */}
      {approved ? (
      <section className="panel">
        <h2 className="display-md">New release</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start" }}>
          <div style={{ width: 180, flex: "none", display: "flex", flexDirection: "column", gap: 8 }}>
            <Sleeve src={art ?? undefined} seed={sleeveSeed(title || "untitled", me?.name ?? "")} alt="Cover art preview" />
            <Button size="sm" onClick={async () => { const a = await pickImage(); if (a) setArt(a); }}>
              <ImagePlus size={16} strokeWidth={1.75} aria-hidden="true" /> {art ? "Change cover" : "Add cover art"}
            </Button>
            {!art && <span className="caption muted">Square, at least 1400 px. Without one, we'll make a sleeve for you.</span>}
          </div>
          <div style={{ flex: "1 1 320px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
            <label className="field">
              <span className="catalog eyebrow">Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Basement Tapes" />
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
              <div className="field">
                <span className="catalog eyebrow" id="kind-label">Type</span>
                <div role="group" aria-labelledby="kind-label" style={{ display: "flex", gap: 8 }}>
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
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span className="catalog eyebrow">
              Tracks{tracks.length ? ` · ${tracks.length} · ${formatTime(total)}` : ""}
            </span>
            <Button size="sm" onClick={addTracks} disabled={loading}>
              <Music size={16} strokeWidth={1.75} aria-hidden="true" /> {loading ? "Reading files…" : "Add audio files"}
            </Button>
          </div>
          {tracks.length ? (
            <ol className="upload-tracks">
              {tracks.map((t, i) => (
                <li key={t.key}>
                  <span className="numeral muted" style={{ width: 24, textAlign: "center" }}>{String(i + 1).padStart(2, "0")}</span>
                  <input aria-label={`Track ${i + 1} title`} value={t.title}
                    onChange={(e) => setTracks((ts) => ts.map((x) => (x.key === t.key ? { ...x, title: e.target.value } : x)))} />
                  <span className="numeral muted">{t.duration ? formatTime(t.duration) : "—"}</span>
                  <button type="button" className="mc-icon-btn" aria-label={`Remove ${t.title}`}
                    onClick={() => setTracks((ts) => ts.filter((x) => x.key !== t.key))}>
                    <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <div className="empty"><span>MP3, FLAC, WAV, M4A or OGG. Track titles come from the file names; edit them here.</span></div>
          )}
        </div>

        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
          <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} style={{ marginTop: 3, accentColor: "var(--accent)" }} />
          <span>
            I own or control the rights to this music and the cover art, and any samples are cleared.
            <span className="caption muted" style={{ display: "block" }}>Milk Crate only carries music its artists put here themselves.</span>
          </span>
        </label>

        {releaseError && <p role="alert" className="form-error">{releaseError}</p>}
        <div>
          <Button variant="primary" onClick={publish} disabled={!!progress}>{progress || (releaseAt ? `Schedule for ${shortReleaseDate(releaseAt)}` : "Publish release")}</Button>
          {!progress && <p className="caption muted" style={{ marginTop: 8 }}>Add lyrics and credits after publishing, with Edit on the release.</p>}
        </div>
      </section>

      ) : (
        <section className="panel locked">
          <h2 className="display-md">New release</h2>
          <p className="muted">You can upload music once your application is approved. We'll review it as soon as we can.</p>
        </section>
      )}

      {/* ---------- Your releases ---------- */}
      {c.myReleases.length > 0 && (
        <section className="section">
          <h2 className="display-md">Your releases</h2>
          <div className="release-grid">
            {c.myReleases.map((r) => (
              <div key={r.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <ReleaseCard title={r.title} artist={r.kind} year={r.year} art={r.art} seed={sleeveSeed(r.title, me?.name ?? "")}
                  sticker={isUpcoming(r) ? `Out ${shortReleaseDate(r.releaseAt!)}` : "Yours"} stickerTone={isUpcoming(r) ? "accent" : "crate"} onOpen={() => go({ name: "album", releaseId: r.id })} />
                {pendingRemove === r.id ? (
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button size="sm" onClick={async () => {
                      try { await c.removeRelease(r.id); } catch (e) { setReleaseError(`Couldn't remove it: ${(e as Error).message}`); }
                      setPendingRemove(null);
                    }}>Remove for good</Button>
                    <Button size="sm" variant="ghost" onClick={() => setPendingRemove(null)}>Keep</Button>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Button size="sm" onClick={() => go({ name: "editRelease", releaseId: r.id })}>
                      <Pencil size={14} strokeWidth={1.75} aria-hidden="true" /> Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setPendingRemove(r.id)}>
                      <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" /> Remove
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** Pending or declined artists: where to hear them, and what the reviewers said. */
function ApplicationPanel() {
  const auth = useAuth();
  const c = useCatalog();
  const me = c.myProfile!;
  const app = c.myApplication;
  const [links, setLinks] = useState(app?.links ?? "");
  const [note, setNote] = useState(app?.note ?? "");
  const [editing, setEditing] = useState(!app);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastApp, setLastApp] = useState(app);
  if (app !== lastApp) {
    // The saved application arrived (or changed): show it.
    setLastApp(app);
    setLinks(app?.links ?? "");
    setNote(app?.note ?? "");
    setEditing(!app);
  }

  const send = async () => {
    if (!links.trim()) return setError("Add at least one link where we can hear your music (Bandcamp, SoundCloud, YouTube, Instagram…).");
    setBusy(true);
    setError("");
    try {
      await c.submitApplication(links, note, auth.email);
      setEditing(false);
    } catch (e) {
      setError(`Couldn't send your application: ${(e as Error).message}`);
    }
    setBusy(false);
  };

  const declined = me.status === "declined";
  return (
    <section className={`panel application ${declined ? "is-declined" : ""}`}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h2 className="display-md">{!app ? "Step 2: your application" : declined ? "Application not approved" : "Application under review"}</h2>
        {app && !editing && <Button size="sm" onClick={() => setEditing(true)}>{declined ? "Update and resend" : "Edit"}</Button>}
      </div>
      {app && !editing ? (
        <>
          <p className="muted">
            {declined
              ? "A reviewer didn't approve this application. You can update it and send it again."
              : "Thanks! A Milk Crate reviewer will listen and get back to you here. Nothing goes public until you're approved."}
          </p>
          {app.reviewNote && <p className="form-info"><strong>From the reviewer:</strong> {app.reviewNote}</p>}
          <dl className="review-facts">
            <dt>Where to hear you</dt><dd>{app.links}</dd>
            {app.note && (<><dt>Your note</dt><dd>{app.note}</dd></>)}
          </dl>
        </>
      ) : (
        <>
          <label className="field">
            <span className="catalog eyebrow">Where can we hear you?</span>
            <textarea rows={3} value={links} onChange={(e) => setLinks(e.target.value)} placeholder="Links to your music: Bandcamp, SoundCloud, YouTube, Instagram…" />
          </label>
          <label className="field">
            <span className="catalog eyebrow">Anything else? (optional)</span>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Shows you've played, who's in the band, what you're working on." />
          </label>
          {error && <p role="alert" className="form-error">{error}</p>}
          <div style={{ display: "flex", gap: 12 }}>
            <Button variant="primary" onClick={send} disabled={busy}>{busy ? "Sending…" : app ? "Send again" : "Send application"}</Button>
            {app && <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
          </div>
        </>
      )}
    </section>
  );
}

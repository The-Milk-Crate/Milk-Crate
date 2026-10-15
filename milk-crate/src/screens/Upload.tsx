import { useState } from "react";
import { Trash2, ImagePlus, Music } from "lucide-react";
import type { Go } from "../App";
import { formatTime, scenes } from "../data/scenes";
import { useCatalog } from "../lib/catalog";
import { useAuth } from "../lib/auth";
import { pickAudioFiles, pickImage, readDuration } from "../lib/localFiles";
import { sleeveSeed } from "../lib/sleeve";
import type { Release } from "../lib/types";
import { Button, ReleaseCard, Sleeve } from "../components/ui";

/** Profile colors offered by default; any color can be picked with the custom swatch. */
const PROFILE_COLORS = ["#ff5b3a", "#f0a35e", "#ffd43b", "#9be15d", "#a7e3b7", "#5fd4d0", "#7aa2ff", "#c2b1f8", "#ff8fc7", "#f3ede3"];

const CITIES = scenes.flatMap((s) => s.places.map((p) => ({ city: p, region: s.region, sceneId: s.id })));

interface DraftTrack { key: string; title: string; src: string; duration: number }

/**
 * For artists: sign in, set up an artist profile and upload releases to the
 * Milk Crate server. Published music shows up for every listener (Home,
 * Scenes map, artist page, search).
 */
export function Upload({ go }: { go: Go }) {
  const auth = useAuth();
  const c = useCatalog();
  if (!auth.ready) return <div className="screen"><p className="muted">Loading…</p></div>;
  if (!auth.session) return <AccountPanel />;
  // Remount once the profile loads so the form starts filled in.
  return <ArtistTools key={c.myProfile?.id ?? "new"} go={go} />;
}

/** Sign in, create an artist account, or confirm one with the emailed code. */
function AccountPanel() {
  const auth = useAuth();
  const [mode, setMode] = useState<"signin" | "signup" | "confirm">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);

  const toConfirm = (text: string) => {
    setMode("confirm");
    setCode("");
    setMessage({ kind: "info", text });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    if (mode === "confirm") {
      if (!code.trim()) return setMessage({ kind: "error", text: "Enter the code from your email." });
      setBusy(true);
      const err = await auth.verifyCode(email.trim(), code);
      if (err) setMessage({ kind: "error", text: err });
      setBusy(false);
      return;
    }
    if (!email.trim() || !password) return setMessage({ kind: "error", text: "Enter your email and a password." });
    setBusy(true);
    if (mode === "signin") {
      const err = await auth.signIn(email.trim(), password);
      if (err && /confirm your email/i.test(err)) {
        const resendErr = await auth.resendCode(email.trim());
        toConfirm(resendErr ?? `Your email isn't confirmed yet. We sent a new code to ${email.trim()}.`);
      } else if (err) setMessage({ kind: "error", text: err });
    } else {
      const { error, needsConfirmation } = await auth.signUp(email.trim(), password);
      if (error) setMessage({ kind: "error", text: error });
      else if (needsConfirmation) toConfirm(`We emailed ${email.trim()}. Enter the code from that email (check spam too). If the email has a link instead, click it, then come back and sign in.`);
    }
    setBusy(false);
  };

  const resend = async () => {
    setBusy(true);
    const err = await auth.resendCode(email.trim());
    setMessage(err ? { kind: "error", text: err } : { kind: "info", text: `New code sent to ${email.trim()}.` });
    setBusy(false);
  };

  const label = busy ? "One moment…" : mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Confirm";

  return (
    <div className="screen" style={{ maxWidth: 560 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="catalog eyebrow">For artists</span>
        <h1 className="display-lg">Put your music in the crate</h1>
        <p className="muted">Sign in to set up your artist page and upload releases. Listening never needs an account.</p>
      </header>
      <form className="panel" onSubmit={submit}>
        {mode === "confirm" ? (
          <>
            <h2 className="display-md">Confirm your email</h2>
            <label className="field">
              <span className="catalog eyebrow">Code from your email</span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={10}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.3em", fontSize: 18 }}
                autoFocus
              />
            </label>
          </>
        ) : (
          <>
            <div role="group" aria-label="Account" style={{ display: "flex", gap: 8 }}>
              <button type="button" className="chip" aria-pressed={mode === "signin"} onClick={() => setMode("signin")}>Sign in</button>
              <button type="button" className="chip" aria-pressed={mode === "signup"} onClick={() => setMode("signup")}>Create account</button>
            </div>
            <label className="field">
              <span className="catalog eyebrow">Email</span>
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">
              <span className="catalog eyebrow">Password</span>
              <input type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} />
              {mode === "signup" && <span className="caption muted">At least 6 characters.</span>}
            </label>
          </>
        )}
        {message && <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "form-error" : "form-info"}>{message.text}</p>}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
          <Button variant="primary" type="submit" disabled={busy}>{label}</Button>
          {mode === "confirm" && (
            <>
              <button type="button" className="link-btn" disabled={busy} onClick={resend}>Send a new code</button>
              <button type="button" className="link-btn" onClick={() => { setMode("signin"); setMessage(null); }}>Back</button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

function ArtistTools({ go }: { go: Go }) {
  const auth = useAuth();
  const c = useCatalog();
  const me = c.myProfile;

  /* ---------- profile ---------- */
  const [editing, setEditing] = useState(!me);
  const [name, setName] = useState(me?.name ?? "");
  const [city, setCity] = useState(me ? me.place.split(",")[0] : "Raleigh");
  const [genre, setGenre] = useState(me?.genres.join(", ") ?? "");
  const [bio, setBio] = useState(me?.bio ?? "");
  const [color, setColor] = useState(me?.accent ?? PROFILE_COLORS[7]);
  const [profileError, setProfileError] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);

  const saveProfile = async () => {
    if (!name.trim()) return setProfileError("Add your artist or band name.");
    const where = CITIES.find((x) => x.city === city) ?? CITIES[0];
    setSavingProfile(true);
    setProfileError("");
    try {
      await c.saveProfile({
      name: name.trim(),
      sceneId: where.sceneId,
      place: `${where.city}, ${where.region}`,
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
        { title: title.trim(), kind, year, art: art ?? undefined },
        tracks.map((t) => ({ title: t.title.trim(), duration: t.duration, src: t.src })),
        setProgress,
      );
    } catch (e) {
      setProgress("");
      return setReleaseError(`Couldn't publish: ${(e as Error).message}`);
    }
    setTitle("");
    setArt(null);
    setTracks([]);
    setRights(false);
    go({ name: "artist", artistId: me.id });
  };

  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const total = tracks.reduce((s, t) => s + t.duration, 0);

  return (
    <div className="screen" style={{ maxWidth: 960 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="catalog eyebrow">For artists</span>
        <h1 className="display-lg">Put your music in the crate</h1>
        <p className="muted" style={{ maxWidth: 600 }}>
          Upload a release. Listeners can stream it, rate it, and find you as a dot on your scene's map, in your color.
        </p>
        <p className="caption muted" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          Signed in as {auth.email}
          <button type="button" className="link-btn" onClick={() => auth.signOut()}>Sign out</button>
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
            <span aria-hidden="true" style={{ width: 40, height: 40, borderRadius: "50%", background: me.accent, flex: "none" }} />
            <div style={{ flex: "1 1 240px", display: "flex", flexDirection: "column" }}>
              <span style={{ fontWeight: 650, fontSize: 16 }}>{me.name}</span>
              <span className="caption muted">{[me.place, me.genres.join(", ")].filter(Boolean).join(" · ")}</span>
            </div>
            <Button size="sm" variant="ghost" onClick={() => go({ name: "artist", artistId: me.id })}>View your page</Button>
          </div>
        ) : (
          <>
            <div className="form-grid">
              <label className="field">
                <span className="catalog eyebrow">Artist or band name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pink Insulation" />
              </label>
              <label className="field">
                <span className="catalog eyebrow">Home city</span>
                <select value={city} onChange={(e) => setCity(e.target.value)}>
                  {CITIES.map((x) => <option key={x.city} value={x.city}>{x.city}, {x.region}</option>)}
                </select>
              </label>
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
              <Button variant="primary" onClick={saveProfile} disabled={savingProfile}>{savingProfile ? "Saving…" : me ? "Save profile" : "Create profile"}</Button>
              {me && <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
            </div>
          </>
        )}
      </section>

      {/* ---------- New release ---------- */}
      <section className="panel" aria-disabled={!me} style={!me ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
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
          <Button variant="primary" onClick={publish} disabled={!!progress}>{progress || "Publish release"}</Button>
        </div>
      </section>

      {/* ---------- Your releases ---------- */}
      {c.myReleases.length > 0 && (
        <section className="section">
          <h2 className="display-md">Your releases</h2>
          <div className="release-grid">
            {c.myReleases.map((r) => (
              <div key={r.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <ReleaseCard title={r.title} artist={r.kind} year={r.year} art={r.art} seed={sleeveSeed(r.title, me?.name ?? "")}
                  sticker="Yours" stickerTone="crate" onOpen={() => me && go({ name: "artist", artistId: me.id })} />
                {pendingRemove === r.id ? (
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button size="sm" onClick={async () => {
                      try { await c.removeRelease(r.id); } catch (e) { setReleaseError(`Couldn't remove it: ${(e as Error).message}`); }
                      setPendingRemove(null);
                    }}>Remove for good</Button>
                    <Button size="sm" variant="ghost" onClick={() => setPendingRemove(null)}>Keep</Button>
                  </div>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setPendingRemove(r.id)}>
                    <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" /> Remove
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

import { useEffect, useState, type CSSProperties } from "react";
import type { Go, SettingsTab } from "../App";
import { DEFAULT_TRANSPARENCY, useSettings } from "../lib/settings";
import { isDesktop } from "../lib/localFiles";
import { usePlayer } from "../lib/player";
import { appVersion, checkForUpdate, installUpdate, updateErrorText, type Update } from "../lib/updater";
import { accentForColor } from "../lib/accent";
import { EQ_BANDS, EQ_MAX_DB, EQ_PRESETS, FLAT } from "../lib/audioOut";
import { CEILING_DBTP, TARGET_LUFS } from "../lib/loudness";
import { Button, DownloadedMark, Sleeve } from "../components/ui";
import { useCatalog } from "../lib/catalog";
import { formatBytes, useDownloads } from "../lib/downloads";
import { sleeveSeed } from "../lib/sleeve";

function Switch({ label, hint, on, onChange, tag }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void; tag?: string }) {
  return (
    <button type="button" className="switch setting-row" role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", textAlign: "left" }}>
        <span style={{ fontWeight: 600 }}>{label}{tag && <span className="setting-tag">{tag}</span>}</span>
        <span className="caption muted">{hint}</span>
      </span>
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
    </button>
  );
}

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "sound", label: "Sound" },
  { id: "downloads", label: "Downloads" },
  { id: "updates", label: "Updates" },
];

/** Settings: how the app looks and sounds, and updates. Saved on this computer. */
export function Settings({ go, tab }: { go: Go; tab: SettingsTab }) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    appVersion().then(setVersion).catch(() => {});
  }, []);

  return (
    <div className="screen" style={{ maxWidth: 680 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="catalog eyebrow">{version ? `Milk Crate ${version}` : "Milk Crate"}</span>
        <h1 className="display-lg">Settings</h1>
      </header>
      <div role="tablist" aria-label="Settings" className="segmented">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`settings-${t.id}`} className="chip" aria-selected={tab === t.id} aria-pressed={tab === t.id}
            aria-controls="settings-panel" onClick={() => go({ name: "settings", tab: t.id })}>
            {t.label}
          </button>
        ))}
      </div>
      <div id="settings-panel" role="tabpanel" aria-labelledby={`settings-${tab}`} style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        {tab === "appearance" && <Appearance />}
        {tab === "sound" && <Sound />}
        {tab === "downloads" && <Downloads go={go} />}
        {tab === "updates" && <Updates />}
      </div>
    </div>
  );
}

/* ---------- Appearance ---------- */

/** Accent presets. null = Milk Crate lavender. The swatches show each color as it will look (adjusted to stay readable). */
const ACCENTS: { name: string; hex: string | null }[] = [
  { name: "Lavender", hex: null },
  { name: "Sky", hex: "#4f9dff" },
  { name: "Teal", hex: "#22b8a8" },
  { name: "Moss", hex: "#6dbb4a" },
  { name: "Butter", hex: "#e8c547" },
  { name: "Tangerine", hex: "#ff8a3d" },
  { name: "Brick", hex: "#e2533f" },
  { name: "Rose", hex: "#ff5c9a" },
  { name: "Slate", hex: "#8a8f98" },
];

function Appearance() {
  const s = useSettings();
  const preset = ACCENTS.find((a) => a.hex === s.accentColor);
  const custom = !preset && s.accentColor;
  return (
    <>
      <section className="panel" style={{ gap: 4 }}>
        <h2 className="display-md" style={{ marginBottom: 8 }}>Color</h2>
        <div className="field" style={{ marginBottom: 12 }}>
          <span className="catalog eyebrow" id="theme-label">Theme</span>
          <div role="group" aria-labelledby="theme-label" style={{ display: "flex", gap: 8 }}>
            <button type="button" className="chip" aria-pressed={s.theme === "dark"} onClick={() => s.setTheme("dark")}>Dark</button>
            <button type="button" className="chip" aria-pressed={s.theme === "light"} onClick={() => s.setTheme("light")}>Light</button>
          </div>
        </div>
        <div className="field" style={{ marginBottom: 12 }}>
          <span className="catalog eyebrow" id="accent-label">Accent color</span>
          <span className="caption muted">Buttons, highlights and the song that's playing. Colors are adjusted a little so text stays easy to read.</span>
          <div role="group" aria-labelledby="accent-label" className="swatches">
            {ACCENTS.map((a) => (
              <button key={a.name} type="button" className="swatch" aria-pressed={preset === a} aria-label={a.name} title={a.name}
                style={{ "--swatch": accentForColor(a.hex, s.theme).accent } as CSSProperties} onClick={() => s.setAccentColor(a.hex)} />
            ))}
            <label className={`swatch swatch-custom${custom ? " on" : ""}`} title="Pick any color"
              style={custom ? ({ "--swatch": accentForColor(s.accentColor, s.theme).accent } as CSSProperties) : undefined}>
              <input type="color" aria-label="Custom accent color" value={s.accentColor ?? "#b18cf2"} onChange={(e) => s.setAccentColor(e.target.value)} />
            </label>
          </div>
        </div>
        <Switch label="Album colors" hint="While music plays, the accent takes the album's color. Your accent comes back when nothing's playing." on={s.matchAlbum} onChange={s.setMatchAlbum} />
      </section>

      <section className="panel" style={{ gap: 4 }}>
        <h2 className="display-md" style={{ marginBottom: 8 }}>Frosted Glass</h2>
        <Switch label="Glass" hint="Frosted, see-through panels with the playing album's colors swirling behind them." on={s.glass} onChange={s.setGlass} />
        {s.glass && (
          <>
            <Slider label="Transparency" hint="Clearer glass shows more color. Frostier glass is easier to read." value={s.transparency} onChange={s.setTransparency}
              left="Frostier" right="Clearer" fallback={DEFAULT_TRANSPARENCY} />
            <Switch label="Frosted texture" tag="Experimental" hint="Very fine grain on the glass. Each grain catches the album's colors behind it, like real frosted glass. Off, the glass stays see-through and smooth." on={s.frostTexture} onChange={s.setFrostTexture} />
            {isDesktop() && (
              <Switch label="See-through window" hint="Let your desktop show through, frosted (acrylic on Windows, Liquid Glass on Mac). If dragging the window feels slow, turn this off." on={s.seeThrough} onChange={s.setSeeThrough} />
            )}
          </>
        )}
      </section>
    </>
  );
}

function Slider({ label, hint, value, onChange, left, right, fallback }: {
  label: string; hint: string; value: number; onChange: (v: number) => void; left: string; right: string; fallback: number;
}) {
  return (
    <div className="setting-row setting-slider">
      <span style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        {value !== fallback && <button type="button" className="link-btn caption" onClick={() => onChange(fallback)}>Reset</button>}
      </span>
      <span className="caption muted">{hint}</span>
      <input type="range" className="volume-slider" min={0} max={100} step={1} value={value} aria-label={label} aria-valuetext={`${value}%`}
        onChange={(e) => onChange(Number(e.target.value))} style={{ "--fill": `${value}%`, width: "100%", marginTop: 10 } as CSSProperties} />
      <span className="caption muted" style={{ display: "flex", justifyContent: "space-between" }} aria-hidden="true"><span>{left}</span><span>{right}</span></span>
    </div>
  );
}

/* ---------- Sound ---------- */

function Sound() {
  const p = usePlayer();
  return (
    <>
      <section className="panel" style={{ gap: 4 }}>
        <h2 className="display-md" style={{ marginBottom: 8 }}>Playing</h2>
        <Switch label="Shuffle by my favorites" hint="When shuffling, your favorite songs come up most, then songs from albums you rated highly." on={p.weighted} onChange={p.setWeighted} />
        <Switch label="Normalizer" tag="Experimental"
          hint={`Plays every song at the same loudness (${TARGET_LUFS} LUFS) without moving your volume slider, and never lets peaks go over ${CEILING_DBTP} dB. A quiet song with loud peaks stays a little under, so it isn't squashed.`}
          on={p.normalizerOn} onChange={p.setNormalizerOn} />
        {p.normalizerOn && p.current?.src && (
          <span className="caption muted" role="status" style={{ padding: "0 0 8px" }}>
            {p.normalizerDb === null
              ? `Measuring "${p.current.title}"…`
              : `"${p.current.title}": ${Math.abs(p.normalizerDb) < 0.05 ? "no change" : `${p.normalizerDb > 0 ? "+" : "−"}${Math.abs(p.normalizerDb).toFixed(1)} dB`}`}
          </span>
        )}
      </section>
      <Equalizer />
    </>
  );
}

/** A 6-band equalizer for everything Milk Crate plays. */
function Equalizer() {
  const p = usePlayer();
  const preset = Object.entries(EQ_PRESETS).find(([, g]) => g.every((v, i) => v === p.eqGains[i]))?.[0];
  const setBand = (i: number, db: number) => p.setEqGains(p.eqGains.map((g, j) => (j === i ? db : g)));
  return (
    <section className="panel" style={{ gap: 12 }}>
      <h2 className="display-md">Equalizer</h2>
      <Switch label="Equalizer" hint="Shape the sound of everything you play." on={p.eqOn} onChange={p.setEqOn} />
      <div className={`eq ${p.eqOn ? "" : "is-off"}`} aria-disabled={!p.eqOn}>
        <div role="group" aria-label="Presets" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {Object.keys(EQ_PRESETS).map((name) => (
            <button key={name} type="button" className="chip" aria-pressed={preset === name} disabled={!p.eqOn} onClick={() => p.setEqGains(EQ_PRESETS[name])}>{name}</button>
          ))}
        </div>
        <div className="eq-bands">
          <div className="eq-scale caption muted" aria-hidden="true"><span>+{EQ_MAX_DB}</span><span>0 dB</span><span>−{EQ_MAX_DB}</span></div>
          {EQ_BANDS.map((b, i) => (
            <label key={b.hz} className="eq-band">
              <span className="eq-value caption">{p.eqGains[i] > 0 ? "+" : ""}{p.eqGains[i]}</span>
              <span className="eq-slot">
                <input type="range" className="eq-slider" min={-EQ_MAX_DB} max={EQ_MAX_DB} step={1} value={p.eqGains[i] ?? 0} disabled={!p.eqOn}
                  aria-label={`${b.label} Hz`} aria-valuetext={`${p.eqGains[i]} decibels`} aria-orientation="vertical"
                  onChange={(e) => setBand(i, Number(e.target.value))} onDoubleClick={() => setBand(i, 0)} />
              </span>
              <span className="catalog eq-hz">{b.label}</span>
            </label>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <span className="caption muted">Hz. Double-click a slider to reset it.</span>
          <button type="button" className="link-btn caption" disabled={!p.eqOn} onClick={() => p.setEqGains(FLAT)}>Reset to flat</button>
        </div>
      </div>
    </section>
  );
}

/* ---------- Updates ---------- */

/** Check GitHub for a newer Milk Crate and install it. */
function Updates() {
  type State = { s: "idle" } | { s: "checking" } | { s: "latest" } | { s: "found"; update: Update } | { s: "installing"; pct: number | null } | { s: "error"; text: string };
  const [state, setState] = useState<State>({ s: "idle" });
  const [version, setVersion] = useState<string | null>(null);
  if (version === null) void appVersion().then((v) => setVersion(v ?? "")).catch(() => setVersion(""));

  const check = async () => {
    setState({ s: "checking" });
    try {
      const update = await checkForUpdate();
      setState(update ? { s: "found", update } : { s: "latest" });
    } catch (e) {
      const why = typeof e === "string" ? e : String((e as Error)?.message ?? e);
      setState({
        s: "error",
        text: /endpoint/i.test(why)
          ? "This copy of Milk Crate doesn't know where to look for updates. Install the latest version from the GitHub Releases page once; it updates itself after that."
          : `Couldn't check for updates (${why}). Check your internet connection and try again.`,
      });
    }
  };
  const install = async (update: Update) => {
    setState({ s: "installing", pct: null });
    try {
      await installUpdate(update, (pct) => setState({ s: "installing", pct }));
    } catch (e) {
      setState({ s: "error", text: updateErrorText(e) });
    }
  };

  return (
    <section className="panel">
      <h2 className="display-md">Updates</h2>
      <p className="caption muted">{version ? `You're running Milk Crate ${version}.` : "Updates work in the installed app."} New versions come from GitHub and install themselves.</p>
      {state.s === "latest" && <p className="form-info" role="status">You're on the latest version.</p>}
      {state.s === "found" && <p className="form-info" role="status">Milk Crate {state.update.version} is ready to install. The app will restart.</p>}
      {state.s === "installing" && <p className="form-info" role="status">Updating{state.pct !== null ? ` · ${state.pct}%` : "…"} The app will restart when it's done.</p>}
      {state.s === "error" && <p className="form-error" role="alert">{state.text}</p>}
      <div style={{ display: "flex", gap: 12 }}>
        {state.s === "found" ? (
          <Button variant="primary" onClick={() => install(state.update)}>Install and restart</Button>
        ) : (
          <Button onClick={check} disabled={!isDesktop() || state.s === "checking" || state.s === "installing"}>{state.s === "checking" ? "Checking…" : "Check for updates"}</Button>
        )}
      </div>
    </section>
  );
}

/* ---------- Downloads ---------- */

/** Songs saved on this computer for listening without the internet: how much space, and removing them. */
function Downloads({ go }: { go: Go }) {
  const c = useCatalog();
  const dl = useDownloads();
  const [msg, setMsg] = useState("");
  const [sure, setSure] = useState(false);
  const byRelease = new Map<string, { ids: string[]; bytes: number }>();
  for (const d of Object.values(dl.byTrack)) {
    const e = byRelease.get(d.releaseId) ?? { ids: [], bytes: 0 };
    e.ids.push(d.trackId);
    e.bytes += d.size;
    byRelease.set(d.releaseId, e);
  }
  const count = Object.keys(dl.byTrack).length;
  return (
    <section className="panel">
      <h2 className="display-md">Downloads</h2>
      <p className="muted">
        {count
          ? `${count} ${count === 1 ? "song" : "songs"} · ${formatBytes(dl.totalBytes)} on this computer. They play without the internet.`
          : "Nothing downloaded yet. Choose Download from any album or song's menu to listen without the internet."}
        {dl.pending.size > 0 && ` Downloading ${dl.pending.size} more…`}
      </p>
      <p className="caption muted"><DownloadedMark /> marks a song, or an album with every song, that's downloaded.</p>
      {[...byRelease].map(([id, e]) => {
        const r = c.releaseById[id];
        const a = r ? c.artistById[r.artistId] : undefined;
        return (
          <div key={id} className="list-row">
            <Sleeve src={r?.art} seed={sleeveSeed(r?.title ?? id, a?.name ?? "")} style={{ width: 40, flex: "none" }} />
            <button type="button" className="link-btn" style={{ flex: "1 1 auto", minWidth: 0, textAlign: "left", textDecoration: "none", color: "var(--ink)" }}
              onClick={() => r && go({ name: "album", releaseId: id })}>
              <strong>{r?.title ?? "Taken down"}</strong>
              <span className="caption muted"> · {a?.name ?? ""} · {r && e.ids.length < r.trackIds.length ? `${e.ids.length} of ${r.trackIds.length} songs` : "every song"} · {formatBytes(e.bytes)}</span>
            </button>
            <Button size="sm" variant="ghost" onClick={() => void dl.remove(e.ids)}>Remove</Button>
          </div>
        );
      })}
      {count > 0 && (sure ? (
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Button size="sm" onClick={() => void dl.removeAll().then(() => setMsg("Removed all downloads.")).catch((e) => setMsg((e as Error).message)).finally(() => setSure(false))}>Remove all downloads</Button>
          <button type="button" className="link-btn caption" onClick={() => setSure(false)}>Keep them</button>
        </div>
      ) : (
        <Button size="sm" variant="ghost" style={{ alignSelf: "flex-start" }} onClick={() => setSure(true)}>Remove all…</Button>
      ))}
      {msg && <p className="form-info" role="status">{msg}</p>}
    </section>
  );
}

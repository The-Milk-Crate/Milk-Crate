import { useEffect, useState } from "react";
import { useSettings } from "../lib/settings";
import { isDesktop } from "../lib/localFiles";
import { usePlayer } from "../lib/player";
import { appVersion } from "../lib/updater";
import { EQ_BANDS, EQ_MAX_DB, EQ_PRESETS, FLAT } from "../lib/audioOut";

function Switch({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className="switch setting-row" role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", textAlign: "left" }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span className="caption muted">{hint}</span>
      </span>
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
    </button>
  );
}

/** Settings: how the app looks and plays. Saved on this computer. */
export function Settings() {
  const s = useSettings();
  const p = usePlayer();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    appVersion().then(setVersion).catch(() => {});
  }, []);

  return (
    <div className="screen" style={{ maxWidth: 640 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="catalog eyebrow">Milk Crate</span>
        <h1 className="display-lg">Settings</h1>
      </header>
      <section className="panel" style={{ gap: 4 }}>
        <h2 className="display-md" style={{ marginBottom: 8 }}>Look</h2>
        <div className="field">
          <span className="catalog eyebrow" id="theme-label">Theme</span>
          <div role="group" aria-labelledby="theme-label" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button type="button" className="chip" aria-pressed={s.theme === "dark"} onClick={() => s.setTheme("dark")}>Dark</button>
            <button type="button" className="chip" aria-pressed={s.theme === "light"} onClick={() => s.setTheme("light")}>Light</button>
          </div>
        </div>
        <Switch label="Album colors" hint="The accent color follows the album that's playing." on={s.matchAlbum} onChange={s.setMatchAlbum} />
        <Switch label="Glass" hint="Frosted, see-through panels with the playing album's colors swirling behind them." on={s.glass} onChange={s.setGlass} />
        {s.glass && isDesktop() && (
          <Switch label="See-through window" hint="Let your desktop show through, frosted (acrylic on Windows, Liquid Glass on Mac). If dragging the window feels slow, turn this off." on={s.seeThrough} onChange={s.setSeeThrough} />
        )}
      </section>
      <section className="panel" style={{ gap: 4 }}>
        <h2 className="display-md" style={{ marginBottom: 8 }}>Playing</h2>
        <Switch label="Shuffle by my ratings" hint="When shuffling, five-star songs come up most." on={p.weighted} onChange={p.setWeighted} />
      </section>
      <Equalizer />
      <p className="caption muted">{version ? `Milk Crate ${version}. Check for updates on the Account page.` : "Updates work in the installed app (Account → Check for updates)."}</p>
    </div>
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

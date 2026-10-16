import { useEffect, useState } from "react";
import { useSettings } from "../lib/settings";
import { usePlayer } from "../lib/player";
import { appVersion } from "../lib/updater";

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
      </section>
      <section className="panel" style={{ gap: 4 }}>
        <h2 className="display-md" style={{ marginBottom: 8 }}>Playing</h2>
        <Switch label="Shuffle by my ratings" hint="When shuffling, five-star songs come up most." on={p.weighted} onChange={p.setWeighted} />
      </section>
      <p className="caption muted">{version ? `Milk Crate ${version}. Check for updates on the Account page.` : "Updates work in the installed app (Account → Check for updates)."}</p>
    </div>
  );
}

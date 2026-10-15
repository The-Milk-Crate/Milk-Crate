import { Archive, House, MapPin, Moon, Sun, Upload, UserRound } from "lucide-react";
import type { Route } from "../App";
import { scenes } from "../data/scenes";
import { useEffect, useState } from "react";
import { Logo } from "./ui";
import { appVersion } from "../lib/updater";

const NAV: { name: Route["name"]; label: string; Icon: typeof House }[] = [
  { name: "home", label: "Home", Icon: House },
  { name: "scenes", label: "Scenes", Icon: MapPin },
  { name: "crate", label: "Your Crate", Icon: Archive },
  { name: "artist", label: "Artists", Icon: UserRound },
  { name: "upload", label: "For artists", Icon: Upload },
];

export function Sidebar(props: {
  route: Route;
  go: (r: Route) => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  matchAlbum: boolean;
  onToggleMatchAlbum: () => void;
}) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    appVersion().then(setVersion).catch(() => {});
  }, []);
  return (
    <nav className="sidebar" aria-label="Main">
      <Logo className="sidebar-logo" />
      {NAV.map(({ name, label, Icon }) => (
        <button
          key={name}
          type="button"
          className="nav-item"
          aria-current={props.route.name === name ? "page" : undefined}
          onClick={() => props.go({ name })}
        >
          <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
          {label}
        </button>
      ))}

      <div className="nav-section">
        <span className="catalog eyebrow">Your scenes</span>
        {scenes.slice(0, 3).map((s) => (
          <button key={s.id} type="button" className="nav-sub" onClick={() => props.go({ name: "scenes", sceneId: s.id })}>
            {s.name}
          </button>
        ))}
      </div>

      <div className="sidebar-foot">
        <button type="button" className="switch" role="switch" aria-checked={props.matchAlbum} onClick={props.onToggleMatchAlbum}
          style={{ justifyContent: "space-between", padding: "8px 12px", textAlign: "left" }}>
          <span style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontWeight: 600 }}>Album colors</span>
            <span className="caption muted">Accent follows what's playing</span>
          </span>
          <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
        </button>
        <button type="button" className="nav-item" onClick={props.onToggleTheme}>
          {props.theme === "dark" ? <Sun size={20} strokeWidth={1.75} aria-hidden="true" /> : <Moon size={20} strokeWidth={1.75} aria-hidden="true" />}
          {props.theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
        {version && <span className="caption muted app-version">Version {version}</span>}
      </div>
    </nav>
  );
}

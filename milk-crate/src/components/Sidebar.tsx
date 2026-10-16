import { Archive, CircleUserRound, House, MapPin, Settings as SettingsIcon, ShieldCheck, Upload, UserRound } from "lucide-react";
import type { Route } from "../App";
import { Logo } from "./ui";
import { useAuth } from "../lib/auth";
import { useLiveScene, useLocation } from "../lib/location";

type NavItem = { name: Route["name"]; label: string; Icon: typeof House };

/** Which sidebar item a screen belongs to (album pages live under Artists, and so on). */
const SECTION: Partial<Record<Route["name"], Route["name"]>> = { album: "artist" };

export function Sidebar({ route, go }: { route: Route; go: (r: Route) => void }) {
  const auth = useAuth();
  const { scene: fullScene } = useLocation();
  const scene = useLiveScene(fullScene); // only towns with artists
  const nav: NavItem[] = [
    { name: "home", label: "Home", Icon: House },
    { name: "crate", label: "Your Crate", Icon: Archive },
    { name: "artist", label: "Artists", Icon: UserRound },
    { name: "scenes", label: "Scenes", Icon: MapPin },
    { name: "account", label: auth.session ? "Account" : "Sign in", Icon: CircleUserRound },
    { name: "upload", label: "For artists", Icon: Upload },
    ...(auth.isAdmin ? [{ name: "review" as const, label: "Review artists", Icon: ShieldCheck }] : []),
  ];
  const active = SECTION[route.name] ?? route.name;
  const item = ({ name, label, Icon }: NavItem) => (
    <button key={name} type="button" className="nav-item" aria-current={active === name ? "page" : undefined} onClick={() => go({ name } as Route)}>
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
      {label}
    </button>
  );

  return (
    <nav className="sidebar" aria-label="Main">
      <Logo className="sidebar-logo" />
      {nav.map(item)}

      {scene && (
        <div className="nav-section">
          <span className="catalog eyebrow">Your scene</span>
          <button type="button" className="nav-sub" onClick={() => go({ name: "scenes" })}>
            {scene.home.name}, {scene.home.state}
          </button>
          {scene.nearby.length + scene.anchors.length > 0 && (
            <span className="caption muted">{[...scene.nearby, ...scene.anchors].slice(0, 3).map((p) => p.name).join(" · ")}</span>
          )}
        </div>
      )}

      <div className="sidebar-foot">{item({ name: "settings", label: "Settings", Icon: SettingsIcon })}</div>
    </nav>
  );
}

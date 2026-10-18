import { Archive, Bell, Disc3, Disc, ListMusic, Music2, Monitor, CircleUserRound, MessageSquare, Search, House, MapPin, Settings as SettingsIcon, ShieldCheck, Upload, UserRound } from "lucide-react";
import type { Route } from "../App";
import { Logo } from "./ui";
import { useAuth } from "../lib/auth";
import { useAlerts } from "../lib/alerts";
import { openSearch } from "./SearchPalette";
import { openFeedback } from "./FeedbackDialog";

type NavItem = { name: Route["name"]; label: string; Icon: typeof House; to?: Route; key?: string };

/** Which sidebar item a screen belongs to (album pages live under Artists, and so on). */
const SECTION: Partial<Record<Route["name"], Route["name"]>> = { album: "artist", editRelease: "upload", stats: "upload", computer: "crate", shelf: "crate" };

/** Opened like a folder under Your Crate while you're in it. */
const CRATE_FOLDER: NavItem[] = [
  { name: "crate", key: "albums", label: "Albums", Icon: Disc, to: { name: "crate", tab: "albums" } },
  { name: "crate", key: "playlists", label: "Playlists", Icon: ListMusic, to: { name: "crate", tab: "playlists" } },
  { name: "crate", key: "songs", label: "Songs", Icon: Music2, to: { name: "crate", tab: "songs" } },
  { name: "shelf", label: "Your Shelf", Icon: Disc3 },
  { name: "computer", label: "Your Computer", Icon: Monitor },
];

/** Which part of Your Crate a crate page belongs to (an album page under Albums, and so on). */
function crateKey(route: Route): string | undefined {
  if (route.name !== "crate") return undefined;
  if (route.releaseId || route.tab === "albums" || route.tab === "singles") return "albums";
  if (route.playlistId || route.tab === "playlists") return "playlists";
  if (route.tab === "songs" || route.tab === "favorites") return "songs";
  return route.tab;
}

/** The main navigation. Collapses to an icon rail (labels show as tooltips). */
export function Sidebar({ route, go, collapsed, onToggle }: { route: Route; go: (r: Route) => void; collapsed: boolean; onToggle: () => void }) {
  const auth = useAuth();
  const { unread } = useAlerts();
  // Search sits above these (it opens a box instead of a page). For Artists is only
  // for artist accounts and Review only for reviewers; new artists apply from the
  // Welcome screen or the Artists page.
  const nav: NavItem[] = [
    { name: "home", label: "Home", Icon: House },
    { name: "crate", label: "Your Crate", Icon: Archive },
    { name: "inbox", label: "New", Icon: Bell },
    { name: "scenes", label: "Scenes", Icon: MapPin },
    { name: "artist", label: "Artists", Icon: UserRound },
  ];
  // Yours, at the bottom above Send Feedback and Settings.
  const mine: NavItem[] = [
    { name: "account", label: auth.session ? "Account" : "Sign In", Icon: CircleUserRound },
    ...(auth.session && auth.kind === "artist" ? [{ name: "upload" as const, label: "For Artists", Icon: Upload }] : []),
    ...(auth.isAdmin ? [{ name: "review" as const, label: "Review", Icon: ShieldCheck }] : []),
  ];
  const active = SECTION[route.name] ?? route.name;
  const inCrateSub = route.name !== "crate" || !!crateKey(route);
  const item = ({ name, label, Icon, to, key }: NavItem, sub = false) => (
    <button key={key ?? name} type="button" className={sub ? "nav-item nav-sub" : "nav-item"}
      aria-current={(sub ? (key ? crateKey(route) === key : route.name === name) : active === name && !(name === "crate" && inCrateSub)) ? "page" : undefined}
      // Inside the folder, Your Crate itself is "open" rather than the current page.
      data-open={!sub && name === "crate" && active === "crate" && inCrateSub ? "" : undefined}
      onClick={() => go(to ?? ({ name } as Route))}
      aria-label={collapsed || (name === "inbox" && unread) ? `${label}${name === "inbox" && unread ? `, ${unread} new` : ""}` : undefined} title={collapsed ? label : undefined}>
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" style={{ flex: "none" }} />
      <span className="nav-label">{label}</span>
      {name === "inbox" && unread > 0 && <span className="nav-badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
    </button>
  );

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="sidebar-head">
        {/* The logo opens and closes the sidebar. */}
        <button type="button" className="sidebar-logo-btn" onClick={onToggle} aria-expanded={!collapsed}
          aria-label={collapsed ? "Milk Crate: expand sidebar" : "Milk Crate: collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
          <Logo className="sidebar-logo" />
        </button>
      </div>
      <button type="button" className="nav-item" onClick={() => openSearch()} aria-label={collapsed ? "Search" : undefined} title={collapsed ? "Search (Ctrl+K)" : undefined} aria-keyshortcuts="Control+K">
        <Search size={20} strokeWidth={1.75} aria-hidden="true" style={{ flex: "none" }} />
        <span className="nav-label">Search</span>
      </button>
      {nav.map((n) => (
        n.name === "crate" && active === "crate" ? (
          <div key="crate" className="nav-folder">
            {item(n)}
            <div className="nav-folder-items" role="group" aria-label="In Your Crate">{CRATE_FOLDER.map((f) => item(f, true))}</div>
          </div>
        ) : item(n)
      ))}

      <div className="sidebar-foot">
        {mine.map((n) => item(n))}
        <button type="button" className="nav-item" onClick={openFeedback} aria-label={collapsed ? "Send feedback" : undefined} title={collapsed ? "Send feedback" : undefined}>
          <MessageSquare size={20} strokeWidth={1.75} aria-hidden="true" style={{ flex: "none" }} />
          <span className="nav-label">Send Feedback</span>
        </button>
        {item({ name: "settings", label: "Settings", Icon: SettingsIcon })}
      </div>
    </nav>
  );
}

import { Archive, Bell, CassetteTape, CircleDot, Disc2, Disc3, Disc, LibraryBig, ListMusic, Music2, Monitor, Search, House, MapPin, Settings as SettingsIcon, UserRound } from "lucide-react";
import { useMemo } from "react";
import type { Route, ShelfFormat } from "../App";
import { Logo } from "./ui";
import { useAlerts } from "../lib/alerts";
import { useLibrary } from "../lib/library";
import { useRippedAlbums } from "../lib/ripped";
import { ownedSections } from "../lib/shelf";
import type { PhysicalFormat } from "../lib/types";
import { openSearch } from "./SearchPalette";

type NavItem = { name: Route["name"]; label: string; Icon: typeof House; to?: Route; key?: string };

/** Which sidebar item a screen belongs to (album pages live under Artists, and so on). */
const SECTION: Partial<Record<Route["name"], Route["name"]>> = {
  album: "artist", computer: "crate",
  // Account, For Artists and Review are tabs of Settings.
  account: "settings", upload: "settings", review: "settings", editRelease: "settings", stats: "settings",
};

/** Opened like a folder under Your Crate while you're in it. */
const CRATE_FOLDER: NavItem[] = [
  { name: "crate", key: "albums", label: "Albums", Icon: Disc, to: { name: "crate", tab: "albums" } },
  { name: "crate", key: "playlists", label: "Playlists", Icon: ListMusic, to: { name: "crate", tab: "playlists" } },
  { name: "crate", key: "songs", label: "Songs", Icon: Music2, to: { name: "crate", tab: "songs" } },
  { name: "computer", key: "computer", label: "Your Computer", Icon: Monitor },
];

const SHELF_ICONS: Record<ShelfFormat, typeof House> = { vinyl: Disc3, "45s": CircleDot, cds: Disc2, cassettes: CassetteTape };

/** Which part of Your Crate a page belongs to (an album page under Albums, and so on). */
function crateKey(route: Route): string | undefined {
  if (route.name === "computer") return "computer";
  if (route.name !== "crate") return undefined;
  if (route.releaseId || route.tab === "albums" || route.tab === "singles") return "albums";
  if (route.playlistId || route.tab === "playlists") return "playlists";
  if (route.tab === "songs" || route.tab === "favorites") return "songs";
  return route.tab;
}

/** The main navigation. Collapses to an icon rail (labels show as tooltips). */
export function Sidebar({ route, go, collapsed, onToggle }: { route: Route; go: (r: Route) => void; collapsed: boolean; onToggle: () => void }) {
  const { unread } = useAlerts();
  const lib = useLibrary();
  const ripped = useRippedAlbums();
  // Your Shelf's folder: only the kinds of media you have.
  const shelfSections = useMemo(
    () => ownedSections([...lib.physical.map((x) => x.format), ...(ripped.length ? (["CD"] as PhysicalFormat[]) : [])]),
    [lib.physical, ripped.length],
  );
  const shelfFolder: NavItem[] = shelfSections.map((s) => ({
    name: "shelf", key: s.id, label: s.id === "vinyl" ? "Vinyl" : s.id === "45s" ? "45s" : s.label, Icon: SHELF_ICONS[s.id], to: { name: "shelf", format: s.id },
  }));
  const shelfKey = route.name === "shelf" ? route.format ?? shelfSections[0]?.id : undefined;

  // Search sits above these (it opens a box instead of a page). Account, For Artists,
  // Review and Send Feedback are tabs of Settings.
  const nav: NavItem[] = [
    { name: "home", label: "Home", Icon: House },
    { name: "crate", label: "Your Crate", Icon: Archive },
    { name: "shelf", label: "Your Shelf", Icon: LibraryBig },
    { name: "inbox", label: "New", Icon: Bell },
    { name: "scenes", label: "Scenes", Icon: MapPin },
    { name: "artist", label: "Artists", Icon: UserRound },
  ];

  const active = SECTION[route.name] ?? route.name;
  const subKey = active === "crate" ? crateKey(route) : active === "shelf" ? shelfKey : undefined;
  const item = ({ name, label, Icon, to, key }: NavItem, sub = false) => {
    // A folder's own item is "open" (not the current page) while you're on one of its pages.
    const folder = !sub && (name === "crate" || name === "shelf") && active === name && !!subKey;
    return (
      <button key={key ?? name} type="button" className={sub ? "nav-item nav-sub" : "nav-item"} tabIndex={sub && active !== name ? -1 : undefined}
        aria-current={(sub ? active === name && subKey === key : active === name && !folder) ? "page" : undefined}
        data-open={folder ? "" : undefined}
        data-tour={sub || name === "crate" || name === "shelf" ? undefined : name}
        onClick={() => go(to ?? ({ name } as Route))}
        aria-label={collapsed || (name === "inbox" && unread) ? `${label}${name === "inbox" && unread ? `, ${unread} new` : ""}` : undefined} title={collapsed ? label : undefined}>
        <Icon size={20} strokeWidth={1.75} aria-hidden="true" style={{ flex: "none" }} />
        <span className="nav-label">{label}</span>
        {name === "inbox" && unread > 0 && <span className="nav-badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
      </button>
    );
  };
  // Folders stay in the page and open or close with an animation.
  const folder = (n: NavItem, items: NavItem[], label: string) => (
    <div key={n.name} data-tour={n.name} className={`nav-folder${active === n.name && items.length ? " is-open" : ""}`}>
      {item(n)}
      <div className="nav-folder-items" role="group" aria-label={label} aria-hidden={active !== n.name}>
        <div className="nav-folder-inner">{items.map((f) => item(f, true))}</div>
      </div>
    </div>
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
        n.name === "crate" ? folder(n, CRATE_FOLDER, "In Your Crate")
          : n.name === "shelf" ? folder(n, shelfFolder, "On Your Shelf")
          : item(n)
      ))}

      <div className="sidebar-foot">
        {item({ name: "settings", label: "Settings", Icon: SettingsIcon })}
      </div>
    </nav>
  );
}

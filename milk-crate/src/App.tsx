import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Country } from "./lib/geo";
import { Sidebar } from "./components/Sidebar";
import { PlayerBar } from "./components/PlayerBar";
import { PlayerProvider } from "./lib/player";
import { Home } from "./screens/Home";
import { Scenes } from "./screens/Scenes";
import { Crate } from "./screens/Crate";
import { Computer } from "./screens/Computer";
import { Shelf } from "./screens/Shelf";
import { ArtistPage } from "./screens/ArtistPage";
import { Artists } from "./screens/Artists";
import { AlbumPage } from "./screens/AlbumPage";
import { useAlbumAccent } from "./lib/useAlbumAccent";
import { CatalogProvider } from "./lib/catalog";
import { AuthProvider } from "./lib/auth";
import { Upload } from "./screens/Upload";
import { Account } from "./screens/Account";
import { Review } from "./screens/Review";
import { EditRelease } from "./screens/EditRelease";
import { Settings } from "./screens/Settings";
import { Policies, type PolicyDoc } from "./screens/Policies";
import { Inbox } from "./screens/Inbox";
import { ArtistStats } from "./screens/ArtistStats";
import { Welcome } from "./screens/Welcome";
import { LocationProvider, useLocation } from "./lib/location";
import { LibraryProvider } from "./lib/library";
import { DownloadsProvider } from "./lib/downloads";
import { SettingsProvider, useSettings } from "./lib/settings";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { NeedsAccount } from "./components/NeedsAccount";
import { Logo } from "./components/ui";
import { Backdrop } from "./components/Backdrop";
import { Immersive } from "./components/Immersive";
import { FrostGrain } from "./components/FrostGrain";
import { QueuePanel } from "./components/QueuePanel";
import { SearchPalette } from "./components/SearchPalette";
import { FeedbackDialog } from "./components/FeedbackDialog";
import { usePersistentState } from "./lib/storage";
import { listenForLinks } from "./lib/share";
import { reportErrors } from "./lib/errors";
import { ErrorBoundary } from "./components/ErrorBoundary";

/** Screens the app can show. Add a case here and in <Screen> for each new one. */
/** Your Crate's pages. No tab: the overview (recent albums, singles, favorites and plays). */
export type CrateTab = "albums" | "singles" | "favorites" | "history" | "playlists";
export type ShelfFormat = "vinyl" | "45s" | "cds" | "cassettes";
export type SettingsTab = "appearance" | "sound" | "downloads" | "updates";
export type Route =
  | { name: "home" }
  | { name: "crate"; tab?: CrateTab; releaseId?: string; playlistId?: string }
  | { name: "computer"; album?: string }
  | { name: "shelf"; format?: ShelfFormat }
  | { name: "artist"; artistId?: string }
  | { name: "album"; releaseId: string }
  | { name: "scenes"; explore?: { name: string; state: string; country?: Country } }
  | { name: "account" }
  | { name: "upload" }
  | { name: "editRelease"; releaseId: string }
  | { name: "review" }
  | { name: "settings"; tab?: SettingsTab }
  | { name: "policies"; doc: PolicyDoc }
  | { name: "inbox" }
  | { name: "stats" };

export type Go = (r: Route) => void;
interface Visit { route: Route; scroll: number }

function Screen({ route, go }: { route: Route; go: Go }) {
  switch (route.name) {
    case "home":
      return <Home go={go} />;
    case "crate":
      return <Crate go={go} tab={route.tab} releaseId={route.releaseId} playlistId={route.playlistId} />;
    case "computer":
      return <Computer go={go} album={route.album} key={route.album ?? "all"} />;
    case "shelf":
      return <Shelf go={go} format={route.format} />;
    case "artist":
      return route.artistId ? <ArtistPage go={go} artistId={route.artistId} key={route.artistId} /> : <Artists go={go} />;
    case "album":
      return <AlbumPage go={go} releaseId={route.releaseId} key={route.releaseId} />;
    case "scenes":
      return <Scenes go={go} explore={route.explore} key={route.explore ? `${route.explore.name}|${route.explore.state}|${route.explore.country ?? "US"}` : "home"} />;
    case "account":
      return <Account go={go} />;
    case "upload":
      return <Upload go={go} />;
    case "editRelease":
      return <EditRelease go={go} releaseId={route.releaseId} key={route.releaseId} />;
    case "review":
      return <Review go={go} />;
    case "settings":
      return <Settings go={go} tab={route.tab ?? "appearance"} />;
    case "policies":
      return <Policies go={go} doc={route.doc} />;
    case "inbox":
      return <Inbox go={go} />;
    case "stats":
      return <ArtistStats go={go} />;
  }
}

/** Renders nothing; keeps the accent color matched to the album that's playing. */
function AlbumAccent() {
  const { theme, matchAlbum, accentColor } = useSettings();
  useAlbumAccent(theme, matchAlbum, accentColor);
  return null;
}

export default function App() {
  return (
    <SettingsProvider>
    <AuthProvider>
    <CatalogProvider>
    <LocationProvider>
    <LibraryProvider>
    <DownloadsProvider>
    <PlayerProvider>
      <Shell />
      <UpdatePrompt />
    </PlayerProvider>
    </DownloadsProvider>
    </LibraryProvider>
    </LocationProvider>
    </CatalogProvider>
    </AuthProvider>
    </SettingsProvider>
  );
}

/** Screens that work before a home city is chosen (signing in, applying as an artist). */
const NO_CITY_NEEDED: Route["name"][] = ["computer", "upload", "editRelease", "account", "review", "settings", "policies", "stats"];

function Shell() {
  const [route, setRoute] = useState<Route>({ name: "home" });
  const [immersive, setImmersive] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [search, setSearch] = useState<string | null>(null);
  const [feedback, setFeedback] = useState(false);
  useEffect(() => {
    const onOpen = () => setFeedback(true);
    window.addEventListener("mc:feedback", onOpen);
    return () => window.removeEventListener("mc:feedback", onOpen);
  }, []);
  const [sideCollapsed, setSideCollapsed] = usePersistentState("mc.sidebarCollapsed", false);
  const main = useRef<HTMLElement>(null);
  const loc = useLocation();

  // Back and forward, like a browser: each page remembers where you were scrolled.
  const [past, setPast] = useState<Visit[]>([]);
  const [ahead, setAhead] = useState<Visit[]>([]);
  const restoreScroll = useRef<number | null>(null);
  const here = (): Visit => ({ route, scroll: main.current?.scrollTop ?? 0 });
  const go: Go = (r) => {
    setQueueOpen(false);
    if (JSON.stringify(r) === JSON.stringify(route)) { main.current?.scrollTo({ top: 0 }); return; }
    setPast((h) => [...h, here()].slice(-100));
    setAhead([]);
    setRoute(r);
    restoreScroll.current = 0;
  };
  const back = () => {
    const prev = past[past.length - 1];
    if (!prev) return;
    setPast((h) => h.slice(0, -1));
    setAhead((f) => [here(), ...f]);
    setRoute(prev.route);
    restoreScroll.current = prev.scroll;
    setQueueOpen(false);
  };
  const forward = () => {
    const next = ahead[0];
    if (!next) return;
    setAhead((f) => f.slice(1));
    setPast((h) => [...h, here()]);
    setRoute(next.route);
    restoreScroll.current = next.scroll;
    setQueueOpen(false);
  };
  useLayoutEffect(() => {
    const y = restoreScroll.current;
    if (y === null) return;
    restoreScroll.current = null;
    main.current?.scrollTo({ top: 0 });
    // Pages that load their content a moment later still land where you left them.
    if (y > 0) requestAnimationFrame(() => requestAnimationFrame(() => main.current?.scrollTo({ top: y })));
  }, [route]);
  // Mouse back/forward buttons, Alt+← / Alt+→, and ⌘[ / ⌘] on a Mac.
  const navRef = useRef({ back, forward });
  navRef.current = { back, forward };
  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) { e.preventDefault(); navRef.current.back(); }
      if (e.button === 4) { e.preventDefault(); navRef.current.forward(); }
    };
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable='true']");
      if (typing) return;
      const backKey = (e.altKey && e.key === "ArrowLeft") || (e.metaKey && e.key === "[");
      const fwdKey = (e.altKey && e.key === "ArrowRight") || (e.metaKey && e.key === "]");
      if (backKey) { e.preventDefault(); navRef.current.back(); }
      if (fwdKey) { e.preventDefault(); navRef.current.forward(); }
    };
    window.addEventListener("mouseup", onMouse);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mouseup", onMouse); window.removeEventListener("keydown", onKey); };
  }, []);
  // Share links (milkcrate://album/…) open that page, at launch or while running.
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    let stop: (() => void) | undefined;
    let live = true;
    void listenForLinks((r) => goRef.current(r)).then((s) => { if (live) stop = s; else s(); });
    return () => { live = false; stop?.(); };
  }, []);
  // Search: Ctrl+K / ⌘K, or "/" when not typing; the Home search box and sidebar open it too.
  useEffect(() => {
    const onOpen = (e: Event) => setSearch((e as CustomEvent<string>).detail ?? "");
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable='true']");
      if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setSearch((s) => (s === null ? "" : null)); }
      else if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setSearch(""); }
    };
    window.addEventListener("mc:search", onOpen);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mc:search", onOpen); window.removeEventListener("keydown", onKey); };
  }, []);
  // Errors are reported with the screen they happened on.
  useEffect(() => reportErrors(() => route.name), [route.name]);

  if (!loc.ready && !NO_CITY_NEEDED.includes(route.name)) return <div className="splash"><Logo /></div>;
  if (!loc.home && !NO_CITY_NEEDED.includes(route.name)) return <Welcome go={go} />;

  return (
    <>
      <AlbumAccent />
      <Backdrop />
      {/* Each glass surface wraps its content so the frosted grain can sit between its tint and its content. */}
      <div className={`shell${sideCollapsed ? " side-collapsed" : ""}`}>
        <div className="shell-side">
          <FrostGrain saturate={1.5} />
          <Sidebar route={route} go={go} collapsed={sideCollapsed} onToggle={() => setSideCollapsed((c) => !c)} />
        </div>
        <div className="shell-main-wrap">
          <FrostGrain />
          <main className="shell-main" ref={main}>
            <nav className="main-nav" aria-label="Back and forward"><div className="main-nav-pill">
              <button type="button" className="mc-icon-btn main-nav-btn" onClick={back} disabled={!past.length}
                aria-label="Back" title={past.length ? "Back (Alt+←)" : "Back"}><ChevronLeft size={20} strokeWidth={2} aria-hidden="true" /></button>
              <button type="button" className="mc-icon-btn main-nav-btn" onClick={forward} disabled={!ahead.length}
                aria-label="Forward" title={ahead.length ? "Forward (Alt+→)" : "Forward"}><ChevronRight size={20} strokeWidth={2} aria-hidden="true" /></button>
            </div></nav>
            <ErrorBoundary key={JSON.stringify(route)} go={go}>
              <Screen route={route} go={go} />
            </ErrorBoundary>
          </main>
        </div>
        <div className="shell-player">
          <FrostGrain saturate={1.5} />
          <PlayerBar go={go} onImmersive={() => setImmersive(true)} queueOpen={queueOpen} onQueue={() => setQueueOpen((o) => !o)} />
        </div>
      </div>
      {queueOpen && <QueuePanel onClose={() => setQueueOpen(false)} />}
      {search !== null && <SearchPalette go={go} initial={search} onClose={() => setSearch(null)} />}
      {feedback && <FeedbackDialog onClose={() => setFeedback(false)} />}
      <NeedsAccount go={go} />
      {immersive && <Immersive go={go} onClose={() => setImmersive(false)} />}
    </>
  );
}

import { useRef, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { PlayerBar } from "./components/PlayerBar";
import { PlayerProvider } from "./lib/player";
import { Home } from "./screens/Home";
import { Scenes } from "./screens/Scenes";
import { Crate } from "./screens/Crate";
import { ArtistPage } from "./screens/ArtistPage";
import { Artists } from "./screens/Artists";
import { AlbumPage } from "./screens/AlbumPage";
import { useAlbumAccent } from "./lib/useAlbumAccent";
import { CatalogProvider } from "./lib/catalog";
import { AuthProvider } from "./lib/auth";
import { Upload } from "./screens/Upload";
import { Account } from "./screens/Account";
import { Review } from "./screens/Review";
import { Settings } from "./screens/Settings";
import { Welcome } from "./screens/Welcome";
import { LocationProvider, useLocation } from "./lib/location";
import { LibraryProvider } from "./lib/library";
import { SettingsProvider, useSettings } from "./lib/settings";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { NeedsAccount } from "./components/NeedsAccount";
import { Logo } from "./components/ui";
import { Backdrop } from "./components/Backdrop";
import { Immersive } from "./components/Immersive";

/** Screens the app can show. Add a case here and in <Screen> for each new one. */
export type CrateTab = "albums" | "songs" | "physical" | "playlists" | "files";
export type SettingsTab = "appearance" | "sound" | "updates";
export type Route =
  | { name: "home" }
  | { name: "crate"; tab?: CrateTab; releaseId?: string; playlistId?: string }
  | { name: "artist"; artistId?: string }
  | { name: "album"; releaseId: string }
  | { name: "scenes"; explore?: { name: string; state: string } }
  | { name: "account" }
  | { name: "upload" }
  | { name: "review" }
  | { name: "settings"; tab?: SettingsTab };

export type Go = (r: Route) => void;

function Screen({ route, go }: { route: Route; go: Go }) {
  switch (route.name) {
    case "home":
      return <Home go={go} />;
    case "crate":
      return <Crate go={go} tab={route.tab} releaseId={route.releaseId} playlistId={route.playlistId} />;
    case "artist":
      return route.artistId ? <ArtistPage go={go} artistId={route.artistId} key={route.artistId} /> : <Artists go={go} />;
    case "album":
      return <AlbumPage go={go} releaseId={route.releaseId} key={route.releaseId} />;
    case "scenes":
      return <Scenes go={go} explore={route.explore} key={route.explore ? `${route.explore.name}|${route.explore.state}` : "home"} />;
    case "account":
      return <Account go={go} />;
    case "upload":
      return <Upload go={go} />;
    case "review":
      return <Review go={go} />;
    case "settings":
      return <Settings go={go} tab={route.tab ?? "appearance"} />;
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
    <PlayerProvider>
      <Shell />
      <UpdatePrompt />
    </PlayerProvider>
    </LibraryProvider>
    </LocationProvider>
    </CatalogProvider>
    </AuthProvider>
    </SettingsProvider>
  );
}

/** Screens that work before a home city is chosen (signing in, applying as an artist). */
const NO_CITY_NEEDED: Route["name"][] = ["upload", "account", "review", "settings"];

function Shell() {
  const [route, setRoute] = useState<Route>({ name: "home" });
  const [immersive, setImmersive] = useState(false);
  const main = useRef<HTMLElement>(null);
  const loc = useLocation();

  const go: Go = (r) => {
    setRoute(r);
    main.current?.scrollTo({ top: 0 });
  };

  if (!loc.ready && !NO_CITY_NEEDED.includes(route.name)) return <div className="splash"><Logo /></div>;
  if (!loc.home && !NO_CITY_NEEDED.includes(route.name)) return <Welcome go={go} />;

  return (
    <>
      <AlbumAccent />
      <Backdrop />
      <div className="shell">
        <Sidebar route={route} go={go} />
        <main className="shell-main" ref={main}>
          <Screen route={route} go={go} />
        </main>
        <div className="shell-player">
          <PlayerBar go={go} onImmersive={() => setImmersive(true)} />
        </div>
      </div>
      <NeedsAccount go={go} />
      {immersive && <Immersive go={go} onClose={() => setImmersive(false)} />}
    </>
  );
}

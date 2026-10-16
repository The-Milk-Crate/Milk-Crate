import { useEffect, useRef, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { PlayerBar } from "./components/PlayerBar";
import { PlayerProvider } from "./lib/player";
import { usePersistentState } from "./lib/storage";
import { Home } from "./screens/Home";
import { Scenes } from "./screens/Scenes";
import { Crate } from "./screens/Crate";
import { ArtistPage } from "./screens/ArtistPage";
import { Artists } from "./screens/Artists";
import { useAlbumAccent } from "./lib/useAlbumAccent";
import { CatalogProvider } from "./lib/catalog";
import { AuthProvider } from "./lib/auth";
import { Upload } from "./screens/Upload";
import { Account } from "./screens/Account";
import { Review } from "./screens/Review";
import { Welcome } from "./screens/Welcome";
import { LocationProvider, useLocation } from "./lib/location";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { Logo } from "./components/ui";

/** Screens the app can show. Add a case here and in <Screen> for each new one. */
export type Route =
  | { name: "home" }
  | { name: "scenes"; explore?: { name: string; state: string } }
  | { name: "crate" }
  | { name: "artist"; artistId?: string }
  | { name: "upload" }
  | { name: "account" }
  | { name: "review" };

export type Go = (r: Route) => void;

function Screen({ route, go }: { route: Route; go: Go }) {
  switch (route.name) {
    case "home":
      return <Home go={go} />;
    case "scenes":
      return <Scenes go={go} explore={route.explore} key={route.explore ? `${route.explore.name}|${route.explore.state}` : "home"} />;
    case "crate":
      return <Crate go={go} />;
    case "artist":
      return route.artistId ? <ArtistPage go={go} artistId={route.artistId} /> : <Artists go={go} />;
    case "upload":
      return <Upload go={go} />;
    case "account":
      return <Account go={go} />;
    case "review":
      return <Review go={go} />;
  }
}

/** Renders nothing; keeps the accent color matched to the album that's playing. */
function AlbumAccent({ theme, enabled }: { theme: "dark" | "light"; enabled: boolean }) {
  useAlbumAccent(theme, enabled);
  return null;
}

export default function App() {
  return (
    <AuthProvider>
    <CatalogProvider>
    <LocationProvider>
    <PlayerProvider>
      <Shell />
      <UpdatePrompt />
    </PlayerProvider>
    </LocationProvider>
    </CatalogProvider>
    </AuthProvider>
  );
}

/** Screens that work before a home city is chosen (signing in, applying as an artist). */
const NO_CITY_NEEDED: Route["name"][] = ["upload", "account", "review"];

function Shell() {
  const [route, setRoute] = useState<Route>({ name: "home" });
  const [theme, setTheme] = usePersistentState<"dark" | "light">("mc.theme", "dark");
  const [matchAlbum, setMatchAlbum] = usePersistentState("mc.matchAlbumColors", true);
  const main = useRef<HTMLElement>(null);
  const loc = useLocation();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const go: Go = (r) => {
    setRoute(r);
    main.current?.scrollTo({ top: 0 });
  };

  if (!loc.ready && !NO_CITY_NEEDED.includes(route.name)) return <div className="splash"><Logo /></div>;
  if (!loc.home && !NO_CITY_NEEDED.includes(route.name)) return <Welcome go={go} />;

  return (
    <>
      <AlbumAccent theme={theme} enabled={matchAlbum} />
      <div className="shell">
        <Sidebar
          route={route}
          go={go}
          theme={theme}
          onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
          matchAlbum={matchAlbum}
          onToggleMatchAlbum={() => setMatchAlbum(!matchAlbum)}
        />
        <main className="shell-main" ref={main}>
          <Screen route={route} go={go} />
        </main>
        <div className="shell-player">
          <PlayerBar />
        </div>
      </div>
    </>
  );
}

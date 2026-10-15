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
import { UpdatePrompt } from "./components/UpdatePrompt";

/** Screens the app can show. Add a case here and in <Screen> for each new one. */
export type Route =
  | { name: "home" }
  | { name: "scenes"; sceneId?: string }
  | { name: "crate" }
  | { name: "artist"; artistId?: string }
  | { name: "upload" };

export type Go = (r: Route) => void;

function Screen({ route, go }: { route: Route; go: Go }) {
  switch (route.name) {
    case "home":
      return <Home go={go} />;
    case "scenes":
      return <Scenes go={go} sceneId={route.sceneId} />;
    case "crate":
      return <Crate go={go} />;
    case "artist":
      return route.artistId ? <ArtistPage go={go} artistId={route.artistId} /> : <Artists go={go} />;
    case "upload":
      return <Upload go={go} />;
  }
}

/** Renders nothing; keeps the accent color matched to the album that's playing. */
function AlbumAccent({ theme, enabled }: { theme: "dark" | "light"; enabled: boolean }) {
  useAlbumAccent(theme, enabled);
  return null;
}

export default function App() {
  const [route, setRoute] = useState<Route>({ name: "home" });
  const [theme, setTheme] = usePersistentState<"dark" | "light">("mc.theme", "dark");
  const [matchAlbum, setMatchAlbum] = usePersistentState("mc.matchAlbumColors", true);
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const go: Go = (r) => {
    setRoute(r);
    main.current?.scrollTo({ top: 0 });
  };

  return (
    <AuthProvider>
    <CatalogProvider>
    <PlayerProvider>
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
      <UpdatePrompt />
    </PlayerProvider>
    </CatalogProvider>
    </AuthProvider>
  );
}

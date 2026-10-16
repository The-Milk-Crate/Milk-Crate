/** App settings, saved on this computer. */
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { usePersistentState } from "./storage";

interface Settings {
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
  /** Accent color follows the album that's playing. */
  matchAlbum: boolean;
  setMatchAlbum: (on: boolean) => void;
}
const SettingsContext = createContext<Settings | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = usePersistentState<"dark" | "light">("mc.theme", "dark");
  const [matchAlbum, setMatchAlbum] = usePersistentState("mc.matchAlbumColors", true);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return <SettingsContext.Provider value={{ theme, setTheme, matchAlbum, setMatchAlbum }}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside <SettingsProvider>");
  return ctx;
}

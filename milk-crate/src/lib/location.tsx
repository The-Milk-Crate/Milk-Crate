/**
 * Where the person using the app lives, and the scene around it.
 *
 * - Listener accounts: saved on the server (private to them).
 * - Artist accounts: their artist profile's city.
 * - Browsing without an account: saved on this computer only.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "./auth";
import { useCatalog } from "./catalog";
import { supabase } from "./supabase";
import { findPlace, placeFromLabel, sceneFor, usePlaces, type Place, type Scene } from "./geo";
import type { Artist } from "./types";

/** An approved artist and where they're from. */
export interface ArtistPlace { artist: Artist; place: Place }

const LOCAL_KEY = "mc.home";

interface Location {
  places: Place[] | null;
  home: Place | null;
  scene: Scene | null;
  /** True once we know whether there's a home city (it may be null: then ask). */
  ready: boolean;
  setHome: (place: Place) => Promise<void>;
  /** Where an artist is, from their profile. */
  placeOf: (artist: Artist) => Place | null;
}

const LocationContext = createContext<Location | null>(null);

function readLocal(): Place | null {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "null");
    return v && typeof v.lat === "number" && typeof v.lng === "number" && typeof v.name === "string" && /^[A-Z]{2}$/.test(v.state) ? v : null;
  } catch {
    return null;
  }
}
/** Remembers a city on this computer without switching to it yet (used while signing up, before the account exists). */
export function rememberCity(p: Place) {
  writeLocal(p);
}
function writeLocal(p: Place) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: keep it for this session only */
  }
}

export function LocationProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const { myProfile } = useCatalog();
  const places = usePlaces();
  const [listenerHome, setListenerHome] = useState<Place | null | undefined>(undefined);
  const [localHome, setLocalHome] = useState<Place | null>(readLocal);

  const placeOf = useCallback(
    (a: Artist): Place | null => {
      if (typeof a.lat === "number" && typeof a.lng === "number") {
        const name = a.city ?? a.place.split(",")[0];
        const state = a.state ?? a.place.split(",")[1]?.trim() ?? "";
        return { name, state, lat: a.lat, lng: a.lng, pop: (places && findPlace(places, name, state)?.pop) ?? 0 };
      }
      return places ? placeFromLabel(places, a.place) ?? null : null;
    },
    [places],
  );

  // Listener accounts: load their saved city. A city chosen while signing up (or while browsing) is saved to the account.
  useEffect(() => {
    setListenerHome(undefined);
    if (auth.kind !== "listener" || !auth.userId) return;
    let live = true;
    supabase.from("listeners").select("*").eq("user_id", auth.userId).maybeSingle().then(async ({ data, error }) => {
      if (!live) return;
      if (error) {
        // Server unreachable (or not updated yet): use the city saved on this computer.
        setListenerHome(readLocal());
        return;
      }
      if (data) {
        setListenerHome({ name: data.city, state: data.state, lat: data.lat, lng: data.lng, pop: 0 });
        return;
      }
      const pending = readLocal();
      if (pending) {
        await supabase.from("listeners").upsert({ user_id: auth.userId, city: pending.name, state: pending.state, lat: pending.lat, lng: pending.lng });
        if (live) setListenerHome(pending);
      } else setListenerHome(null);
    });
    return () => {
      live = false;
    };
  }, [auth.kind, auth.userId]);

  const artistHome = auth.kind === "artist" && myProfile ? placeOf(myProfile) : null;
  const rawHome = auth.kind === "listener" ? listenerHome ?? null : artistHome ?? localHome;
  // Fill in population from the city list (used to rank labels on the map).
  const home = useMemo(
    () => (rawHome && places ? { ...rawHome, pop: findPlace(places, rawHome.name, rawHome.state)?.pop ?? rawHome.pop } : rawHome),
    [rawHome?.name, rawHome?.state, rawHome?.lat, rawHome?.lng, places], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const scene = useMemo(() => (home && places ? sceneFor(home, places) : null), [home, places]);
  const ready = auth.ready && !!places && (auth.kind !== "listener" || listenerHome !== undefined);

  const setHome = useCallback(
    async (p: Place) => {
      writeLocal(p);
      setLocalHome(p);
      if (auth.kind === "listener" && auth.userId) {
        const { error } = await supabase.from("listeners").upsert({ user_id: auth.userId, city: p.name, state: p.state, lat: p.lat, lng: p.lng });
        if (error) throw new Error(/relation|does not exist|schema cache/i.test(error.message) ? "the server needs a one-time update (supabase/003_accounts_and_places.sql)." : error.message);
        setListenerHome(p);
      }
    },
    [auth.kind, auth.userId],
  );

  const value = useMemo<Location>(() => ({ places, home, scene, ready, setHome, placeOf }), [places, home, scene, ready, setHome, placeOf]);
  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}

export function useLocation() {
  const ctx = useContext(LocationContext);
  if (!ctx) throw new Error("useLocation must be used inside <LocationProvider>");
  return ctx;
}

/** Every approved artist whose location is known, with their place. */
export function useArtistPlaces(): ArtistPlace[] {
  const { artists } = useCatalog();
  const { placeOf } = useLocation();
  return useMemo(() => artists.flatMap((artist) => {
    const place = placeOf(artist);
    return place ? [{ artist, place }] : [];
  }), [artists, placeOf]);
}

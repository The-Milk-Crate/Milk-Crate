/**
 * What's new for you: releases from artists you follow, and new music from
 * your scene. Worked out on this computer from the catalog; "seen" is
 * remembered per account so the badge clears once you've looked.
 */
import { useCallback, useEffect, useMemo } from "react";
import { useCatalog } from "./catalog";
import { useLibrary } from "./library";
import { useArtistPlaces, useLocation } from "./location";
import { useAuth } from "./auth";
import { inScene } from "./geo";
import { usePersistentState } from "./storage";
import { outAt, type Release } from "./types";

const DAY = 86_400_000;
/** How far back "new" goes. */
const FOLLOWED_DAYS = 60;
const SCENE_DAYS = 30;

export interface Alert { release: Release; why: "following" | "scene"; at: number; unread: boolean }

export function useAlerts() {
  const c = useCatalog();
  const lib = useLibrary();
  const { userId } = useAuth();
  const { scene } = useLocation();
  const placed = useArtistPlaces();
  const [seenBy, setSeenBy] = usePersistentState<Record<string, number>>("mc.inboxSeen", {});
  const who = userId ?? "guest";
  // First visit: only the last week counts as new, so the badge doesn't start out full.
  const seen = seenBy[who] ?? Date.now() - 7 * DAY;
  useEffect(() => {
    if (seenBy[who] === undefined) setSeenBy((m) => ({ ...m, [who]: Date.now() - 7 * DAY }));
  }, [who]); // eslint-disable-line react-hooks/exhaustive-deps

  const alerts = useMemo<Alert[]>(() => {
    const now = Date.now();
    const near = new Set(scene ? placed.filter((a) => inScene(scene, a.place)).map((a) => a.artist.id) : []);
    const out: Alert[] = [];
    for (const r of c.releases) {
      if (c.artistById[r.artistId]?.status !== "approved" || r.artistId === c.myProfile?.id) continue;
      // A scheduled release counts as new on the day it comes out.
      const at = outAt(r);
      if (!at) continue;
      const followed = lib.isFollowing(r.artistId);
      if (followed && now - at < FOLLOWED_DAYS * DAY) out.push({ release: r, why: "following", at, unread: at > seen });
      else if (!followed && near.has(r.artistId) && now - at < SCENE_DAYS * DAY) out.push({ release: r, why: "scene", at, unread: at > seen });
    }
    return out.sort((a, b) => b.at - a.at);
  }, [c.releases, c.artistById, c.myProfile, lib, scene, placed, seen]);

  // Coming soon from artists you follow, and from your scene (not counted in the badge).
  const coming = useMemo(() => {
    const near = new Set(scene ? placed.filter((a) => inScene(scene, a.place)).map((a) => a.artist.id) : []);
    return c.upcoming.filter((r) => r.artistId !== c.myProfile?.id && (lib.isFollowing(r.artistId) || near.has(r.artistId)));
  }, [c.upcoming, c.myProfile, lib, scene, placed]);

  const markSeen = useCallback(() => setSeenBy((m) => ({ ...m, [who]: Date.now() })), [setSeenBy, who]);
  return { alerts, coming, unread: alerts.filter((a) => a.unread).length, markSeen };
}

/**
 * Listening history in your account (supabase/009_listening_history.sql), so
 * it follows you to any computer. Private to you. Files from your own computer
 * stay in this computer's history only.
 *
 * The first time an account signs in on a computer with no history in the
 * account yet, what this computer played is brought in, so nothing is lost.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { load, save } from "./storage";

export interface Play { trackId: string; releaseId: string; at: number }

/** How much history the app loads (the server keeps the newest 2,000). */
export const HISTORY_LOAD = 500;

export const isLocalTrack = (trackId: string) => trackId.startsWith("local:");

/**
 * The account's history, newest first. `plays` is null when signed out or
 * when the server doesn't have history yet (then this computer's history is used).
 */
export function useAccountHistory(userId: string | undefined, localHistory: Play[], releaseOf: (trackId: string) => string | undefined) {
  const [plays, setPlays] = useState<Play[] | null>(null);

  useEffect(() => {
    setPlays(null);
    if (!userId) return;
    let live = true;
    void (async () => {
      const { data, error } = await supabase.from("listening_history").select("track_id,played_at").order("played_at", { ascending: false }).limit(HISTORY_LOAD);
      if (!live || error) return; // not set up yet: keep using this computer's history
      let rows = (data ?? []).map((r) => ({ trackId: r.track_id as string, at: Date.parse(r.played_at as string) }));
      // Nothing in the account yet: bring in what this computer played (once per account per computer).
      const flag = `mc.historyImported.${userId}`;
      if (!rows.length && !load(flag, false)) {
        const mine = localHistory.filter((h) => !isLocalTrack(h.trackId)).slice(0, HISTORY_LOAD);
        if (mine.length) {
          const { error: e } = await supabase.from("listening_history").insert(mine.map((h) => ({ track_id: h.trackId, played_at: new Date(h.at).toISOString() })));
          if (!e) rows = mine.map((h) => ({ trackId: h.trackId, at: h.at }));
        }
        save(flag, true);
      }
      if (live) setPlays(rows.map((r) => ({ ...r, releaseId: releaseOf(r.trackId) ?? "" })));
    })();
    return () => { live = false; };
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Records a play in the account (Milk Crate songs only). */
  const add = useCallback((play: Play) => {
    if (!userId || isLocalTrack(play.trackId)) return;
    setPlays((p) => (p ? [play, ...p].slice(0, HISTORY_LOAD) : p));
    // (The request only goes out once something waits on it.)
    void supabase.from("listening_history").insert({ track_id: play.trackId, played_at: new Date(play.at).toISOString() }).then(() => undefined);
  }, [userId]);

  /** Clears the account's history everywhere. */
  const clear = useCallback(async () => {
    if (!userId) return;
    const { error } = await supabase.from("listening_history").delete().eq("user_id", userId);
    if (error && !/relation|does not exist|schema cache/i.test(error.message)) throw new Error(error.message);
    setPlays((p) => (p ? [] : p));
  }, [userId]);

  return { plays, add, clear };
}

/** The account's plays plus this computer's plays of files from this computer, newest first. */
export function mergeHistory(account: Play[], local: Play[]): Play[] {
  return [...account, ...local.filter((h) => isLocalTrack(h.trackId))].sort((a, b) => b.at - a.at);
}

/** "Today", "Yesterday", "Monday", "Oct 3": for grouping history by day. */
export function dayLabel(at: number, now = Date.now()) {
  const d = new Date(at);
  const start = (t: number) => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const days = Math.round((start(now) - start(at)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(new Date(now).getFullYear() !== d.getFullYear() ? { year: "numeric" } : {}) });
}

/** "just now", "4 min ago", "2 hr ago", or the time of day for older plays. */
export function agoLabel(at: number, now = Date.now()) {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 6 * 3600) return `${Math.floor(s / 3600)} hr ago`;
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

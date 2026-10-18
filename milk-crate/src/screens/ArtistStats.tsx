import { useEffect, useState } from "react";
import type { Go } from "../App";
import { useCatalog } from "../lib/catalog";
import { supabase } from "../lib/supabase";
import { formatTime } from "../lib/format";
import { isCountry, placeLabelFrom, type Country } from "../lib/geo";
import { Button } from "../components/ui";

interface TrackStat { trackId: string; plays: number; plays30: number; listeners: number }
interface TownStat { city: string | null; state: string | null; country: Country; plays: number; listeners: number }

/**
 * An artist's own numbers, for their eyes only: plays and listeners per song,
 * album ratings, and where people listen from. No charts, no comparing to anyone.
 */
export function ArtistStats({ go }: { go: Go }) {
  const c = useCatalog();
  const me = c.myProfile;
  const [tracks, setTracks] = useState<TrackStat[] | null>(null);
  const [towns, setTowns] = useState<TownStat[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!me) return;
    Promise.all([supabase.rpc("my_artist_stats"), supabase.rpc("my_artist_towns")]).then(([s, t]) => {
      const err = s.error ?? t.error;
      if (err) return setError(/function|does not exist|schema cache/i.test(err.message) ? "The server needs a one-time update first: run supabase/005_accounts_reports_stats.sql in the Supabase SQL Editor." : err.message);
      setTracks(((s.data ?? []) as Record<string, unknown>[]).map((r) => ({ trackId: String(r.track_id), plays: Number(r.plays), plays30: Number(r.plays_30d), listeners: Number(r.listeners) })));
      setTowns(((t.data ?? []) as Record<string, unknown>[]).map((r) => ({ city: (r.city as string) ?? null, state: (r.state as string) ?? null, country: isCountry(r.country) ? r.country : "US", plays: Number(r.plays), listeners: Number(r.listeners) })).filter((x) => x.plays > 0));
    });
  }, [me]);

  if (!me) return <div className="screen"><p className="muted">Stats are for artist accounts.</p><Button onClick={() => go({ name: "upload" })}>Go to For Artists</Button></div>;

  const byTrack = new Map((tracks ?? []).map((t) => [t.trackId, t]));
  const total = (tracks ?? []).reduce((a, t) => ({ plays: a.plays + t.plays, plays30: a.plays30 + t.plays30 }), { plays: 0, plays30: 0 });
  const listeners = towns.reduce((n, t) => n + t.listeners, 0);
  const releases = c.myReleases;

  return (
    <div className="screen" style={{ maxWidth: 1000 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="catalog eyebrow">{me.name} · your stats</span>
        <h1 className="display-lg">Your stats</h1>
        <p className="muted" style={{ maxWidth: 640 }}>
          A stream counts after about 30 seconds of listening. To keep counts fair, replays of the same song by the same listener within 4 hours count once, and your own plays don't count.
          Each song's total streams are public: they rank your Popular songs and size your dot on the scene maps.
          The rest here (last 30 days, how many listeners, where they are) only you can see.
        </p>
      </header>
      {error && <p role="alert" className="form-error">{error}</p>}
      {!tracks && !error && <p className="muted">Counting…</p>}
      {tracks && (
        <>
          <div className="stat-tiles">
            <div className="stat-tile"><span className="catalog eyebrow">Streams</span><strong className="numeral stat-num">{total.plays.toLocaleString()}</strong></div>
            <div className="stat-tile"><span className="catalog eyebrow">Last 30 days</span><strong className="numeral stat-num">{total.plays30.toLocaleString()}</strong></div>
            <div className="stat-tile"><span className="catalog eyebrow">Listeners</span><strong className="numeral stat-num">{listeners.toLocaleString()}</strong></div>
          </div>

          {releases.map((r) => (
            <section key={r.id} className="section">
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <h2 className="display-md">{r.title} <span className="muted" style={{ fontSize: "0.6em" }}>{r.kind} · {r.year}</span></h2>
                <span className="caption muted numeral">
                  {c.albumAverages[r.id] ? `${c.albumAverages[r.id].toFixed(1)} ★ from ${c.albumRatingCounts[r.id] ?? 0} ${(c.albumRatingCounts[r.id] ?? 0) === 1 ? "rating" : "ratings"}` : "No album ratings yet"}
                </span>
              </div>
              <table className="stat-table">
                <thead><tr><th scope="col">Song</th><th scope="col">Streams</th><th scope="col">30 days</th><th scope="col">Listeners</th></tr></thead>
                <tbody>
                  {r.trackIds.map((id) => c.trackById[id]).filter(Boolean).map((t) => {
                    const s = byTrack.get(t.id);
                    return (
                      <tr key={t.id}>
                        <th scope="row"><span style={{ fontWeight: 600 }}>{t.title}</span> <span className="caption muted">{formatTime(t.duration)}</span></th>
                        <td className="numeral">{(s?.plays ?? 0).toLocaleString()}</td>
                        <td className="numeral">{(s?.plays30 ?? 0).toLocaleString()}</td>
                        <td className="numeral">{(s?.listeners ?? 0).toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ))}
          {!releases.length && <div className="empty"><span>Put out your first release and its numbers show up here.</span></div>}

          <section className="section">
            <h2 className="display-md">Where people listen</h2>
            <p className="caption muted">A town shows once 3 or more different listeners there have played you, so no one can be picked out.</p>
            {towns.length ? (
              <table className="stat-table">
                <thead><tr><th scope="col">Town</th><th scope="col">Plays</th><th scope="col">Listeners</th></tr></thead>
                <tbody>
                  {towns.map((t, i) => (
                    <tr key={i}>
                      <th scope="row">{t.city ? placeLabelFrom({ name: t.city, state: t.state ?? "", country: t.country }, me.country) : "Other towns"}</th>
                      <td className="numeral">{t.plays.toLocaleString()}</td>
                      <td className="numeral">{t.listeners.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="empty"><span>No plays from listeners with a home city yet.</span></div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

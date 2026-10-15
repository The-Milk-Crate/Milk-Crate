import { useState } from "react";
import type { Go } from "../App";
import { useCatalog } from "../lib/catalog";
import { usePlayer } from "../lib/player";
import type { CrateItem, Format } from "../lib/types";

/** Records you own or saved. Fills in once listener accounts and record scanning exist. */
const crate: CrateItem[] = [];
import { Button, ReleaseCard } from "../components/ui";

const FILTERS: { label: string; format?: Format }[] = [
  { label: "All" },
  { label: "Vinyl", format: "LP" },
  { label: "Cassette", format: "Cassette" },
  { label: "CD", format: "CD" },
  { label: "Digital only", format: "Digital" },
];

/** Your Crate: everything you own or saved, physical and digital, with weighted shuffle. */
export function Crate({ go }: { go: Go }) {
  const p = usePlayer();
  const { artistById, releaseById, trackById } = useCatalog();
  const [filter, setFilter] = useState("All");
  const active = FILTERS.find((f) => f.label === filter);
  const shown = crate.filter((c) => !active?.format || c.format === active.format);
  const onShelf = crate.filter((c) => c.format !== "Digital").length;

  const allTracks = [
    ...crate.flatMap((c) => releaseById[c.releaseId]?.trackIds.map((id) => trackById[id]) ?? []).filter(Boolean),
    ...p.localTracks,
  ];

  return (
    <div className="screen">
      <header className="screen-head">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="catalog eyebrow">{crate.length} records · {onShelf} on your shelf</span>
          <h1 className="display-lg">Your Crate</h1>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <Button icon="play" onClick={() => p.shuffleAll(allTracks)}>Shuffle crate</Button>
          {/* Barcode scanning is a planned feature: see docs/architecture.md → Physical media. */}
          <Button variant="primary" title="Coming soon">Scan a record</Button>
        </div>
      </header>

      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
        <div role="group" aria-label="Filter by format" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {FILTERS.map((f) => (
            <button key={f.label} type="button" className="chip" aria-pressed={filter === f.label} onClick={() => setFilter(f.label)}>
              {f.label}
            </button>
          ))}
        </div>
        <button type="button" className="switch" role="switch" aria-checked={p.weighted} onClick={() => p.setWeighted(!p.weighted)}>
          <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <span style={{ fontWeight: 600 }}>Shuffle by my ratings</span>
            <span className="caption muted">Five-star tracks come up most</span>
          </span>
          <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
        </button>
      </div>

      {crate.length === 0 && (
        <div className="empty">
          <span>Your crate is empty. Records you buy or scan will land here. Until then, “Shuffle crate” plays the files you added on Home.</span>
          <Button size="sm" onClick={() => go({ name: "home" })}>Go to Home</Button>
        </div>
      )}
      <div className="release-grid">
        {shown.map((c) => {
          const r = releaseById[c.releaseId];
          if (!r) return null;
          return (
            <ReleaseCard
              key={c.releaseId + c.format}
              title={r.title}
              artist={artistById[r.artistId]?.name ?? ""}
              year={r.year}
              sticker={c.format}
              stickerTone={c.format === "Digital" ? "neutral" : "sticker"}
              art={r.art}
              onOpen={() => go({ name: "artist", artistId: r.artistId })}
            />
          );
        })}
      </div>
    </div>
  );
}

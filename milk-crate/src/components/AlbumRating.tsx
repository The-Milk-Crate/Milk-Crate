import { useState } from "react";
import { useCatalog } from "../lib/catalog";
import { attempt, useLibrary } from "../lib/library";
import { AverageRating, StarRating } from "./ui";

/**
 * Albums are rated out of five stars: everyone's average, and your own rating
 * (click a star; click it again to clear). Songs aren't rated: they're favorited.
 */
export function AlbumRating({ releaseId, showAverage = true }: { releaseId: string; showAverage?: boolean }) {
  const c = useCatalog();
  const lib = useLibrary();
  const [error, setError] = useState("");
  const avg = c.albumAverages[releaseId];
  const n = c.albumRatingCounts[releaseId] ?? 0;
  return (
    <div className="album-rating">
      {showAverage && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <AverageRating value={avg} size={16} />
          {n > 0 && <span className="caption muted">{n} {n === 1 ? "rating" : "ratings"}</span>}
        </span>
      )}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span className="caption muted">Your rating</span>
        <StarRating value={lib.albumRatings[releaseId] ?? 0} size={18}
          onChange={(v) => { setError(""); void attempt(() => lib.rateAlbum(releaseId, v), setError); }} />
      </span>
      {error && <span role="alert" className="form-error caption">{error}</span>}
    </div>
  );
}

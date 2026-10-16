import { useCallback, useEffect, useState } from "react";
import type { Go } from "../App";
import { useAuth } from "../lib/auth";
import { useCatalog, type PendingArtist } from "../lib/catalog";
import { ArtistBanner } from "../components/ArtistBanner";
import { Button, Sticker } from "../components/ui";

/** Reviewers: approve or decline artists who applied to join. */
export function Review({ go }: { go: Go }) {
  const auth = useAuth();
  const c = useCatalog();
  const [queue, setQueue] = useState<PendingArtist[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    c.loadReviewQueue().then(setQueue).catch((e) => setError(String(e.message ?? e)));
  }, [c.loadReviewQueue]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (auth.isAdmin) load();
  }, [auth.isAdmin, load]);

  if (!auth.isAdmin)
    return <div className="screen"><p className="muted">Only Milk Crate reviewers can see this page.</p></div>;

  const pending = queue?.filter((q) => q.artist.status === "pending") ?? [];
  const declined = queue?.filter((q) => q.artist.status === "declined") ?? [];

  return (
    <div className="screen" style={{ maxWidth: 1000 }}>
      <header style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className="catalog eyebrow">Reviewer</span>
        <h1 className="display-lg">Review artists</h1>
        <p className="muted" style={{ maxWidth: 620 }}>
          New artists stay hidden, and can't upload music, until you approve them. Approved artists show up for every listener right away.
        </p>
      </header>
      {error && <p role="alert" className="form-error">{error}</p>}
      {!queue && !error && <p className="muted">Loading applications…</p>}
      {queue && pending.length === 0 && <div className="empty"><span>No applications waiting. New ones show up here.</span></div>}
      {pending.map((q) => <ApplicationCard key={q.artist.id} item={q} onDone={load} go={go} />)}
      {declined.length > 0 && (
        <section className="section">
          <h2 className="display-md">Declined</h2>
          <p className="caption muted">You can still approve these later.</p>
          {declined.map((q) => <ApplicationCard key={q.artist.id} item={q} onDone={load} go={go} />)}
        </section>
      )}
    </div>
  );
}

function ApplicationCard({ item: { artist: a, application: app }, onDone }: { item: PendingArtist; onDone: () => void; go: Go }) {
  const c = useCatalog();
  const [note, setNote] = useState(app?.reviewNote ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const decide = async (decision: "approved" | "declined") => {
    setBusy(true);
    setError("");
    try {
      await c.reviewArtist(a.id, decision, note.trim());
      onDone();
    } catch (e) {
      setError(String((e as Error).message));
      setBusy(false);
    }
  };

  return (
    <article className="panel review-card">
      <div className="review-banner"><ArtistBanner artist={a} fill headingLevel={2} /></div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0, flex: "1 1 320px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h2 className="display-md" style={{ margin: 0 }}>{a.name}</h2>
          <Sticker tone={a.status === "declined" ? "crate" : "dairy"}>{a.status === "declined" ? "Declined" : "Waiting"}</Sticker>
        </div>
        <p className="caption muted">{[a.place, a.genres.join(", ")].filter(Boolean).join(" · ")}</p>
        {a.bio && <p>{a.bio}</p>}
        <dl className="review-facts">
          <dt>Where to hear them</dt>
          <dd className="selectable">{app?.links || <span className="muted">No links given</span>}</dd>
          {app?.note && (<><dt>Their note</dt><dd className="selectable">{app.note}</dd></>)}
          {app?.contactEmail && (<><dt>Contact</dt><dd className="selectable">{app.contactEmail}</dd></>)}
          {app?.submittedAt && (<><dt>Applied</dt><dd>{new Date(app.submittedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</dd></>)}
        </dl>
        {!app && <p className="caption muted">They haven't sent their application yet.</p>}
        <label className="field">
          <span className="catalog eyebrow">Note to the artist (optional)</span>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Shown to them with your decision." />
        </label>
        {error && <p role="alert" className="form-error">{error}</p>}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <Button variant="primary" onClick={() => decide("approved")} disabled={busy}>Approve</Button>
          {a.status !== "declined" && <Button variant="ghost" onClick={() => decide("declined")} disabled={busy}>Decline</Button>}
        </div>
      </div>
    </article>
  );
}

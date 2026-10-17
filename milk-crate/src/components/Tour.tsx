import { Check, X } from "lucide-react";
import type { Go } from "../App";
import { useLocation } from "../lib/location";
import { useLibrary } from "../lib/library";
import { usePersistentState } from "../lib/storage";
import { Button } from "./ui";

const FAVORITE_GOAL = 3;

/**
 * First run: three things that make Milk Crate yours. Each ticks itself off as
 * you do it; the card goes away once all three are done or you close it.
 */
export function Tour({ go }: { go: Go }) {
  const loc = useLocation();
  const lib = useLibrary();
  const [done, setDone] = usePersistentState("mc.tourDone", false);
  const hearted = lib.favorites.length;
  const steps = [
    { id: "city", title: "Set your town", body: "Your scene is built around it: the bands near you come first.", ok: !!loc.home, action: () => go({ name: "account" }), label: "Choose your town" },
    { id: "rate", title: `Favorite ${FAVORITE_GOAL} songs`, body: "Tap the heart on a song: it goes in Favorites in Your Crate, and comes up more when you shuffle.", ok: hearted >= FAVORITE_GOAL, action: () => go({ name: "scenes" }), label: hearted ? `${hearted} of ${FAVORITE_GOAL} favorited` : "Find a song you love" },
    { id: "follow", title: "Follow a local band", body: "Their new releases show up in New for you, first.", ok: lib.following.length > 0, action: () => go({ name: "scenes" }), label: "Flip through your scene" },
  ];
  if (done || steps.every((s) => s.ok)) return null;
  const count = steps.filter((s) => s.ok).length;

  return (
    <section className="panel tour" aria-labelledby="tour-title">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className="catalog eyebrow">Getting started · {count} of {steps.length}</span>
          <h2 id="tour-title" className="display-md">Make Milk Crate yours</h2>
        </div>
        <button type="button" className="mc-icon-btn" aria-label="Hide getting started" onClick={() => setDone(true)}><X size={18} strokeWidth={1.75} aria-hidden="true" /></button>
      </div>
      <ol className="tour-steps">
        {steps.map((s) => (
          <li key={s.id} className={`tour-step${s.ok ? " ok" : ""}`}>
            <span className="tour-check" aria-hidden="true">{s.ok && <Check size={14} strokeWidth={2.5} />}</span>
            <span style={{ display: "flex", flexDirection: "column", gap: 2, flex: "1 1 auto", minWidth: 0 }}>
              <span style={{ fontWeight: 650 }}>{s.title}{s.ok && <span className="visually-hidden"> (done)</span>}</span>
              <span className="caption muted">{s.body}</span>
            </span>
            {!s.ok && (s.id !== "follow" || lib.signedIn) && (s.id !== "rate" || lib.signedIn) && <Button size="sm" onClick={s.action}>{s.label}</Button>}
            {!s.ok && !lib.signedIn && s.id !== "city" && <Button size="sm" onClick={() => go({ name: "account" })}>Sign in first</Button>}
          </li>
        ))}
      </ol>
    </section>
  );
}

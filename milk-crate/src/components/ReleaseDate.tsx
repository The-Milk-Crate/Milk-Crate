import { useId } from "react";

/** "Friday, Oct 24" (adds the year when it isn't this year). */
export function formatReleaseDate(iso: string, now = Date.now()) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}
/** "Oct 24". */
export const shortReleaseDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** "in 3 days", "tomorrow", "today". */
export function untilLabel(iso: string, now = Date.now()) {
  const start = (t: number) => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const days = Math.round((start(Date.parse(iso)) - start(now)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** ISO → "2026-10-24" in the computer's own time zone, for a date input. */
const toInput = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/** "2026-10-24" → the start of that day, here, as ISO. */
const fromInput = (v: string) => { const [y, m, d] = v.split("-").map(Number); return new Date(y, m - 1, d, 0, 0, 0).toISOString(); };
/** The next Friday (new music day), or a week from Friday if it's Friday already. */
function nextFriday(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + (((5 - d.getDay() + 7) % 7) || 7));
  return d.toISOString();
}

/**
 * Out now, or out on a date: before then, listeners see the release as coming
 * (title, cover and date) but can't play it, and it shows up for followers.
 * `value` is null for out now, or the ISO start of the release day.
 */
export function ReleaseDateField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const id = useId();
  const tomorrow = toInput(new Date(Date.now() + 86_400_000).toISOString());
  const latest = toInput(new Date(Date.now() + 700 * 86_400_000).toISOString());
  return (
    <fieldset className="release-date">
      <legend className="catalog eyebrow">Release date</legend>
      <div role="radiogroup" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" role="radio" className="chip" aria-checked={!value} aria-pressed={!value} onClick={() => onChange(null)}>Out now</button>
        <button type="button" role="radio" className="chip" aria-checked={!!value} aria-pressed={!!value} onClick={() => onChange(value ?? nextFriday())}>Pick a date</button>
      </div>
      {value && (
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <label htmlFor={id} className="visually-hidden">Release date</label>
          <input id={id} type="date" value={toInput(value)} min={tomorrow} max={latest} onChange={(e) => e.target.value && onChange(fromInput(e.target.value))} />
          <span className="caption muted">Out {formatReleaseDate(value)} at midnight. Until then listeners see it as coming soon and can't play it yet.</span>
        </div>
      )}
    </fieldset>
  );
}

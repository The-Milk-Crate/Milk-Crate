import { useEffect, useId, useMemo, useState } from "react";
import { STATE_NAMES, placeLabel, searchPlaces, usePlaces, type Place } from "../lib/geo";

/** Type-ahead picker for a real US city or town. */
export function CityPicker({ label, value, onChange, autoFocus }: { label: string; value: Place | null; onChange: (p: Place) => void; autoFocus?: boolean }) {
  const places = usePlaces();
  const id = useId();
  const [text, setText] = useState(value ? placeLabel(value) : "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const valueLabel = value ? placeLabel(value) : "";

  useEffect(() => setText(valueLabel), [valueLabel]);

  const results = useMemo(() => (places && open && text !== valueLabel ? searchPlaces(places, text) : []), [places, open, text, valueLabel]);

  const choose = (p: Place) => {
    onChange(p);
    setText(placeLabel(p));
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!results.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % results.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + results.length) % results.length); }
    else if (e.key === "Enter") { e.preventDefault(); choose(results[active]); }
    else if (e.key === "Escape") setOpen(false);
  };

  return (
    <div className="field city-picker">
      <label htmlFor={`${id}-input`} className="catalog eyebrow">{label}</label>
      <input
        id={`${id}-input`}
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls={`${id}-list`}
        aria-activedescendant={results.length ? `${id}-opt-${active}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={places ? "Start typing your city or town" : "Loading cities…"}
        value={text}
        onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKey}
      />
      {results.length > 0 && (
        <ul id={`${id}-list`} role="listbox" className="city-options">
          {results.map((p, i) => (
            <li key={placeLabel(p)} id={`${id}-opt-${i}`} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); choose(p); }} onMouseEnter={() => setActive(i)}>
              <span style={{ fontWeight: 600 }}>{p.name}</span>
              <span className="muted">, {STATE_NAMES[p.state] ?? p.state}</span>
            </li>
          ))}
        </ul>
      )}
      {open && places && text.trim().length > 1 && text !== valueLabel && results.length === 0 && (
        <span className="caption muted">No US city or town by that name. Try the nearest town with 1,000+ people.</span>
      )}
    </div>
  );
}

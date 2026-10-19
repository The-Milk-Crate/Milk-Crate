import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption<T extends string | number> { value: T; label: string }

/**
 * A dropdown that matches the rest of the app (the system's own dropdown can't be styled):
 * a button showing the choice, and a glass menu of options. Mouse or keyboard: arrows, Home/End,
 * Enter or Space to pick, Esc to close, or type the first letters of an option.
 */
export function Select<T extends string | number>({ value, options, onChange, disabled, labelledBy, label, className = "" }: {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
  /** Id of the visible label, or `label` for an unlabeled one. */
  labelledBy?: string;
  label?: string;
  className?: string;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const current = Math.max(0, options.findIndex((o) => o.value === value));
  const [active, setActive] = useState(current);
  const typed = useRef({ text: "", at: 0 });

  useEffect(() => {
    if (!open) return;
    setActive(current);
    list.current?.focus({ preventScroll: true });
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Keep the highlighted option in view.
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const pick = (i: number) => {
    const o = options[i];
    setOpen(false);
    button.current?.focus({ preventScroll: true });
    if (o && o.value !== value) onChange(o.value);
  };
  const findTyped = (key: string) => {
    const now = Date.now();
    typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : "") + key.toLowerCase(), at: now };
    const t = typed.current.text;
    const start = open ? active : current;
    // A new first letter moves on to the next match; more letters refine the one you're on.
    for (let k = 0; k < options.length; k++) {
      const i = (start + (t.length > 1 ? 0 : 1) + k) % options.length;
      if (options[i].label.toLowerCase().startsWith(t)) return i;
    }
    return -1;
  };
  const onButtonKey = (e: KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); setOpen(true); }
    else if (e.key.length === 1 && /\S/.test(e.key)) { const i = findTyped(e.key); if (i >= 0 && options[i].value !== value) onChange(options[i].value); }
  };
  const onListKey = (e: KeyboardEvent) => {
    const last = options.length - 1;
    const to = ({ ArrowDown: Math.min(last, active + 1), ArrowUp: Math.max(0, active - 1), Home: 0, End: last, PageDown: Math.min(last, active + 5), PageUp: Math.max(0, active - 5) } as Record<string, number>)[e.key];
    if (to !== undefined) { e.preventDefault(); setActive(to); return; }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(active); return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); button.current?.focus({ preventScroll: true }); return; }
    if (e.key === "Tab") { setOpen(false); return; }
    if (e.key.length === 1 && /\S/.test(e.key)) { const i = findTyped(e.key); if (i >= 0) setActive(i); }
  };

  return (
    <div ref={box} className={`mc-select${open ? " is-open" : ""} ${className}`}>
      <button ref={button} type="button" className="mc-select-btn" disabled={disabled} aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined} aria-labelledby={labelledBy ? `${labelledBy} ${id}-value` : undefined} aria-label={labelledBy ? undefined : label}
        onClick={() => setOpen((o) => !o)} onKeyDown={onButtonKey}>
        <span id={`${id}-value`} className="mc-select-value">{options[current]?.label ?? ""}</span>
        <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <ul ref={list} id={`${id}-list`} role="listbox" tabIndex={-1} className="mc-select-menu" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : label}
          aria-activedescendant={`${id}-o${active}`} onKeyDown={onListKey}>
          {options.map((o, i) => (
            <li key={String(o.value)} id={`${id}-o${i}`} data-i={i} role="option" aria-selected={o.value === value}
              className={i === active ? "is-active" : undefined} onPointerMove={() => setActive(i)} onClick={() => pick(i)}>
              <span>{o.label}</span>
              {o.value === value && <Check size={14} strokeWidth={2} aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

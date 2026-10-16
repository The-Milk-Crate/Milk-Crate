import { useEffect, useRef } from "react";
import { useSettings } from "../lib/settings";
import { attachFrost } from "../lib/frost";

/**
 * The frosted grain for one glass surface (see src/lib/frost.ts). Put it first
 * inside a glass surface that is a stacking context: it sits on the glass,
 * above the surface's tint and under its content. Off unless Settings →
 * Appearance → Frosted texture is on.
 */
export function FrostGrain({ source = "main", saturate = 1 }: { source?: "main" | "immersive"; saturate?: number }) {
  const { glass, frostTexture } = useSettings();
  const ref = useRef<HTMLCanvasElement>(null);
  const on = frostTexture && (glass || source === "immersive");
  useEffect(() => {
    if (!on || !ref.current) return;
    return attachFrost(ref.current, { source, saturate });
  }, [on, source, saturate]);
  return on ? <canvas ref={ref} className="frost-grain" aria-hidden="true" /> : null;
}

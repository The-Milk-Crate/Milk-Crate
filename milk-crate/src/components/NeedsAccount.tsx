import { X } from "lucide-react";
import type { Go } from "../App";
import { useLibrary } from "../lib/library";
import { Button } from "./ui";

/** Shown when someone browsing without an account tries to save, rate or follow. */
export function NeedsAccount({ go }: { go: Go }) {
  const lib = useLibrary();
  if (!lib.needsAccount) return null;
  return (
    <div className="update-card" role="dialog" aria-label="Account needed">
      <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
        <span style={{ fontWeight: 600 }}>Sign in to {lib.needsAccount}</span>
        <span className="caption muted">A free listener account keeps your crate, ratings and follows on any computer.</span>
      </div>
      <Button size="sm" variant="primary" onClick={() => { lib.dismissNeedsAccount(); go({ name: "account" }); }}>Sign in</Button>
      <button type="button" className="mc-icon-btn" aria-label="Not now" onClick={lib.dismissNeedsAccount}><X size={18} strokeWidth={1.75} aria-hidden="true" /></button>
    </div>
  );
}

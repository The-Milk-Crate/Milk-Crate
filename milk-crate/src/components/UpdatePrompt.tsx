import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { findUpdate, installUpdate, type Update } from "../lib/updater";
import { Button } from "./ui";

/** Shows a small card when a newer Milk Crate is available. */
export function UpdatePrompt() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [hidden, setHidden] = useState(false);
  const [state, setState] = useState<"idle" | "installing" | "error">("idle");
  const [pct, setPct] = useState<number | null>(null);

  useEffect(() => {
    findUpdate().then(setUpdate);
  }, []);

  if (!update || hidden) return null;

  const install = async () => {
    setState("installing");
    try {
      await installUpdate(update, setPct);
    } catch {
      setState("error");
    }
  };

  return (
    <div className="update-card" role="status">
      <Download size={20} strokeWidth={1.75} aria-hidden="true" style={{ color: "var(--accent)", flex: "none" }} />
      <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
        <span style={{ fontWeight: 600 }}>
          {state === "installing" ? `Updating${pct !== null ? ` · ${pct}%` : "…"}` : `Milk Crate ${update.version} is ready`}
        </span>
        <span className="caption muted">
          {state === "error" ? "The update didn't install. Try again later." : state === "installing" ? "The app will restart when it's done." : "Restart to get the latest version."}
        </span>
      </div>
      {state !== "installing" && (
        <>
          <Button size="sm" variant="primary" onClick={install}>{state === "error" ? "Retry" : "Update"}</Button>
          <button type="button" className="mc-icon-btn" aria-label="Not now" onClick={() => setHidden(true)}>
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}

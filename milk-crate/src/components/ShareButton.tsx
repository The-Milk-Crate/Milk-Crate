import { useState } from "react";
import { Link2 } from "lucide-react";
import { copyText, linkFor } from "../lib/share";

/** Copies a link that opens this album, artist or scene in Milk Crate. */
export function ShareButton({ target, label }: { target: Parameters<typeof linkFor>[0]; label: string }) {
  const [done, setDone] = useState("");
  const share = async () => {
    const link = linkFor(target);
    const ok = await copyText(`${label} on Milk Crate: ${link}`);
    setDone(ok ? "Link copied" : "Couldn't copy the link");
    setTimeout(() => setDone(""), 2200);
  };
  return (
    <span className="share">
      <button type="button" className="mc-btn" onClick={share} title="Copy a link that opens this in Milk Crate">
        <Link2 size={16} strokeWidth={1.75} aria-hidden="true" /> Share
      </button>
      {done && <span className="caption muted" role="status">{done}</span>}
    </span>
  );
}

import { useEffect, useRef } from "react";
import { Button } from "./ui";

/** Asked before leaving a page that's in the middle of something that can't be left halfway (a CD rip). */
export function HoldOn({ onBack, onProceed }: { onBack: () => void; onProceed: () => void }) {
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    back.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onBack(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onBack]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onBack()}>
      <div className="modal panel hold-on" role="alertdialog" aria-modal="true" aria-labelledby="hold-on-title" aria-describedby="hold-on-body">
        <h2 id="hold-on-title" className="display-md">Hold On.</h2>
        <p id="hold-on-body">
          Your CD is still ripping. Going to another page in Milk Crate will cancel the rip, and the songs it has saved
          so far will be deleted from your computer.
        </p>
        <div className="hold-on-actions">
          <Button ref={back} variant="primary" onClick={onBack}>Take Me Back</Button>
          <Button variant="ghost" onClick={onProceed}>Proceed</Button>
        </div>
      </div>
    </div>
  );
}

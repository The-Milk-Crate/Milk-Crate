import { Component, type ErrorInfo, type ReactNode } from "react";
import type { Go } from "../App";
import { sendErrorReport } from "../lib/errors";
import { Button } from "./ui";

/** If a screen crashes, say so (and report it) instead of leaving a blank window. The rest of the app keeps working. */
export class ErrorBoundary extends Component<{ go: Go; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const where = info.componentStack?.split("\n").find((l) => l.trim())?.trim() ?? "";
    void sendErrorReport(Object.assign(error, { stack: `${error.stack ?? ""}\n--- component ---\n${info.componentStack ?? ""}` }), { screen: where });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="screen" style={{ maxWidth: 640 }}>
        <span className="catalog eyebrow">Something broke</span>
        <h1 className="display-lg">This page hit a snag</h1>
        <p className="muted">It's been reported so it can be fixed. Your music keeps playing. Try again, or head home.</p>
        <div style={{ display: "flex", gap: 12 }}>
          <Button variant="primary" onClick={() => this.setState({ failed: false })}>Try again</Button>
          <Button onClick={() => this.props.go({ name: "home" })}>Go home</Button>
        </div>
      </div>
    );
  }
}

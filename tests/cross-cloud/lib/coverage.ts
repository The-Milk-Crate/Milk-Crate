// The table-driven check from the contract: every operation's `x-account-types` and
// `x-state-moves`, and every row of the state table at the top of the contract, must be
// exercised by a run. A new operation, account type or move with no step is a visible gap.
import type { Recorder } from "./observe.ts";
import { loadContract } from "./contract.ts";

const MOVE = /(\(new\)|any state except taken_down|[a-z_]+) → ([a-z_]+)(?: or ([a-z_]+))?/;

export interface Need {
  what: string;
  met: boolean;
}

/** One state move as the contract writes it: from (or "any"), and the states it may go to. */
function parseMove(text: string): { from: string; to: string[] } | null {
  const plain = text.replace(/`/g, "");
  const m = MOVE.exec(plain);
  if (!m) return null;
  const from = m[1] === "any state except taken_down" || m[1] === "any" ? "any" : m[1];
  return { from, to: [m[2], ...(m[3] ? [m[3]] : [])] };
}

/** The rows of the "Release states" table in the contract's description. */
export function stateTable(): { move: string; from: string; to: string; cause: string }[] {
  const { doc } = loadContract();
  const rows: { move: string; from: string; to: string; cause: string }[] = [];
  for (const line of String(doc.info.description).split("\n")) {
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length !== 2 || !cells[0].includes("→")) continue;
    const plain = cells[0].replace(/`/g, "").replace(/^any but taken_down/, "any state except taken_down");
    const parsed = parseMove(plain);
    if (!parsed) throw new Error(`cannot read the state table row: ${line}`);
    for (const to of parsed.to) rows.push({ move: `${parsed.from} → ${to}`, from: parsed.from, to, cause: cells[1] });
  }
  return rows;
}

/** Every need from the contract, and whether this run met it. */
export function coverage(run: Recorder, side: "supabase" | "aws"): Need[] {
  const contract = loadContract();
  const needs: Need[] = [];
  const obs = run.observations;
  const ok = (s: number) => s >= 200 && s < 300;
  for (const op of Object.values(contract.operations)) {
    for (const type of contract.accountTypes) {
      if (op.accountTypes.includes(type)) {
        // signUploadParts is for s3_multipart only: on a tus deployment it answers 409 (the contract says so).
        const met = obs.some((o) => o.operationId === op.operationId && o.callerType === type &&
          (ok(o.status) || (op.operationId === "signUploadParts" && side === "supabase" && o.status === 409 && o.code === "wrong_method")));
        needs.push({ what: `${op.operationId}: ${type} may call it (an answer in 2xx)`, met });
      } else {
        const met = obs.some((o) => o.operationId === op.operationId && o.callerType === type && o.status === 403);
        needs.push({ what: `${op.operationId}: ${type} may not call it (403)`, met });
      }
    }
    needs.push({ what: `${op.operationId}: no token (401)`, met: obs.some((o) => o.operationId === op.operationId && o.callerType === "none" && o.status === 401) });

    const moves = run.moves.filter((m) => m.cause === op.operationId);
    if (op.stateMoves.length === 0) {
      const changed = moves.filter((m) => m.from !== m.to && m.from !== "(new)");
      needs.push({ what: `${op.operationId}: moves no state`, met: changed.length === 0 });
      needs.push({ what: `${op.operationId}: was called on a release at least once`, met: moves.length > 0 || !op.path.includes("{releaseId}") });
    }
    for (const text of op.stateMoves) {
      if (/no state change/.test(text)) {
        needs.push({ what: `${op.operationId}: ${text}`, met: moves.some((m) => m.from === m.to) });
        continue;
      }
      const parsed = parseMove(text);
      if (!parsed) {
        needs.push({ what: `${op.operationId}: cannot read the move "${text}"`, met: false });
        continue;
      }
      for (const to of parsed.to) {
        needs.push({
          what: `${op.operationId}: ${parsed.from} → ${to}`,
          met: moves.some((m) => (parsed.from === "any" ? m.from !== "taken_down" : m.from === parsed.from) && m.to === to),
        });
      }
    }
  }
  for (const row of stateTable()) {
    needs.push({
      what: `state table: ${row.move} (${row.cause})`,
      met: run.moves.some((m) => (row.from === "any" ? m.from !== "taken_down" : m.from === row.from) && m.to === row.to && m.from !== m.to),
    });
  }
  return needs;
}

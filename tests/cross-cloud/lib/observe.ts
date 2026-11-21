// What a run records, and how two runs are compared.
//
// "Behave the same" (the brief): for every step, the HTTP status, the error `code`, the release
// `state` after the step, and the response's field names and types. Values are ignored (ids,
// timestamps, URLs, signatures, cookies, codes). The only allowed differences are the
// contract's tagged unions (UploadSession, PlaybackGrant, CoverGrant): each side must answer a
// valid branch, and the fields both branches share must match.
import type { AccountType } from "../../../core/src/platform/index.ts";
import { checkResponse, loadContract } from "./contract.ts";
import type { Api, CallInput, Reply } from "./client.ts";

export type Shape = string | Shape[] | { [key: string]: Shape };

/** Field names and types, never values. Arrays merge their items; a field missing from some items is marked "?". */
export function shape(value: unknown): Shape {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? [] : [mergeShapes(value.map(shape))];
  if (typeof value === "object") {
    const out: Record<string, Shape> = {};
    for (const k of Object.keys(value as object).sort()) out[k] = shape((value as Record<string, unknown>)[k]);
    return out;
  }
  return typeof value;
}

function mergeShapes(shapes: Shape[]): Shape {
  if (shapes.every((s) => typeof s === "object" && s !== null && !Array.isArray(s))) {
    const objects = shapes as Record<string, Shape>[];
    const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))].sort();
    const out: Record<string, Shape> = {};
    for (const k of keys) {
      const having = objects.filter((o) => k in o);
      out[having.length === objects.length ? k : `${k}?`] = mergeShapes(having.map((o) => o[k]));
    }
    return out;
  }
  const seen = [...new Set(shapes.map((s) => JSON.stringify(s)))];
  return seen.length === 1 ? shapes[0] : `one of ${seen.sort().join(" | ")}`;
}

/** The tagged unions in the contract: for each, the branch each side should answer. */
export const UNIONS: Record<string, { schema: string; supabase: string; aws: string }> = {
  startUpload: { schema: "UploadSession", supabase: "tus", aws: "s3_multipart" },
  startCoverUpload: { schema: "UploadSession", supabase: "tus", aws: "s3_multipart" },
  getUpload: { schema: "UploadSession", supabase: "tus", aws: "s3_multipart" },
  getPlayback: { schema: "PlaybackGrant", supabase: "signed_url", aws: "cloudfront_cookies" },
  getCover: { schema: "CoverGrant", supabase: "signed_url", aws: "cloudfront_cookies" },
};

/** The fields every branch of a union schema has (without the tag), from the contract. */
export function sharedFields(schemaName: string): string[] {
  const { doc } = loadContract();
  const union = doc.components.schemas[schemaName];
  const branches = (union.oneOf as { $ref: string }[]).map((b) => doc.components.schemas[b.$ref.split("/").pop()!]);
  const sets = branches.map((b) => new Set(Object.keys(b.properties ?? {})));
  return [...sets[0]].filter((k) => k !== union.discriminator.propertyName && sets.every((s) => s.has(k))).sort();
}

export interface Actor {
  /** Who this is in the scenario, such as "artist A" or "listener". */
  label: string;
  /** The type the token says. */
  type: AccountType;
  token: string;
  userId?: string;
  email?: string;
  /** The type the handlers should act on, if not `type` (a suspended or removed account). */
  actsAs?: AccountType;
}

export interface Observation {
  step: string;
  operationId: string;
  caller: string;
  /** The type the call was made as (for the coverage check). */
  callerType: AccountType | "none";
  expected: number;
  status: number;
  code?: string;
  /** The release state after the step, when the step is about one release. */
  state?: string;
  /** For a union answer: the branch (method). */
  branch?: string;
  shape: Shape;
  /** Problems with the body against the contract's response schema. */
  contract: string[];
  /**
   * The answer depends on the upload branch, as the contract says (signUploadParts is for
   * s3_multipart; a tus session gets 409). Compared by expectation only, not across sides.
   */
  branchDependent?: boolean;
}

export interface Fact {
  step: string;
  name: string;
  value: unknown;
}

export interface Move {
  /** An operationId, or "worker success", "worker error", "schedule fires". */
  cause: string;
  from: string;
  to: string;
}

/** One side's run: its calls, facts and state moves. */
export class Recorder {
  readonly observations: Observation[] = [];
  readonly facts: Fact[] = [];
  readonly moves: Move[] = [];
  /** Steps that did not run here, and why (only on a real deployment). */
  readonly skipped: { step: string; why: string }[] = [];
  private stepNames = new Set<string>();

  readonly side: string;
  readonly api: Api;
  readonly stateOf: (releaseId: string) => Promise<string | undefined>;

  constructor(side: string, api: Api, stateOf: (releaseId: string) => Promise<string | undefined>) {
    this.side = side;
    this.api = api;
    this.stateOf = stateOf;
  }

  /**
   * One call. `release` names the release whose state is read before and after (for the state
   * moves and the comparison).
   */
  async call(
    step: string,
    operationId: string,
    who: Actor | null,
    input: Omit<CallInput, "token">,
    expected: number,
    opts: { release?: string; branchDependent?: boolean } = {},
  ): Promise<Reply> {
    if (this.stepNames.has(step)) throw new Error(`two steps named "${step}"`);
    this.stepNames.add(step);
    const before = opts.release ? await this.stateOf(opts.release) : undefined;
    const reply = await this.api.call(operationId, { ...input, token: who?.token ?? null });
    const state = opts.release ? await this.stateOf(opts.release) : undefined;
    const ok = reply.status >= 200 && reply.status < 300;
    const union = UNIONS[operationId];
    let branch: string | undefined;
    let bodyShape: Shape = shape(reply.body);
    if (ok && union && reply.body && typeof reply.body === "object") {
      branch = String(reply.body.method);
      const shared = sharedFields(union.schema);
      bodyShape = shape(Object.fromEntries(Object.entries(reply.body).filter(([k]) => shared.includes(k))));
    }
    this.observations.push({
      step,
      operationId,
      caller: who?.label ?? "no token",
      callerType: who ? (who.actsAs ?? who.type) : "none",
      expected,
      status: reply.status,
      ...(!ok && reply.body && typeof reply.body.code === "string" ? { code: reply.body.code } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(branch ? { branch } : {}),
      shape: bodyShape,
      contract: checkResponse(operationId, reply.status, reply.status === 204 ? null : reply.body),
      ...(opts.branchDependent ? { branchDependent: true } : {}),
    });
    if (ok) {
      if (operationId === "createRelease" && reply.body?.state) this.moves.push({ cause: operationId, from: "(new)", to: reply.body.state });
      else if (before !== undefined && state !== undefined) this.moves.push({ cause: operationId, from: before, to: state });
    }
    return reply;
  }

  fact(step: string, name: string, value: unknown): void {
    this.facts.push({ step, name, value });
  }

  move(cause: string, from: string | undefined, to: string | undefined): void {
    if (from !== undefined && to !== undefined) this.moves.push({ cause, from, to });
  }

  skip(step: string, why: string): void {
    this.skipped.push({ step, why });
  }
}

/** Steps whose status is not what the scenario expects. */
export function unexpected(run: RunRecord): string[] {
  return run.observations
    .filter((o) => o.status !== o.expected)
    .map((o) => `${o.step}: ${o.operationId} as ${o.caller} answered ${o.status}${o.code ? ` (${o.code})` : ""}, expected ${o.expected}`);
}

/** Answers whose body does not fit the contract, or that answered the wrong union branch. */
export function contractProblems(run: RunRecord, side: "supabase" | "aws" | null): string[] {
  const out: string[] = [];
  for (const o of run.observations) {
    for (const p of o.contract) out.push(`${o.step}: ${o.operationId} ${o.status}: ${p}`);
    const union = UNIONS[o.operationId];
    if (side && union && o.branch && o.branch !== union[side]) {
      out.push(`${o.step}: ${o.operationId} answered the ${o.branch} branch; ${side} should answer ${union[side]}`);
    }
  }
  return out;
}

/** What a run's report keeps (a Recorder, or one read back from run-live.ts's JSON report). */
export interface RunRecord {
  side: string;
  observations: Observation[];
  facts: Fact[];
}

/** Every difference between two runs, step by step. Empty means they behave the same. */
export function differences(a: RunRecord, b: RunRecord): string[] {
  const out: string[] = [];
  const steps = Math.max(a.observations.length, b.observations.length);
  for (let i = 0; i < steps; i++) {
    const x = a.observations[i];
    const y = b.observations[i];
    if (!x || !y || x.step !== y.step) {
      out.push(`step ${i + 1}: ${a.side} ran "${x?.step ?? "nothing"}", ${b.side} ran "${y?.step ?? "nothing"}"`);
      break;
    }
    if (x.branchDependent || y.branchDependent) {
      if (x.state !== y.state) out.push(`${x.step}: state is ${JSON.stringify(x.state)} on ${a.side}, ${JSON.stringify(y.state)} on ${b.side}`);
      continue;
    }
    for (const field of ["status", "code", "state"] as const) {
      if (x[field] !== y[field]) out.push(`${x.step}: ${field} is ${JSON.stringify(x[field])} on ${a.side}, ${JSON.stringify(y[field])} on ${b.side}`);
    }
    const sx = JSON.stringify(x.shape);
    const sy = JSON.stringify(y.shape);
    if (sx !== sy) out.push(`${x.step}: the response fields differ:\n    ${a.side}: ${sx}\n    ${b.side}: ${sy}`);
  }
  const fx = new Map(a.facts.map((f) => [`${f.step} / ${f.name}`, JSON.stringify(f.value)]));
  const fy = new Map(b.facts.map((f) => [`${f.step} / ${f.name}`, JSON.stringify(f.value)]));
  for (const key of new Set([...fx.keys(), ...fy.keys()])) {
    if (fx.get(key) !== fy.get(key)) out.push(`${key}: ${fx.get(key) ?? "not recorded"} on ${a.side}, ${fy.get(key) ?? "not recorded"} on ${b.side}`);
  }
  return out;
}

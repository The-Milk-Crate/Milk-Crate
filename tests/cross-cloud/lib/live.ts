// The scenario against a real deployment: a base address and one token per account type, all
// from environment variables. Used by run-live.ts, and tested here against the mocks.
//
// Safe by design:
//   - it never prints a token (every line it writes is checked for them first);
//   - it refuses to start when a required variable is missing;
//   - it changes only what it creates: its own releases (taken down at the end, as the
//     scenario's last steps), their uploads, parties and plays. Refused calls use its own ids.
//   - masters are at most 50 MiB (the free Supabase project's limit, settled), made with ffmpeg.
import type { AccountType } from "../../../core/src/platform/index.ts";
import { Api } from "./client.ts";
import { contractProblems, differences, unexpected, type Actor, type RunRecord } from "./observe.ts";
import { runScenario, type Target } from "./scenario.ts";
import { CONTRACT_GAPS, KNOWN_DIFFERENCES } from "./findings.ts";

export const TOKEN_VARS: Record<AccountType, string> = {
  artist: "MC_LIVE_TOKEN_ARTIST",
  end_user: "MC_LIVE_TOKEN_END_USER",
  third_party: "MC_LIVE_TOKEN_THIRD_PARTY",
  administrator: "MC_LIVE_TOKEN_ADMINISTRATOR",
  internal: "MC_LIVE_TOKEN_INTERNAL",
  internal_accounting: "MC_LIVE_TOKEN_INTERNAL_ACCOUNTING",
};
export const REQUIRED_VARS = ["MC_LIVE_BASE_URL", ...Object.values(TOKEN_VARS)];
export const OPTIONAL_VARS = {
  MC_LIVE_TOKEN_ARTIST_2: "a second artist, for the steps where another artist must not see the release",
  MC_LIVE_DEPLOYMENT: "supabase or aws, to check the upload and read grants use that side's branch",
  MC_LIVE_INVITEE_EMAIL: "where invitations go, with {n} for the party number (default cross-cloud-invitee-{n}@example.com)",
  MC_LIVE_PROCESSING_TIMEOUT_SECONDS: "how long to wait for processing (default 900)",
  MC_LIVE_REPORT: "a file to write the run's report to (JSON, no tokens), for --compare",
  MC_LIVE_POLL_SECONDS: "how often to check on processing (default 5)",
};

/** Replaces every token from the settings with <token>, for anything written out. */
export function redactor(env: Record<string, string | undefined>): (text: string) => string {
  const secrets = Object.entries(env)
    .filter(([name, value]) => name.startsWith("MC_LIVE_TOKEN_") && value)
    .map(([, value]) => value!);
  return (text) => secrets.reduce((t, s) => t.split(s).join("<token>"), text);
}

export class LiveSetupError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

export interface LiveReport extends RunRecord {
  deployment: string | null;
  base: string;
  skipped: { step: string; why: string }[];
  unexpected: string[];
  contract: string[];
  /** Contract problems already reported (lib/findings.ts), kept apart from new ones. */
  knownContractGaps: string[];
}

type Env = Record<string, string | undefined>;

/** The scenario on a real deployment. Throws LiveSetupError before anything is created when it cannot start. */
export async function runLive(env: Env, options: { fetch?: typeof fetch; write?: (line: string) => void } = {}): Promise<LiveReport> {
  const missing = REQUIRED_VARS.filter((name) => !env[name]);
  if (missing.length) {
    throw new LiveSetupError(`Missing: ${missing.join(", ")}. Set every one (see tests/cross-cloud/README.md); nothing was run.`, 2);
  }
  const deployment = env.MC_LIVE_DEPLOYMENT ?? null;
  if (deployment !== null && deployment !== "supabase" && deployment !== "aws") {
    throw new LiveSetupError("MC_LIVE_DEPLOYMENT must be supabase or aws.", 2);
  }
  const timeoutSeconds = Number(env.MC_LIVE_PROCESSING_TIMEOUT_SECONDS ?? 900);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new LiveSetupError("MC_LIVE_PROCESSING_TIMEOUT_SECONDS must be a number of seconds.", 2);
  const base = env.MC_LIVE_BASE_URL!.replace(/\/+$/, "");
  try {
    if (!/^https?:$/.test(new URL(base).protocol)) throw new Error("not http");
  } catch {
    throw new LiveSetupError("MC_LIVE_BASE_URL must be an http or https address.", 2);
  }

  const redact = redactor(env);
  const rawWrite = options.write ?? ((line: string) => console.log(line));
  const write = (line: string) => rawWrite(redact(line));
  const pollSeconds = Number(env.MC_LIVE_POLL_SECONDS ?? 5);
  if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) throw new LiveSetupError("MC_LIVE_POLL_SECONDS must be a number of seconds.", 2);
  const doFetch = options.fetch ?? fetch;
  const api = new Api(base, doFetch);

  // Does it answer at all? A free Supabase project pauses after about a week without use.
  const paused =
    "The deployment did not answer. A free Supabase project pauses after about a week without use: " +
    "restore it in the Supabase dashboard (Project, Restore), wait for it to start, then run this again. " +
    "On AWS, check the stack is up (deploy/aws/README.md).";
  let first;
  try {
    first = await api.call("listReleases", { token: env.MC_LIVE_TOKEN_ARTIST, query: { limit: "1" } });
  } catch (error) {
    throw new LiveSetupError(`${paused}\n(${(error as Error).message} from ${base})`, 3);
  }
  if (first.status >= 500 || (first.body && typeof first.body === "object" && "notJson" in first.body)) {
    throw new LiveSetupError(`${paused}\n(${base} answered ${first.status} to listReleases)`, 3);
  }
  if (first.status === 401) throw new LiveSetupError("The artist token was refused (401). Get fresh tokens and run again.", 2);

  const actor = (type: AccountType, label: string, token: string): Actor => ({ label, type, token });
  const actors: Target["actors"] = {
    artist: actor("artist", "artist", env.MC_LIVE_TOKEN_ARTIST!),
    ...(env.MC_LIVE_TOKEN_ARTIST_2 ? { otherArtist: actor("artist", "another artist", env.MC_LIVE_TOKEN_ARTIST_2) } : {}),
    listener: actor("end_user", "listener", env.MC_LIVE_TOKEN_END_USER!),
    thirdParty: actor("third_party", "third party", env.MC_LIVE_TOKEN_THIRD_PARTY!),
    admin: actor("administrator", "administrator", env.MC_LIVE_TOKEN_ADMINISTRATOR!),
    internal: actor("internal", "internal", env.MC_LIVE_TOKEN_INTERNAL!),
    accounting: actor("internal_accounting", "internal accounting", env.MC_LIVE_TOKEN_INTERNAL_ACCOUNTING!),
  };
  const stateOf = async (releaseId: string) => {
    const r = await api.call("getRelease", { token: actors.admin.token, params: { releaseId } });
    return r.status === 200 ? (r.body.state as string) : undefined;
  };
  const run = crypto.randomUUID().slice(0, 8);
  const invitee = env.MC_LIVE_INVITEE_EMAIL ?? "cross-cloud-invitee-{n}@example.com";
  const target: Target = {
    side: deployment ?? "live",
    api,
    uploadFetch: doFetch,
    actors,
    stateOf,
    async processing(releaseId) {
      const until = Date.now() + timeoutSeconds * 1000;
      write(`  waiting for processing of ${releaseId}`);
      while ((await stateOf(releaseId)) === "processing") {
        if (Date.now() > until) throw new Error(`release ${releaseId} was still processing after ${timeoutSeconds} s`);
        await new Promise((r) => setTimeout(r, pollSeconds * 1000));
      }
    },
    inviteeEmail: (n) => invitee.replace("{n}", `${n}-${run}`),
    log: (line) => write(line),
  };

  write(`Cross-cloud scenario against ${base}${deployment ? ` (${deployment})` : ""}`);
  const { run: rec, ids } = await runScenario(target);
  write(`Releases created (all taken down at the end): ${Object.values(ids).join(", ")}`);
  const problems = contractProblems(rec, deployment as "supabase" | "aws" | null);
  const known = (p: string) => CONTRACT_GAPS.some((g) => p.startsWith(g.step));
  return {
    side: rec.side,
    deployment,
    base,
    observations: rec.observations,
    facts: rec.facts,
    skipped: rec.skipped,
    unexpected: unexpected(rec),
    contract: problems.filter((p) => !known(p)),
    knownContractGaps: problems.filter(known),
  };
}

/** The report as plain lines. */
export function summary(report: LiveReport): string[] {
  const lines = [
    `${report.observations.length} calls, ${report.facts.length} facts, ${report.skipped.length} steps skipped.`,
  ];
  for (const s of report.skipped) lines.push(`  skipped: ${s.step} (${s.why})`);
  if (report.unexpected.length === 0 && report.contract.length === 0) lines.push("Every call answered as expected and fits the contract.");
  for (const u of report.unexpected) lines.push(`  UNEXPECTED: ${u}`);
  for (const c of report.contract) lines.push(`  CONTRACT: ${c}`);
  for (const c of report.knownContractGaps) lines.push(`  known contract gap (already reported): ${c}`);
  return lines;
}

/** Two saved reports (one per deployment), compared as the mock runs are. Known findings apart. */
export function compareReports(a: LiveReport, b: LiveReport): { found: string[]; known: string[] } {
  const all = differences(a, b);
  const isKnown = (d: string) => KNOWN_DIFFERENCES.some((k) => d.startsWith(k.step));
  return { found: all.filter((d) => !isKnown(d)), known: all.filter(isKnown) };
}

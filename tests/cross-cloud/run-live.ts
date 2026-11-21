// The cross-cloud scenario against a real deployment. Settings come only from environment
// variables (see README.md); it never prints a token, refuses to start when one is missing, and
// takes down every release it creates.
//
//   node tests/cross-cloud/run-live.ts
//   node tests/cross-cloud/run-live.ts --compare supabase.json aws.json
//
// Exit codes: 0 every step as expected; 1 a step did not; 2 a setting is missing or wrong;
// 3 the deployment did not answer.
import { readFileSync, writeFileSync } from "node:fs";
import { LiveSetupError, OPTIONAL_VARS, REQUIRED_VARS, compareReports, redactor, runLive, summary, type LiveReport } from "./lib/live.ts";

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(`Required: ${REQUIRED_VARS.join(", ")}`);
    for (const [name, what] of Object.entries(OPTIONAL_VARS)) console.log(`Optional: ${name}: ${what}`);
    return 0;
  }
  if (argv[0] === "--compare") {
    if (argv.length !== 3) {
      console.error("Usage: node run-live.ts --compare <report one> <report two>");
      return 2;
    }
    const [a, b] = argv.slice(1).map((f) => JSON.parse(readFileSync(f, "utf8")) as LiveReport);
    const { found, known } = compareReports(a, b);
    for (const line of found) console.log(line);
    for (const line of known) console.log(`known (already reported, lib/findings.ts): ${line}`);
    console.log(found.length ? `${found.length} new differences.` : "The two runs behave the same, apart from the known findings.");
    return found.length ? 1 : 0;
  }
  const redact = redactor(process.env);
  try {
    const report = await runLive(process.env);
    for (const line of summary(report)) console.log(redact(line));
    if (process.env.MC_LIVE_REPORT) {
      writeFileSync(process.env.MC_LIVE_REPORT, JSON.stringify(report, null, 2));
      console.log(`Report written to ${process.env.MC_LIVE_REPORT}`);
    }
    return report.unexpected.length || report.contract.length ? 1 : 0;
  } catch (error) {
    if (error instanceof LiveSetupError) {
      console.error(redact(error.message));
      return error.exitCode;
    }
    // Never the request: only what went wrong.
    console.error(redact(`The run stopped: ${(error as Error)?.message ?? String(error)}`));
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));

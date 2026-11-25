// run-live.ts, tested only against the mocks (it is never run against anything real here).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountType } from "../../../core/src/platform/index.ts";
import { makeDeployment, SIDES, type MockDeployment, type Side } from "../lib/mocks.ts";
import { REQUIRED_VARS, TOKEN_VARS, compareReports, runLive, type LiveReport } from "../lib/live.ts";

const script = new URL("../run-live.ts", import.meta.url).pathname;
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("MC_")));
const cli = (env: Record<string, string | undefined>, args: string[] = []) =>
  spawnSync(process.execPath, [script, ...args], { env: { ...cleanEnv(), ...env }, encoding: "utf8", timeout: 60_000 });

describe("run-live.ts refuses to start without its settings", () => {
  test("no settings: exit 2, every missing name listed, nothing run", () => {
    const r = cli({});
    assert.equal(r.status, 2, r.stderr);
    for (const name of REQUIRED_VARS) assert.match(r.stderr, new RegExp(name));
    assert.equal(r.stdout, "");
  });

  test("one token missing: exit 2 and only that name", () => {
    const env: Record<string, string> = { MC_LIVE_BASE_URL: "http://127.0.0.1:9" };
    for (const v of Object.values(TOKEN_VARS)) env[v] = `secret-${v}`;
    delete env.MC_LIVE_TOKEN_INTERNAL;
    const r = cli(env);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Missing: MC_LIVE_TOKEN_INTERNAL\./);
    assert.ok(!(r.stdout + r.stderr).includes("secret-"), "no token printed");
  });

  test("a deployment that does not answer: exit 3, says a free project pauses, prints no token", async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const env: Record<string, string> = { MC_LIVE_BASE_URL: `http://127.0.0.1:${port}` };
    for (const v of Object.values(TOKEN_VARS)) env[v] = `secret-${v}`;
    const r = cli(env);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /pauses after about a week without use/);
    assert.ok(!(r.stdout + r.stderr).includes("secret-"), "no token printed");
  });

  test("--help lists the settings", () => {
    const r = cli({}, ["--help"]);
    assert.equal(r.status, 0);
    for (const name of REQUIRED_VARS) assert.match(r.stdout, new RegExp(name));
  });
});

describe("run-live against the mocks, through plain HTTP calls", () => {
  const reports = new Map<Side, LiveReport>();
  const outputs = new Map<Side, string[]>();
  const tokens = new Map<Side, string[]>();
  const deployments: MockDeployment[] = [];
  const created = new Map<Side, string[]>();

  before(async () => {
    for (const side of SIDES) {
      const d = await makeDeployment(side);
      deployments.push(d);
      const env: Record<string, string> = { MC_LIVE_BASE_URL: d.api.base, MC_LIVE_DEPLOYMENT: side, MC_LIVE_POLL_SECONDS: "0.05" };
      const owners: string[] = [];
      for (const [type, name] of Object.entries(TOKEN_VARS) as [AccountType, string][]) {
        const a = await d.account(type);
        env[name] = a.token;
        if (type === "artist") owners.push(a.userId);
      }
      const second = await d.account("artist");
      env.MC_LIVE_TOKEN_ARTIST_2 = second.token;
      owners.push(second.userId);
      tokens.set(side, Object.entries(env).filter(([k]) => k.startsWith("MC_LIVE_TOKEN_")).map(([, v]) => v));
      // The worker, running beside the script as it would on the deployment.
      let stop = false;
      const worker = (async () => {
        while (!stop) {
          await d.runJobs();
          await new Promise((r) => setTimeout(r, 20));
        }
      })();
      const lines: string[] = [];
      const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new Request(input, init).url;
        return url.startsWith(d.api.base) ? d.api.fetchFn(input, init) : d.clientFetch(input, init);
      }) as typeof fetch;
      try {
        reports.set(side, await runLive(env, { fetch: fetchFn, write: (l) => lines.push(l) }));
      } finally {
        stop = true;
        await worker;
      }
      outputs.set(side, lines);
      const rows = await d.db.query<{ id: string; owner_id: string; state: string }>(
        "select id::text as id, owner_id::text as owner_id, state from public.api_releases where owner_id::text in (select jsonb_array_elements_text($1::jsonb))",
        [JSON.stringify(owners)],
      );
      created.set(side, rows.map((r) => `${r.owner_id === owners[0] ? "artist" : "another artist"}: ${r.state}`).sort());
    }
  });
  after(async () => {
    for (const d of deployments) await d.close();
  });

  for (const side of SIDES) {
    test(`${side}: every step answers as expected and fits the contract, with this side's branch`, () => {
      const r = reports.get(side)!;
      assert.deepEqual(r.unexpected, []);
      assert.deepEqual(r.contract, []);
      assert.ok(r.observations.length > 150, `${r.observations.length} calls`);
    });

    test(`${side}: it skips only what a real deployment cannot show, and says why`, () => {
      assert.deepEqual(reports.get(side)!.skipped.map((s) => s.step), [
        "4 invitees view and accept",
        "4b the right code while locked",
        "6 the schedule fires",
        "7 a listener reads the first release once it is live",
        "8 server time passes",
        "8 counts",
        "refused: suspended and removed accounts",
        "9 the files are gone",
        "9 the audit row",
        "9 an invitation after the takedown",
        "9 the sweep's late pass",
      ]);
    });

    test(`${side}: it never prints a token`, () => {
      const text = outputs.get(side)!.join("\n") + JSON.stringify(reports.get(side));
      for (const t of tokens.get(side)!) assert.ok(!text.includes(t), "a token was printed or saved in the report");
    });

    test(`${side}: it changes only the releases it created, and takes each of them down`, () => {
      assert.deepEqual(created.get(side), ["another artist: taken_down", "artist: taken_down", "artist: taken_down"]);
    });
  }

  test("the two reports compare the same, also through --compare", () => {
    const { found, known } = compareReports(reports.get("supabase")!, reports.get("aws")!);
    assert.deepEqual(found, []);
    assert.deepEqual(known, [], "no known difference left (session G3)");
    const dir = mkdtempSync(join(tmpdir(), "mc-xc-live-"));
    try {
      const a = join(dir, "supabase.json");
      const b = join(dir, "aws.json");
      writeFileSync(a, JSON.stringify(reports.get("supabase")));
      writeFileSync(b, JSON.stringify(reports.get("aws")));
      const r = cli({}, ["--compare", a, b]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /The two runs behave the same, apart from the known findings\./);
      assert.doesNotMatch(r.stdout, /known \(already reported/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

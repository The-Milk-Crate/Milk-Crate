// The scenario on both module sets, compared step by step. Each side must also meet the
// scenario's own expectations and the contract's response schemas, not only match the other.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { makeDeployment, SIDES, type MockDeployment, type Side } from "../lib/mocks.ts";
import { mockTarget } from "../lib/mock-target.ts";
import { contractProblems, differences, unexpected, type Recorder } from "../lib/observe.ts";
import { runScenario } from "../lib/scenario.ts";
import { CONTRACT_GAPS, KNOWN_DIFFERENCES, SHARED_FINDINGS } from "../lib/findings.ts";
import { coverage, stateTable } from "../lib/coverage.ts";
import { loadContract } from "../lib/contract.ts";

const runs = new Map<Side, Recorder>();
const deployments: MockDeployment[] = [];

before(async () => {
  for (const side of SIDES) {
    const d = await makeDeployment(side);
    deployments.push(d);
    const { run } = await runScenario(await mockTarget(d));
    runs.set(side, run);
  }
});
after(async () => {
  for (const d of deployments) await d.close();
});

describe("the scenario", () => {
  for (const side of SIDES) {
    test(`${side}: every step answers as the scenario expects`, () => {
      assert.deepEqual(unexpected(runs.get(side)!), []);
    });
    test(`${side}: every answer fits the contract, and unions answer this side's branch`, () => {
      const problems = contractProblems(runs.get(side)!, side).filter((p) => !CONTRACT_GAPS.some((g) => p.startsWith(g.step)));
      assert.deepEqual(problems, []);
    });
    test(`${side}: nothing was skipped`, () => {
      assert.deepEqual(runs.get(side)!.skipped, []);
    });
  }

  test("the two sides behave the same (status, error code, state, response fields, facts)", () => {
    const found = differences(runs.get("supabase")!, runs.get("aws")!).filter((d) => !KNOWN_DIFFERENCES.some((k) => d.startsWith(k.step)));
    assert.deepEqual(found, []);
  });

  test("no finding is left open (session G3 fixed G2's three)", () => {
    assert.deepEqual({ KNOWN_DIFFERENCES, CONTRACT_GAPS, SHARED_FINDINGS }, { KNOWN_DIFFERENCES: [], CONTRACT_GAPS: [], SHARED_FINDINGS: [] });
  });

  test("each difference listed as a finding is still there (remove the entry with its fix)", () => {
    for (const k of KNOWN_DIFFERENCES) {
      for (const side of SIDES) {
        const got = runs.get(side)!.facts.filter((f) => f.step === k.step).map((f) => f.value);
        assert.deepEqual(got, k[side], `${side}: ${k.step}`);
      }
    }
  });

  test("the facts hold on each side", () => {
    for (const side of SIDES) {
      const facts = Object.fromEntries(runs.get(side)!.facts.map((f) => [`${f.step} / ${f.name}`, f.value]));
      const want: Record<string, unknown> = {
        "1 create the release / the title comes back exactly as sent": true,
        "2 read the interrupted upload / resumes from where it stopped": true,
        "2 confirm track 2 (the last) / releaseState": "processing",
        "3 the release after processing / every master confirmed": true,
        "3b edit the title and track order / new order": ["1:t2", "2:t1"],
        "3b the artist lists their releases / sees their own, not the other artist's": { own: true, other: false, allTheirs: true },
        "4 add rights and splits / party states": ["accepted", "invited", "accepted", "invited", "invited"],
        "4 add rights and splits / parties come back in the order sent": true,
        "4 invitee 1 views the invitation / only the release basics and their own share": true,
        "4 invitee 2 views the invitation / only the release basics and their own share": true,
        "4 invitee 3 views the invitation / only the release basics and their own share": true,
        "4 invitee 1 accepts / sees only their own party": true,
        "4 invitee 2 accepts / sees only their own party": true,
        "4 invitee 3 accepts / sees only their own party": true,
        "4b the failed release / has a plain reason": true,
        "4b the release after the replace starts / failureReason cleared": true,
        "4b the 11th wrong code / Retry-After is set": true,
        "4b resend 4 of 3 / Retry-After is set": true,
        "4b invitation emails / three sent to invitee four": 3,
        "5 a reviewer lists the review queue / sees it, and only awaiting_review": true,
        "5 a reviewer asks for changes / the owner is emailed": 1,
        "5 the artist lists one release a page / every release once, newest first": true,
        "5 the rights are kept / party states": ["accepted", "accepted", "accepted", "accepted", "accepted"],
        "5 the rights are kept / parties in the order sent": true,
        "5 a reviewer approves / decision": "approved",
        "6 publish / the go-live run is set for the release date": true,
        "7 another artist lists releases / the release is left out": false,
        "7b end_user reads the public view / no owner_id, rights or review": true,
        "7b end_user gets playback / the grant reads an MP3 (the streaming copy, not the WAV master)": true,
        "7b end_user gets the cover / the grant reads the cover": true,
        "8 a batch of plays / duplicate": false,
        "8 the same batch again / duplicate": true,
        "8 counts / 30 s or more over two batches qualifies, shorter does not, a repeat counts once": { long: { events: 3, qualified: 1 }, short: { events: 2, qualified: 0 } },
        "9 the files are gone / masters, streams and art": { masters: [], streams: [], art: [] },
        "9 the audit row / exists with the reason": "Cross-cloud check: rights claim.",
        "9 an administrator takes it down / the owner is emailed": 3,
        "9 the sweep's late pass / marks the takedown done": true,
        "9 the sweep's late pass / masters left for the taken-down release": 0,
      };
      for (const [k, v] of Object.entries(want)) assert.deepEqual(facts[k], v, `${side}: ${k}`);
    }
  });
});

describe("contract coverage (x-account-types, x-state-moves and the state table)", () => {
  test("the contract has 21 operations and the state table has its 14 moves", () => {
    assert.equal(Object.keys(loadContract().operations).length, 21);
    assert.equal(stateTable().length, 14);
  });
  for (const side of SIDES) {
    test(`${side}: every need is exercised`, () => {
      const unmet = coverage(runs.get(side)!, side).filter((n) => !n.met).map((n) => n.what);
      assert.deepEqual(unmet, []);
    });
  }
});

describe("the checks catch what they should (self-test)", () => {
  test("a changed status, code, state or field shows as a difference", () => {
    const a = runs.get("aws")!;
    const copy = { side: "aws (changed)", observations: a.observations.map((o) => ({ ...o })), facts: [...a.facts] };
    assert.deepEqual(differences(a, copy), [], "a run compares the same as itself");
    const i = copy.observations.findIndex((o) => o.operationId === "submitRelease");
    copy.observations[i].status = 500;
    const j = copy.observations.findIndex((o) => o.operationId === "getRelease" && o.status === 200);
    copy.observations[j].shape = { ...(copy.observations[j].shape as object), extra: "string" };
    const found = differences(a, copy);
    assert.equal(found.length, 2, found.join("\n"));
  });

  test("an operation with no step shows as a coverage gap", () => {
    const b = runs.get("aws")!;
    const copy = Object.assign(Object.create(Object.getPrototypeOf(b)), b, {
      observations: b.observations.filter((o) => o.operationId !== "resendInvitation"),
      moves: b.moves.filter((m) => m.cause !== "publishRelease"),
    });
    const unmet = coverage(copy, "aws").filter((n) => !n.met).map((n) => n.what);
    assert.ok(unmet.includes("resendInvitation: artist may call it (an answer in 2xx)"), unmet.join("\n"));
    assert.ok(unmet.includes("resendInvitation: no token (401)"));
    assert.ok(unmet.includes("publishRelease: awaiting_review → scheduled"));
  });

  test("a union answered with the other side's branch is a contract problem", () => {
    const b = runs.get("aws")!;
    assert.ok(contractProblems(b, "supabase").some((p) => /answered the s3_multipart branch; supabase should answer tus/.test(p)));
  });
});

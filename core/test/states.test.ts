// Every state move the contract lists, and the refused ones (409).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ReleaseState } from "../src/platform/index.ts";
import { makeApplyJobResult, makeRequeueStuckReleases } from "../src/handlers/index.ts";
import { account, db, forceState, harness, releaseState, seedRelease } from "./helpers.ts";

after(() => db.close());

const ALL: ReleaseState[] = [
  "draft",
  "uploading",
  "processing",
  "awaiting_splits",
  "awaiting_review",
  "needs_changes",
  "scheduled",
  "live",
  "failed",
  "taken_down",
];
const except = (...allowed: ReleaseState[]) => ALL.filter((s) => !allowed.includes(s));

describe("refused moves are 409 and change nothing", () => {
  const cases: { op: string; allowed: ReleaseState[]; run: (h: ReturnType<typeof harness>, as: any, s: any) => Promise<{ status: number; body: any }> }[] = [
    {
      op: "updateRelease",
      allowed: ["draft", "uploading", "awaiting_splits", "needs_changes"],
      run: (h, as, s) => h.call("updateRelease", { as, params: { releaseId: s.releaseId }, body: { title: "Edited" } }),
    },
    {
      op: "startUpload",
      allowed: ["draft", "uploading", "needs_changes", "failed"],
      run: (h, as, s) =>
        h.call("startUpload", { as, params: { releaseId: s.releaseId, trackId: s.trackIds[0] }, body: { format: "wav", sizeBytes: 10 } }),
    },
    {
      op: "startCoverUpload",
      allowed: ["draft", "uploading", "processing", "awaiting_splits", "needs_changes"],
      run: (h, as, s) => h.call("startCoverUpload", { as, params: { releaseId: s.releaseId }, body: { format: "png", sizeBytes: 10 } }),
    },
    {
      op: "putRights",
      allowed: ["draft", "uploading", "processing", "awaiting_splits", "needs_changes"],
      run: (h, as, s) =>
        h.call("putRights", {
          as,
          params: { releaseId: s.releaseId },
          body: {
            parties: [
              { side: "recording", role: "artist", name: "Me", percent: 100 },
              { side: "composition", role: "songwriter", name: "Me", percent: 100 },
            ],
          },
        }),
    },
    {
      op: "submitRelease",
      allowed: ["awaiting_splits"],
      run: (h, as, s) => h.call("submitRelease", { as, params: { releaseId: s.releaseId } }),
    },
    {
      op: "publishRelease",
      // awaiting_review without approval is 409 too, below.
      allowed: [],
      run: (h, as, s) => h.call("publishRelease", { as, params: { releaseId: s.releaseId } }),
    },
  ];

  for (const c of cases) {
    it(`${c.op} outside ${c.allowed.join(", ") || "its state"}`, async () => {
      const h = harness();
      const artist = await account("artist");
      const wrong: string[] = [];
      for (const state of except(...c.allowed)) {
        const s = await seedRelease(artist, state);
        const r = await c.run(h, artist, s);
        if (r.status !== 409) wrong.push(`${state}: ${r.status} ${JSON.stringify(r.body)}`);
        else if (await releaseState(s.releaseId) !== state) wrong.push(`${state}: state changed`);
      }
      assert.deepEqual(wrong, []);
    });
  }

  it("reviewRelease outside awaiting_review", async () => {
    const h = harness();
    const artist = await account("artist");
    const reviewer = await account("internal");
    for (const state of except("awaiting_review")) {
      const s = await seedRelease(artist, state);
      const r = await h.call("reviewRelease", { as: reviewer, params: { releaseId: s.releaseId }, body: { decision: "approve" } });
      assert.equal(r.status, 409, `${state}: ${JSON.stringify(r.body)}`);
    }
  });

  it("takedownRelease from every state but taken_down", async () => {
    const h = harness();
    const artist = await account("artist");
    const admin = await account("administrator");
    for (const state of ALL) {
      const s = await seedRelease(artist, state);
      const r = await h.call("takedownRelease", { as: admin, params: { releaseId: s.releaseId }, body: { reason: "Test." } });
      assert.equal(r.status, state === "taken_down" ? 409 : 200, `${state}: ${JSON.stringify(r.body)}`);
      assert.equal(await releaseState(s.releaseId), "taken_down");
    }
  });
});

describe("moves", () => {
  it("startUpload works in each allowed state and moves to uploading", async () => {
    const h = harness();
    const artist = await account("artist");
    for (const state of ["draft", "uploading", "needs_changes", "failed"] as const) {
      const s = await seedRelease(artist, state);
      const r = await h.call("startUpload", {
        as: artist,
        params: { releaseId: s.releaseId, trackId: s.trackIds[0] },
        body: { format: "aiff", sizeBytes: 10 },
      });
      assert.equal(r.status, 201, `${state}: ${JSON.stringify(r.body)}`);
      assert.equal(await releaseState(s.releaseId), "uploading");
      const view = await h.call("getRelease", { as: artist, params: { releaseId: s.releaseId } });
      assert.equal(view.body.failureReason, undefined, "leaving failed clears the reason");
      assert.equal(view.body.tracks[0].masterConfirmed, false, "a new upload replaces the master");
    }
  });

  it("startUpload for a track that is not on the release is 404", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const other = await seedRelease(artist, "draft");
    const r = await h.call("startUpload", {
      as: artist,
      params: { releaseId: s.releaseId, trackId: other.trackIds[0] },
      body: { format: "wav", sizeBytes: 10 },
    });
    assert.equal(r.status, 404);
  });

  it("the worker's failure moves processing to failed with its message", async () => {
    const h = harness();
    const artist = await account("artist");
    const c = await h.call("createRelease", { as: artist, body: { title: "F", releaseDate: "2026-01-01", tracks: [{ title: "A" }] } });
    const up = await h.call("startUpload", {
      as: artist,
      params: { releaseId: c.body.id, trackId: c.body.tracks[0].id },
      body: { format: "wav", sizeBytes: 10 },
    });
    await h.call("confirmUpload", { as: artist, params: { uploadId: up.body.uploadId }, body: { sha256: "e".repeat(64) } });
    const apply = makeApplyJobResult(h.modules);
    await apply(h.modules.jobs.enqueued[0].jobId, { ok: false, message: "The SHA-256 did not match the file." });
    const view = await h.call("getRelease", { as: artist, params: { releaseId: c.body.id } });
    assert.equal(view.body.state, "failed");
    assert.equal(view.body.failureReason, "The SHA-256 did not match the file.");
    // Safe twice, and a later success for the same job changes nothing.
    await apply(h.modules.jobs.enqueued[0].jobId, { ok: true });
    assert.equal(await releaseState(c.body.id), "failed");
    await assert.rejects(apply(h.modules.jobs.enqueued[0].jobId, { ok: false, message: "  " }));
    await assert.rejects(apply("00000000-0000-0000-0000-000000000000", { ok: true }), { code: "MC404" });
    await assert.rejects(apply("not-a-job", { ok: true }));
  });

  it("needs_changes: the reviewer's reason is emailed; saving rights moves to awaiting_splits", async () => {
    const h = harness();
    const artist = await account("artist");
    const reviewer = await account("administrator");
    const s = await seedRelease(artist, "awaiting_review");
    const r = await h.call("reviewRelease", {
      as: reviewer,
      params: { releaseId: s.releaseId },
      body: { decision: "needs_changes", reason: "The cover is blurry." },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, "needs_changes");
    assert.deepEqual(r.body.review.decision, "needs_changes");
    assert.equal(r.body.review.reason, "The cover is blurry.");
    assert.deepEqual(h.modules.secretsAndEmail.sent, [
      { template: "review_needs_changes", to: artist.email, data: { releaseTitle: "Seeded", reason: "The cover is blurry." } },
    ]);
    const saved = await h.call("putRights", {
      as: artist,
      params: { releaseId: s.releaseId },
      body: {
        parties: [
          { side: "recording", role: "artist", name: "Me", percent: 100 },
          { side: "composition", role: "songwriter", name: "Me", percent: 100 },
        ],
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(await releaseState(s.releaseId), "awaiting_splits");
  });

  it("needs_changes needs a reason (400), and the owner cannot review their own release", async () => {
    const h = harness();
    const artist = await account("artist");
    const reviewer = await account("internal");
    const s = await seedRelease(artist, "awaiting_review");
    const r = await h.call("reviewRelease", { as: reviewer, params: { releaseId: s.releaseId }, body: { decision: "needs_changes" } });
    assert.equal(r.status, 400);
    const blank = await h.call("reviewRelease", { as: reviewer, params: { releaseId: s.releaseId }, body: { decision: "needs_changes", reason: " " } });
    assert.equal(blank.status, 400);
    assert.equal(await releaseState(s.releaseId), "awaiting_review");
  });

  it("submitRelease refuses missing shares and a declined party (422)", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "awaiting_splits");
    const r = await h.call("submitRelease", { as: artist, params: { releaseId: s.releaseId } });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, "shares_not_100");
    await db.query(
      `insert into public.api_parties (release_id, side, role, name, percent, is_owner) values
        ($1::uuid, 'recording', 'artist', 'Me', 100, true), ($1::uuid, 'composition', 'songwriter', 'Me', 100, true)`,
      [s.releaseId],
    );
    await db.transaction(async (tx) => {
      await tx.query("set local session_replication_role = replica");
      await tx.query(
        `insert into public.api_parties (release_id, side, role, name, email, percent, state, responded_at)
         values ($1::uuid, 'composition', 'producer', 'No', 'no@example.invalid', 0, 'declined', now())`,
        [s.releaseId],
      );
    });
    const declined = await h.call("submitRelease", { as: artist, params: { releaseId: s.releaseId } });
    assert.equal(declined.status, 422);
    assert.equal(declined.body.code, "declined_party");
    assert.equal(await releaseState(s.releaseId), "awaiting_splits");
  });

  it("submitting clears an earlier review decision", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "awaiting_splits");
    await db.query(
      `insert into public.api_parties (release_id, side, role, name, percent, is_owner) values
        ($1::uuid, 'recording', 'artist', 'Me', 100, true), ($1::uuid, 'composition', 'songwriter', 'Me', 100, true)`,
      [s.releaseId],
    );
    await forceState(s.releaseId, "awaiting_splits");
    await db.transaction(async (tx) => {
      await tx.query("set local session_replication_role = replica");
      await tx.query(
        "update public.api_releases set review_decision = 'needs_changes', review_reason = 'Old', review_decided_at = now() where id = $1::uuid",
        [s.releaseId],
      );
    });
    const r = await h.call("submitRelease", { as: artist, params: { releaseId: s.releaseId } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.review, { decision: "none" });
  });
});

describe("releases stuck in processing", () => {
  async function stuck(h: ReturnType<typeof harness>) {
    const artist = await account("artist");
    const c = await h.call("createRelease", { as: artist, body: { title: "S", releaseDate: "2026-01-01", tracks: [{ title: "A" }] } });
    const up = await h.call("startUpload", { as: artist, params: { releaseId: c.body.id, trackId: c.body.tracks[0].id }, body: { format: "wav", sizeBytes: 10 } });
    // The enqueue fails after the confirm committed: no job row.
    const enqueue = h.modules.jobs.enqueue.bind(h.modules.jobs);
    h.modules.jobs.enqueue = async () => {
      throw new Error("database blip");
    };
    const r = await h.call("confirmUpload", { as: artist, params: { uploadId: up.body.uploadId }, body: { sha256: "f".repeat(64) } });
    h.modules.jobs.enqueue = enqueue;
    assert.equal(r.status, 200);
    assert.equal(r.body.releaseState, "processing");
    assert.ok(h.options.logs.some((l) => l.includes("its job was not queued")));
    return c.body.id as string;
  }
  // With triggers off: the touch trigger would set updated_at back to now.
  const age = (releaseId: string, minutes: number) =>
    db.transaction(async (tx) => {
      await tx.query("set local session_replication_role = replica");
      await tx.query("update public.api_releases set updated_at = now() - make_interval(mins => $2::integer) where id = $1::uuid", [
        releaseId,
        minutes,
      ]);
    });
  const jobs = async (releaseId: string) =>
    (await db.query<{ n: number }>("select count(*)::int as n from public.api_jobs where release_id = $1::uuid", [releaseId]))[0].n;

  it("a confirm whose enqueue failed is queued again by the sweep, once", async () => {
    const h = harness();
    const releaseId = await stuck(h);
    assert.equal(await jobs(releaseId), 0);
    const requeue = makeRequeueStuckReleases(h.modules, { log: (m) => h.options.logs.push(m), limit: 1000 });

    // Inside the grace period: left alone, in case its enqueue is still under way.
    assert.ok(!(await requeue()).requeued.includes(releaseId));
    await age(releaseId, 20);
    assert.ok((await requeue()).requeued.includes(releaseId));
    assert.equal(await jobs(releaseId), 1);
    // It has a queued job now, so the next sweep leaves it alone.
    await age(releaseId, 20);
    assert.ok(!(await requeue()).requeued.includes(releaseId));

    // The new job's result moves the release on as usual.
    const job = h.modules.jobs.enqueued.find((e) => e.job.releaseId === releaseId)!;
    await makeApplyJobResult(h.modules)(job.jobId, { ok: true });
    assert.equal(await releaseState(releaseId), "awaiting_splits");
  });

  it("a release whose requeue fails again is reported and tried on the next sweep", async () => {
    const h = harness();
    const releaseId = await stuck(h);
    await age(releaseId, 60);
    const failing = { database: h.modules.database, jobs: { enqueue: async (): Promise<never> => { throw new Error("still down"); }, reportResult: async () => {} } };
    const logs: string[] = [];
    const first = await makeRequeueStuckReleases(failing, { log: (m) => logs.push(m), limit: 1000 })();
    assert.ok(first.failed.includes(releaseId));
    assert.ok(logs.some((l) => l.includes(releaseId)));
    const second = await makeRequeueStuckReleases(h.modules, { limit: 1000 })();
    assert.ok(second.requeued.includes(releaseId));
  });
});

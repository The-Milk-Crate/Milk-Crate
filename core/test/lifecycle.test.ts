// A release from draft to live and taken down, through the handlers, on both upload methods.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeApplyJobResult } from "../src/handlers/index.ts";
import { account, db, harness, pngHead, releaseState } from "./helpers.ts";

after(() => db.close());

for (const method of ["tus", "s3_multipart"] as const) {
  describe(`lifecycle on ${method}`, () => {
    it("draft → uploading → processing → awaiting_splits → awaiting_review → live → taken_down", async () => {
      const h = harness(method);
      const artist = await account("artist");
      const reviewer = await account("internal");
      const admin = await account("administrator");
      const invitee = await account("end_user");

      // createRelease
      const created = await h.call("createRelease", {
        as: artist,
        body: { title: "First", releaseDate: "2026-05-01", tracks: [{ title: "One" }, { title: "Two" }] },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const release = created.body;
      assert.equal(release.state, "draft");
      assert.equal(release.owner_id, artist.userId);
      assert.deepEqual(release.review, { decision: "none" });
      assert.deepEqual(release.rights, { parties: [] });
      assert.equal(release.hasCover, false);
      assert.deepEqual(
        release.tracks.map((t: { position: number; title: string; masterConfirmed: boolean }) => [t.position, t.title, t.masterConfirmed]),
        [
          [1, "One", false],
          [2, "Two", false],
        ],
      );
      const releaseId: string = release.id;
      const [t1, t2] = release.tracks.map((t: { id: string }) => t.id);

      // startUpload: the first moves draft → uploading
      const up1 = await h.call("startUpload", { as: artist, params: { releaseId, trackId: t1 }, body: { format: "wav", sizeBytes: 20_000_000 } });
      assert.equal(up1.status, 201, JSON.stringify(up1.body));
      assert.equal(up1.body.method, method);
      assert.equal(up1.body.kind, "master");
      assert.equal(up1.body.trackId, t1);
      assert.equal(up1.body.objectKey, `masters/${artist.artistId}/${releaseId}/${t1}/original`);
      assert.equal(up1.body.sizeBytes, 20_000_000);
      assert.equal(up1.body.providerUploadId, undefined, "the storage id stays on the server");
      if (method === "s3_multipart") {
        assert.equal(up1.body.partCount, 3);
        assert.equal(up1.body.parts.length, 3);
      } else {
        assert.equal(up1.body.offset, 0);
        assert.ok(up1.body.endpoint);
      }
      assert.equal(await releaseState(releaseId), "uploading");

      const up2 = await h.call("startUpload", { as: artist, params: { releaseId, trackId: t2 }, body: { format: "flac", sizeBytes: 1000 } });
      assert.equal(up2.status, 201);

      // getUpload, to resume
      const progress = await h.call("getUpload", { as: artist, params: { uploadId: up1.body.uploadId } });
      assert.equal(progress.status, 200);
      assert.equal(progress.body.uploadId, up1.body.uploadId);
      assert.equal(progress.body.objectKey, up1.body.objectKey);

      // signUploadParts: s3 only
      const signed = await h.call("signUploadParts", { as: artist, params: { uploadId: up1.body.uploadId }, body: { partNumbers: [2, 3, 3] } });
      if (method === "s3_multipart") {
        assert.equal(signed.status, 200, JSON.stringify(signed.body));
        assert.deepEqual(signed.body.parts.map((p: { partNumber: number }) => p.partNumber), [2, 3]);
        const tooHigh = await h.call("signUploadParts", { as: artist, params: { uploadId: up1.body.uploadId }, body: { partNumbers: [4] } });
        assert.equal(tooHigh.status, 400);
      } else {
        assert.equal(signed.status, 409);
        assert.equal(signed.body.code, "wrong_method");
      }

      const confirmBody = (sha: string) =>
        method === "s3_multipart"
          ? { sha256: sha, crc64nvme: "AAAAAAAAAAA=", parts: [{ partNumber: 1, etag: "e1" }] }
          : { sha256: sha };

      // confirmUpload: the first keeps uploading, the last moves to processing and queues a job
      const c1 = await h.call("confirmUpload", { as: artist, params: { uploadId: up1.body.uploadId }, body: confirmBody("1".repeat(64)) });
      assert.equal(c1.status, 200, JSON.stringify(c1.body));
      assert.deepEqual(c1.body, { uploadId: up1.body.uploadId, kind: "master", trackId: t1, releaseState: "uploading" });
      assert.equal(h.modules.jobs.enqueued.length, 0);
      if (method === "s3_multipart") {
        assert.equal(h.modules.storage.confirms.at(-1)!.crc64nvme, "AAAAAAAAAAA=");
      } else {
        assert.equal(h.modules.storage.confirms.at(-1)!.crc64nvme, undefined, "ignored for tus");
      }
      const again = await h.call("confirmUpload", { as: artist, params: { uploadId: up1.body.uploadId }, body: confirmBody("1".repeat(64)) });
      assert.equal(again.status, 409);
      assert.equal(again.body.code, "upload_closed");

      const c2 = await h.call("confirmUpload", { as: artist, params: { uploadId: up2.body.uploadId }, body: confirmBody("2".repeat(64)) });
      assert.equal(c2.status, 200);
      assert.equal(c2.body.releaseState, "processing");
      assert.equal(h.modules.jobs.enqueued.length, 1);
      assert.equal(h.modules.jobs.enqueued[0].job.releaseId, releaseId);
      const [{ sha }] = await db.query<{ sha: string }>("select master_sha256 as sha from public.api_tracks where id = $1::uuid", [t2]);
      assert.equal(sha, "2".repeat(64), "the client's SHA-256 is recorded");

      // a cover can go up while processing
      const cover = await h.call("startCoverUpload", { as: artist, params: { releaseId }, body: { format: "png", sizeBytes: 5000 } });
      assert.equal(cover.status, 201, JSON.stringify(cover.body));
      assert.equal(cover.body.kind, "cover");
      assert.equal(cover.body.trackId, undefined);
      assert.equal(cover.body.objectKey, `art/${artist.artistId}/${releaseId}/cover/original`);
      h.modules.storage.objects.set(cover.body.objectKey, pngHead(3000, 3000));
      const cc = await h.call("confirmUpload", { as: artist, params: { uploadId: cover.body.uploadId }, body: confirmBody("c".repeat(64)) });
      assert.equal(cc.status, 200, JSON.stringify(cc.body));
      assert.deepEqual(cc.body, { uploadId: cover.body.uploadId, kind: "cover", releaseState: "processing" });

      // the worker reports success: processing → awaiting_splits
      const apply = makeApplyJobResult(h.modules);
      await apply(h.modules.jobs.enqueued[0].jobId, { ok: true });
      await apply(h.modules.jobs.enqueued[0].jobId, { ok: true });
      assert.equal(await releaseState(releaseId), "awaiting_splits");
      await db.query(
        "update public.api_tracks set stream_key = format('streams/%s/%s/%s/stream.m4a', $2::text, release_id, id) where release_id = $1::uuid",
        [releaseId, artist.artistId!],
      );

      // putRights: the owner's share is accepted at once; the other party is invited by email
      const rights = await h.call("putRights", {
        as: artist,
        params: { releaseId },
        body: {
          parties: [
            { side: "recording", role: "artist", name: "Me", percent: 100 },
            { side: "composition", role: "songwriter", name: "Me", percent: 60 },
            { side: "composition", role: "songwriter", name: "Co", email: "co@example.invalid", percent: 40 },
          ],
        },
      });
      assert.equal(rights.status, 200, JSON.stringify(rights.body));
      assert.deepEqual(
        rights.body.parties.map((p: { name: string; state: string; percent: number }) => [p.name, p.state, p.percent]),
        [
          ["Me", "accepted", 100],
          ["Me", "accepted", 60],
          ["Co", "invited", 40],
        ],
      );
      const invites = h.modules.secretsAndEmail.sent.filter((m) => m.template === "split_invitation");
      assert.equal(invites.length, 1);
      assert.equal(invites[0].to, "co@example.invalid");
      assert.equal(invites[0].data.releaseTitle, "First");
      assert.equal(invites[0].data.artistName, "Test Artist");
      const code = invites[0].data.inviteCode;
      const coParty = rights.body.parties[2].id;
      assert.ok(!JSON.stringify(rights.body).includes(code), "the code is never returned");

      // submit with a party still invited is allowed; a declined one is not. Accept first.
      const seen = await h.call("getInvitation", { as: invitee, params: { releaseId, partyId: coParty }, body: { inviteCode: code } });
      assert.equal(seen.status, 200, JSON.stringify(seen.body));
      assert.deepEqual(seen.body, {
        releaseTitle: "First",
        artistName: "Test Artist",
        releaseDate: "2026-05-01",
        trackTitles: ["One", "Two"],
        party: { side: "composition", role: "songwriter", percent: 40, state: "invited" },
      });
      const accepted = await h.call("respondToSplit", {
        as: invitee,
        params: { releaseId, partyId: coParty },
        body: { response: "accept", inviteCode: code },
      });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      assert.deepEqual(accepted.body.parties.map((p: { id: string; state: string }) => [p.id, p.state]), [[coParty, "accepted"]]);
      assert.equal(accepted.body.parties[0].email, undefined);

      // submitRelease: awaiting_splits → awaiting_review
      const submitted = await h.call("submitRelease", { as: artist, params: { releaseId } });
      assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
      assert.equal(submitted.body.state, "awaiting_review");

      // publish before approval: 409
      const early = await h.call("publishRelease", { as: artist, params: { releaseId } });
      assert.equal(early.status, 409);
      assert.equal(early.body.code, "not_approved");

      // reviewRelease approve: no state change
      const approved = await h.call("reviewRelease", { as: reviewer, params: { releaseId }, body: { decision: "approve" } });
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(approved.body.state, "awaiting_review");
      assert.equal(approved.body.review.decision, "approved");
      assert.ok(approved.body.review.decidedAt);

      // publishRelease: the date is past, so live, with no schedule
      const published = await h.call("publishRelease", { as: artist, params: { releaseId } });
      assert.equal(published.status, 200, JSON.stringify(published.body));
      assert.equal(published.body.state, "live");
      assert.equal(h.modules.schedules.set.length, 0);

      // play it
      const play = await h.call("getPlayback", { as: invitee, params: { trackId: t1 } });
      assert.equal(play.status, 200);
      assert.equal(play.body.method, method === "tus" ? "signed_url" : "cloudfront_cookies");
      const coverGrant = await h.call("getCover", { as: invitee, params: { releaseId } });
      assert.equal(coverGrant.status, 200);
      assert.equal(coverGrant.body.releaseId, releaseId);
      const pub = await h.call("getPublicRelease", { as: invitee, params: { releaseId } });
      assert.equal(pub.status, 200);
      assert.equal(pub.body.hasCover, true);

      // takedownRelease
      const down = await h.call("takedownRelease", { as: admin, params: { releaseId }, body: { reason: "Not their music." } });
      assert.equal(down.status, 200, JSON.stringify(down.body));
      assert.equal(down.body.release.state, "taken_down");
      assert.equal(down.body.release.hasCover, false);
      assert.deepEqual(h.modules.storage.deleted, [
        `masters/${artist.artistId}/${releaseId}/`,
        `streams/${artist.artistId}/${releaseId}/`,
        `art/${artist.artistId}/${releaseId}/`,
      ]);
      assert.equal(h.modules.storage.objects.has(cover.body.objectKey), false);
      const [audit] = await db.query<{ removed: string; deleted: boolean; actor: string; reason: string }>(
        `select removed::text as removed, files_deleted_at is not null as deleted, actor_id::text as actor, reason
           from public.api_audit_log where id = $1::uuid`,
        [down.body.auditId],
      );
      assert.equal(audit.deleted, true);
      assert.equal(audit.actor, admin.userId);
      assert.equal(audit.reason, "Not their music.");
      assert.deepEqual(JSON.parse(audit.removed).prefixes, h.modules.storage.deleted);
      const notice = h.modules.secretsAndEmail.sent.find((m) => m.template === "release_taken_down");
      assert.deepEqual(notice, { template: "release_taken_down", to: artist.email, data: { releaseTitle: "First", reason: "Not their music." } });

      // listener access is gone
      assert.equal((await h.call("getPlayback", { as: invitee, params: { trackId: t1 } })).status, 404);
      assert.equal((await h.call("getPublicRelease", { as: invitee, params: { releaseId } })).status, 404);
      const twice = await h.call("takedownRelease", { as: admin, params: { releaseId }, body: { reason: "Again." } });
      assert.equal(twice.status, 409);
    });
  });
}

describe("publish on a future date", () => {
  it("is scheduled, and the schedule runs api_release_go_live on the release date", async () => {
    const h = harness();
    const artist = await account("artist");
    const releaseId = await awaitingApprovedRelease(artist, "2099-03-04");
    const r = await h.call("publishRelease", { as: artist, params: { releaseId } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.state, "scheduled");
    assert.equal(h.modules.schedules.set.length, 1);
    const set = h.modules.schedules.set[0];
    assert.equal(set.name, `go-live:${releaseId}`);
    assert.equal(set.fn, "api_release_go_live");
    assert.deepEqual(set.args, { p_release_id: releaseId });
    assert.equal(set.at.toISOString(), "2099-03-04T00:00:00.000Z");
    assert.match(set.name, /^[A-Za-z0-9_.:-]{1,100}$/, "session E's schedule name rule");
    // What the schedule does on the day.
    await db.query("select public.api_release_go_live(p_release_id => $1::uuid)", [releaseId]);
    assert.equal(await releaseState(releaseId), "live");
  });

  it("stays awaiting_review when the schedule cannot be set", async () => {
    const h = harness();
    const artist = await account("artist");
    const releaseId = await awaitingApprovedRelease(artist, "2099-03-04");
    h.modules.schedules.fail = true;
    const r = await h.call("publishRelease", { as: artist, params: { releaseId } });
    assert.equal(r.status, 500);
    assert.equal(r.body.code, "internal");
    assert.equal(await releaseState(releaseId), "awaiting_review");
  });
});

/** A release that a reviewer approved, built through the handlers. */
async function awaitingApprovedRelease(artist: Awaited<ReturnType<typeof account>>, releaseDate: string): Promise<string> {
  const h = harness();
  const reviewer = await account("administrator");
  const c = await h.call("createRelease", { as: artist, body: { title: "Later", releaseDate, tracks: [{ title: "Only" }] } });
  const releaseId = c.body.id;
  const up = await h.call("startUpload", { as: artist, params: { releaseId, trackId: c.body.tracks[0].id }, body: { format: "wav", sizeBytes: 10 } });
  await h.call("confirmUpload", { as: artist, params: { uploadId: up.body.uploadId }, body: { sha256: "d".repeat(64) } });
  await makeApplyJobResult(h.modules)(h.modules.jobs.enqueued[0].jobId, { ok: true });
  const r = await h.call("putRights", {
    as: artist,
    params: { releaseId },
    body: {
      parties: [
        { side: "recording", role: "artist", name: "Me", percent: 100 },
        { side: "composition", role: "songwriter", name: "Me", percent: 100 },
      ],
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await h.call("submitRelease", { as: artist, params: { releaseId } })).status, 200);
  assert.equal((await h.call("reviewRelease", { as: reviewer, params: { releaseId }, body: { decision: "approve" } })).status, 200);
  return releaseId;
}


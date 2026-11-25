// Test only: a release in any state, written straight in through the side's own Database
// module with session B's triggers off, with a confirmed master, its streaming copy and a
// cover stored in the side's storage, and an upload row the side's storage module can read.
// Plus an open upload (cancelled in taken_down, as takedown leaves it) for getUpload, which
// answers 409 for an upload that is not open.
// The same approach as session G's core tests (core/test/helpers.ts), so session C's fixture
// can be checked in every state. Real state moves are tested through the scenario.
import { randomUUID } from "node:crypto";
import type { ReleaseState } from "../../../core/src/platform/index.ts";
import { BASE } from "../../../deploy/supabase/test/fake-storage.ts";
import type { Account, MockDeployment } from "./mocks.ts";

export interface Seeded {
  releaseId: string;
  trackIds: string[];
  uploadId: string;
  /** A second master upload: open, or cancelled in taken_down. */
  openUploadId: string;
  streamKey: string;
  coverKey: string;
}

const SMALL_MP3 = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]);

export async function seedRelease(d: MockDeployment, owner: Account, state: ReleaseState): Promise<Seeded> {
  const releaseId = randomUUID();
  const trackId = randomUUID();
  const uploadId = randomUUID();
  const coverUploadId = randomUUID();
  const openUploadId = randomUUID();
  const artistId = owner.artistId!;
  const streamKey = `streams/${artistId}/${releaseId}/${trackId}/mp3-320.mp3`;
  const coverKey = `art/${artistId}/${releaseId}/cover/original`;
  const masterKey = `masters/${artistId}/${releaseId}/${trackId}/original`;
  // An upload id each storage module can read (see their packUploadId).
  const method = d.side === "supabase" ? "tus" : "s3_multipart";
  const provider = d.side === "supabase"
    ? `${BASE}/storage/v1/upload/resumable/sign/seeded-${uploadId}#mc_started=0&mc_size=1000`
    : `seeded-${uploadId}#mc_started=0&mc_size=1000`;
  const openProvider = provider.replace(`seeded-${uploadId}`, `seeded-open-${openUploadId}`);
  const approved = state === "scheduled" || state === "live";
  await d.db.transaction(async (tx) => {
    await tx.query("set local session_replication_role = replica");
    await tx.query(
      `insert into public.api_releases (id, owner_id, artist_id, title, release_date, state, failure_reason,
                                        review_decision, review_reason, review_decided_at)
       values ($1::uuid, $2::uuid, $3::uuid, 'Seeded', date '2026-05-01', $4::text,
               case when $4::text = 'failed' then 'The master could not be read.' end,
               case when $5::boolean then 'approved' when $4::text = 'needs_changes' then 'needs_changes' else 'none' end,
               case when $4::text = 'needs_changes' then 'Fix the title.' end,
               case when $5::boolean or $4::text = 'needs_changes' then now() end)`,
      [releaseId, owner.userId, artistId, state, approved],
    );
    await tx.query(
      `insert into public.api_tracks (id, release_id, position, title, master_upload_id, master_key, master_format,
                                      master_size_bytes, master_sha256, master_confirmed_at, stream_key, duration_ms)
       values ($1::uuid, $2::uuid, 1, 'Track 1', $3::uuid, $4::text, 'wav', 1000, repeat('a', 64), now(), $5::text, 200000)`,
      [trackId, releaseId, uploadId, masterKey, streamKey],
    );
    await tx.query(
      `insert into public.api_uploads (id, release_id, track_id, kind, method, provider_upload_id, object_key, format,
                                       size_bytes, state, sha256, confirmed_at)
       values ($1::uuid, $2::uuid, $3::uuid, 'master', $4::text, $5::text, $6::text, 'wav', 1000, 'confirmed', repeat('a', 64), now())`,
      [uploadId, releaseId, trackId, method, provider, masterKey],
    );
    await tx.query(
      `insert into public.api_uploads (id, release_id, kind, method, provider_upload_id, object_key, format,
                                       size_bytes, state, sha256, confirmed_at)
       values ($1::uuid, $2::uuid, 'cover', $3::text, $4::text, $5::text, 'png', 100, 'confirmed', repeat('b', 64), now())`,
      [coverUploadId, releaseId, method, `${provider}-cover`, coverKey],
    );
    await tx.query(
      `insert into public.api_covers (release_id, upload_id, object_key, format, size_bytes, width, height)
       values ($1::uuid, $2::uuid, $3::text, 'png', 100, 3000, 3000)`,
      [releaseId, coverUploadId, coverKey],
    );
    await tx.query(
      `insert into public.api_uploads (id, release_id, track_id, kind, method, provider_upload_id, object_key, format,
                                       size_bytes, state)
       values ($1::uuid, $2::uuid, $3::uuid, 'master', $4::text, $5::text, $6::text, 'wav', 1000, $7::text)`,
      [openUploadId, releaseId, trackId, method, openProvider, masterKey, state === "taken_down" ? "cancelled" : "open"],
    );
  });
  // A taken-down release's files are deleted by the takedown.
  if (state !== "taken_down") {
    d.putObject(streamKey, SMALL_MP3, "audio/mpeg");
    d.putObject(coverKey, new Uint8Array(100), "image/png");
  }
  return { releaseId, trackIds: [trackId], uploadId, openUploadId, streamKey, coverKey };
}

/** Moves a party's invitation 15 days back, so its code has expired (test only). */
export async function expireInvitation(d: MockDeployment, partyId: string): Promise<void> {
  await d.db.query(
    `update public.api_parties set invite_sent_at = invite_sent_at - interval '15 days',
                                   invite_expires_at = invite_expires_at - interval '15 days'
      where id = $1::uuid`,
    [partyId],
  );
}

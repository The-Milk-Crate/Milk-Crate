// What the cross-cloud check found that it does not fix (K Marcus routes the fixes). Each entry
// names the step it covers, so the tests still fail on anything else. Listed in the pull request.

/**
 * Differences between the two deployments. Each must still be seen (the test fails when one is
 * fixed, so the entry is removed with the fix).
 */
export const KNOWN_DIFFERENCES: { step: string; finding: string; supabase: unknown[]; aws: unknown[] }[] = [
  {
    step: "9 an upload open at the takedown",
    finding:
      "An upload still open when a release is taken down. AWS: takedown aborts the open multipart uploads under the release (s3Storage.delete), so the app's next part PUT is refused (404 NoSuchUpload) and nothing is stored. Supabase: delete removes only stored objects; an open TUS upload is not one yet. Its signed upload token (about two hours) still works, so the app's next PATCH completes it and a master is stored under masters/ of the taken-down release, after the takedown said every file was deleted. The hourly sweep does not catch it either: files_deleted_at is already set. Supabase looks wrong (the contract: takedown deletes every file of the release). Shown on E's Storage fake; real Supabase Storage creates the object when the last TUS chunk arrives, so the same is expected there.",
    supabase: ["accepted", 1],
    aws: ["refused", 0],
  },
];

/**
 * Found by this check, the same on both deployments, so not a difference between them. Nothing
 * in the tests depends on these; they are listed for the pull request.
 */
export const SHARED_FINDINGS: { where: string; finding: string }[] = [
  {
    where: "core/src/handlers/views.ts (rights in getRelease), session G stage 1",
    finding:
      "getRelease lists rights.parties `order by created_at, id`. putRights writes every party in one transaction, so they share created_at and the order is by random id: it changes from release to release, and does not follow the order the artist sent (putRights itself answers in the order sent). Seen only by comparing runs; the same on both deployments. A position column, or ordering by the request order, would fix it.",
  },
];

/** Answers that are the same on both sides but are not in the contract. */
export const CONTRACT_GAPS: { step: string; finding: string }[] = [
  {
    step: "refused: a release id that is not a uuid",
    finding:
      "A path id that is not a uuid answers 400 bad_request (core's pathUuid), on both deployments. The contract lists no 400 for getRelease, getPublicRelease, getCover, getUpload, submitRelease, publishRelease, resendInvitation or getPlayback. Either add 400 to those operations, or answer 404 there.",
  },
];

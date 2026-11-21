// What the cross-cloud check found that it does not fix (K Marcus routes the fixes). Each entry
// names the step it covers, so the tests still fail on anything else. Listed in the pull request.
// Session G3 fixed the three G2 findings (The-Milk-Crate/Milk-Crate#36), so all three lists are
// empty: an upload open at a takedown (the sweep's late pass, and getUpload's 409), a path id
// that is not a uuid (400 in the contract), and the order of rights parties (a position column).

/**
 * Differences between the two deployments. Each must still be seen (the test fails when one is
 * fixed, so the entry is removed with the fix).
 */
export const KNOWN_DIFFERENCES: { step: string; finding: string; supabase: unknown[]; aws: unknown[] }[] = [];

/**
 * Found by this check, the same on both deployments, so not a difference between them. Nothing
 * in the tests depends on these; they are listed for the pull request.
 */
export const SHARED_FINDINGS: { where: string; finding: string }[] = [];

/** Answers that are the same on both sides but are not in the contract. */
export const CONTRACT_GAPS: { step: string; finding: string }[] = [];

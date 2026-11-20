// Reading releases back in the contract's shapes. Every date, time and number is turned into
// text in the SQL, so the result reads the same on Supabase (postgres.js) and on AWS (the RDS
// Data API), whatever each driver does with those types.
import type { Queryable, ReleaseState } from "../platform/index.ts";

/** An ISO 8601 time in UTC, with milliseconds, from a timestamptz column. Column names only. */
export const iso = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** A date column as YYYY-MM-DD. */
export const day = (column: string) => `to_char(${column}, 'YYYY-MM-DD')`;

export interface ReleaseRow {
  id: string;
  owner_id: string;
  artist_id: string;
  title: string;
  release_date: string;
  state: ReleaseState;
  failure_reason: string | null;
  review_decision: "none" | "approved" | "needs_changes";
  review_reason: string | null;
  review_decided_at: string | null;
  has_cover: boolean;
  created_at: string;
  updated_at: string;
}

export interface TrackRow {
  id: string;
  position: number;
  title: string;
  master_confirmed: boolean;
}

export interface PartyRow {
  id: string;
  side: "recording" | "composition";
  role: string;
  name: string;
  email: string | null;
  percent: string;
  state: "invited" | "accepted" | "declined";
  is_owner: boolean;
  has_code: boolean;
}

const RELEASE_COLUMNS = `r.id::text as id, r.owner_id::text as owner_id, r.artist_id::text as artist_id, r.title,
  ${day("r.release_date")} as release_date, r.state, r.failure_reason, r.review_decision, r.review_reason,
  ${iso("r.review_decided_at")} as review_decided_at,
  exists (select 1 from public.api_covers c where c.release_id = r.id) as has_cover,
  ${iso("r.created_at")} as created_at, ${iso("r.updated_at")} as updated_at`;

/** One release row, or null. `lock` takes the row lock first (inside a transaction). */
export async function releaseRow(db: Queryable, releaseId: string, lock = false): Promise<ReleaseRow | null> {
  if (lock) {
    // Lock on its own: FOR UPDATE cannot sit next to the exists() sub-select's table.
    await db.query("select 1 from public.api_releases where id = $1::uuid for update", [releaseId]);
  }
  const rows = await db.query<ReleaseRow>(`select ${RELEASE_COLUMNS} from public.api_releases r where r.id = $1::uuid`, [
    releaseId,
  ]);
  return rows[0] ?? null;
}

export async function trackRows(db: Queryable, releaseId: string): Promise<TrackRow[]> {
  return db.query<TrackRow>(
    `select t.id::text as id, t.position, t.title, (t.master_confirmed_at is not null) as master_confirmed
       from public.api_tracks t where t.release_id = $1::uuid order by t.position, t.id`,
    [releaseId],
  );
}

export async function partyRows(db: Queryable, releaseId: string): Promise<PartyRow[]> {
  return db.query<PartyRow>(
    `select p.id::text as id, p.side, p.role, p.name, p.email, p.percent::text as percent, p.state, p.is_owner,
            (p.invite_code_hash is not null) as has_code
       from public.api_parties p where p.release_id = $1::uuid order by p.created_at, p.id`,
    [releaseId],
  );
}

export function partyView(p: PartyRow, withEmail = true) {
  const view: Record<string, unknown> = {
    id: p.id,
    side: p.side,
    role: p.role,
    name: p.name,
    percent: Number(p.percent),
    state: p.state,
  };
  if (withEmail && p.email) view.email = p.email;
  return view;
}

/** The owner and staff view (`Release`). */
export function releaseView(r: ReleaseRow, tracks: TrackRow[], parties: PartyRow[]) {
  const review: Record<string, unknown> = { decision: r.review_decision };
  if (r.review_reason) review.reason = r.review_reason;
  if (r.review_decided_at) review.decidedAt = r.review_decided_at;
  const view: Record<string, unknown> = {
    id: r.id,
    owner_id: r.owner_id,
    title: r.title,
    releaseDate: r.release_date,
    state: r.state,
    hasCover: r.has_cover,
  };
  if (r.state === "failed" && r.failure_reason) view.failureReason = r.failure_reason;
  view.review = review;
  view.tracks = tracks.map((t) => ({ id: t.id, position: t.position, title: t.title, masterConfirmed: t.master_confirmed }));
  view.rights = { parties: parties.map((p) => partyView(p)) };
  view.createdAt = r.created_at;
  view.updatedAt = r.updated_at;
  return view;
}

/** Reads the whole release in the owner and staff view, or null. */
export async function fullRelease(db: Queryable, releaseId: string) {
  const r = await releaseRow(db, releaseId);
  if (!r) return null;
  return releaseView(r, await trackRows(db, releaseId), await partyRows(db, releaseId));
}

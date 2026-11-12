import { postgresDatabase, type ClosableDatabase } from "../src/database.ts";

/** The throwaway database from test/run.sh, or undefined when the tests run without it. */
export const DB_URL = process.env.MC_TEST_DB_URL;
export const NEEDS_DB = DB_URL ? false : "needs MC_TEST_DB_URL (run bash deploy/supabase/test/run.sh)";

export function testDb(): ClosableDatabase {
  return postgresDatabase({ url: DB_URL!, max: 2 });
}

/** An artist account and a draft release with `tracks` tracks. */
export async function newRelease(db: ClosableDatabase, tracks = 1) {
  const [{ user_id, artist_id }] = await db.query<{ user_id: string; artist_id: string }>(
    `insert into public.api_accounts (user_id, account_type, email, artist_id, artist_name)
     values (gen_random_uuid(), 'artist', 'a@example.invalid', gen_random_uuid(), 'Test Artist')
     returning user_id, artist_id`,
  );
  const [{ id }] = await db.query<{ id: string }>(
    "insert into public.api_releases (owner_id, title, release_date) values ($1::uuid, 'Test', current_date) returning id",
    [user_id],
  );
  const trackIds: string[] = [];
  for (let i = 1; i <= tracks; i++) {
    const [t] = await db.query<{ id: string }>(
      "insert into public.api_tracks (release_id, position, title) values ($1::uuid, $2::int, $3::text) returning id",
      [id, i, `Track ${i}`],
    );
    trackIds.push(t.id);
  }
  return { ownerId: user_id, artistId: artist_id, releaseId: id, trackIds };
}

/** A release in `processing`, through session B's upload functions. */
export async function processingRelease(db: ClosableDatabase) {
  const r = await newRelease(db, 1);
  const [s] = await db.query<{ upload_id: string }>(
    `select upload_id from public.api_start_upload($1::uuid, $2::uuid, 'master', 'tus', 'prov', 'wav', 1000::bigint, now() + interval '1 day')`,
    [r.releaseId, r.trackIds[0]],
  );
  const [c] = await db.query<{ start_processing: boolean }>(
    "select start_processing from public.api_confirm_upload($1::uuid, $2::text, null, null, null)",
    [s.upload_id, "a".repeat(64)],
  );
  if (!c.start_processing) throw new Error("fixture: release did not reach processing");
  return r;
}

/** A release in `scheduled`, written straight in with triggers off (test only). */
export async function scheduledRelease(db: ClosableDatabase) {
  const r = await newRelease(db, 1);
  await db.transaction(async (tx) => {
    await tx.query("set local session_replication_role = replica");
    await tx.query(
      `update public.api_releases set state = 'scheduled', review_decision = 'approved', review_decided_at = now()
       where id = $1::uuid`,
      [r.releaseId],
    );
  });
  return r;
}

export async function releaseState(db: ClosableDatabase, releaseId: string): Promise<{ state: string; failure_reason: string | null }> {
  const [row] = await db.query<{ state: string; failure_reason: string | null }>(
    "select state, failure_reason from public.api_releases where id = $1::uuid",
    [releaseId],
  );
  return row;
}

/** A fake fetch that records requests and answers from `route`. */
export function fakeFetch(route: (req: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req.clone());
    return route(req);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

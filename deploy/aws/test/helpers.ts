import pg from "pg";
import type { Database } from "../src/core.ts";
import { dataApiDatabase } from "../src/database.ts";
import { FakeDataApi } from "./fake-data-api.ts";

/** The throwaway database from test/run.sh (its migrations applied through the Data API path). */
export const DB_URL = process.env.MC_TEST_DB_URL;
export const NEEDS_DB = DB_URL ? false : "needs MC_TEST_DB_URL (run bash deploy/aws/test/run.sh)";

/** Database over the fake Data API over local Postgres. */
export function testDb(): { db: Database; api: FakeDataApi; close: () => Promise<void> } {
  const api = new FakeDataApi(DB_URL!);
  const db = dataApiDatabase({ client: api, resourceArn: "arn:cluster", secretArn: "arn:secret", database: "milk_crate" });
  return { db, api, close: () => api.close() };
}

/**
 * A plain Postgres connection that reads values the way session E's Database does (postgres.js
 * with E's settings): dates and timestamps as Postgres's text, numeric and bigint as text, json
 * parsed, other integers as numbers. The shape the Data API path must match.
 */
export function sessionEShape(): pg.Pool {
  const asText = (v: string) => v;
  const types = {
    getTypeParser(oid: number, format?: "text" | "binary") {
      if (oid === 1082 || oid === 1114 || oid === 1184) return asText;
      return pg.types.getTypeParser(oid, format);
    },
  };
  return new pg.Pool({ connectionString: DB_URL!, max: 2, types: types as never, options: "-c TimeZone=UTC" });
}

/** An artist account and a draft release with `tracks` tracks. */
export async function newRelease(db: Database, tracks = 1) {
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
export async function processingRelease(db: Database) {
  const r = await newRelease(db, 1);
  const [s] = await db.query<{ upload_id: string }>(
    `select upload_id from public.api_start_upload($1::uuid, $2::uuid, 'master', 's3_multipart', 'prov#mc_started=0&mc_size=1000', 'wav', 1000::bigint, now() + interval '1 day')`,
    [r.releaseId, r.trackIds[0]],
  );
  const [c] = await db.query<{ start_processing: boolean }>(
    "select start_processing from public.api_confirm_upload($1::uuid, $2::text, $3::text, null, null)",
    [s.upload_id, "a".repeat(64), "AAAAAAAAAAA="],
  );
  if (!c.start_processing) throw new Error("fixture: release did not reach processing");
  return r;
}

/** A release in `scheduled`, written straight in with triggers off (test only). */
export async function scheduledRelease(db: Database) {
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

/** An administrator account. */
export async function admin(db: Database): Promise<string> {
  const [{ user_id }] = await db.query<{ user_id: string }>(
    "insert into public.api_accounts (user_id, account_type) values (gen_random_uuid(), 'administrator') returning user_id",
  );
  return user_id;
}

import postgres from "postgres";
import type { Database, Queryable, SqlValue } from "./core.ts";

/**
 * A database error with the SQLSTATE and the message exactly as Postgres raised them, for
 * example `MC409` and `wrong_state: ...` from session B's rules. Session G maps `code` to HTTP.
 */
export class DatabaseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DatabaseError";
    this.code = code;
  }
}

export interface PostgresDatabaseOptions {
  /** A Postgres URL. Edge Functions use the pooler in transaction mode (port 6543). */
  url: string;
  /** Connections per instance. Small: each Edge Function instance has its own pool. */
  max?: number;
  /** Seconds before an idle connection closes. */
  idleTimeout?: number;
}

export type ClosableDatabase = Database & { close(): Promise<void> };

/** Values as the RDS Data API sends them on AWS: dates as ISO text, lists and objects as JSON. */
function toParam(value: SqlValue): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function surface(error: unknown): never {
  if (error instanceof postgres.PostgresError) throw new DatabaseError(error.code, error.message);
  throw error;
}

function queryable(sql: postgres.Sql | postgres.TransactionSql): Queryable {
  return {
    async query<Row = Record<string, unknown>>(text: string, params: SqlValue[] = []): Promise<Row[]> {
      try {
        // `unsafe` only means the text is not a tagged template. The values still travel
        // separately as $1, $2, ...; they are never put into the SQL text.
        const rows = await sql.unsafe(text, params.map(toParam));
        return [...rows] as Row[];
      } catch (error) {
        surface(error);
      }
    },
  };
}

/** `Database` over a pooled Postgres connection (postgres.js), for Edge Functions and the worker. */
export function postgresDatabase(options: PostgresDatabaseOptions): ClosableDatabase {
  const sql = postgres(options.url, {
    max: options.max ?? 3,
    idle_timeout: options.idleTimeout ?? 20,
    // The pooler in transaction mode cannot keep prepared statements between calls.
    prepare: false,
    connection: { TimeZone: "UTC" },
    // Dates and timestamps come back as text, as on the Data API, so a keyset cursor built from
    // them keeps its microseconds. numeric and bigint are text too (postgres.js default);
    // json and jsonb are parsed.
    types: {
      date: {
        to: 1184,
        from: [1082, 1114, 1184],
        serialize: (x: unknown) => (x instanceof Date ? x.toISOString() : String(x)),
        parse: (x: string) => x,
      },
      // Lists and objects arrive here as JSON text already (toParam). Once postgres.js has
      // seen a statement it knows a parameter is json and would encode the text again.
      json: {
        to: 114,
        from: [114, 3802],
        serialize: (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x)),
        parse: (x: string) => JSON.parse(x),
      },
    },
    onnotice: () => {},
  });
  const top = queryable(sql);
  return {
    query: top.query,
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      try {
        return (await sql.begin((tx) => fn(queryable(tx)))) as T;
      } catch (error) {
        surface(error);
      }
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

// A test-only Database over the throwaway PostgreSQL from test/run.sh, built like session E's
// (postgres.js; dates, times, numeric and bigint as text; SQLSTATE in `code`). The handlers turn
// every date, time and number into text in their SQL, so they do not lean on this.
import postgres from "postgres";
import type { Database, Queryable, SqlValue } from "../src/platform/index.ts";

export class DatabaseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DatabaseError";
    this.code = code;
  }
}

export type TestDatabase = Database & { close(): Promise<void>; calls: string[] };

function toParam(value: SqlValue): string | number | boolean | null {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

export function testDatabase(url: string): TestDatabase {
  const sql = postgres(url, {
    max: 4,
    prepare: false,
    onnotice: () => {},
    connection: { TimeZone: "UTC" },
    types: {
      date: { to: 1184, from: [1082, 1114, 1184], serialize: (x: unknown) => String(x), parse: (x: string) => x },
      // Lists and objects arrive as JSON text already, as on session E's Database.
      json: {
        to: 114,
        from: [114, 3802],
        serialize: (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x)),
        parse: (x: string) => JSON.parse(x),
      },
    },
  });
  const calls: string[] = [];
  const wrap = (s: postgres.Sql | postgres.TransactionSql): Queryable => ({
    async query<Row = Record<string, unknown>>(text: string, params: SqlValue[] = []): Promise<Row[]> {
      calls.push(text);
      try {
        return [...(await s.unsafe(text, params.map(toParam) as never[]))] as Row[];
      } catch (error) {
        if (error instanceof postgres.PostgresError) throw new DatabaseError(error.code, error.message);
        throw error;
      }
    },
  });
  const outer = wrap(sql);
  return {
    calls,
    query: outer.query,
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return (await sql.begin((tx) => fn(wrap(tx)))) as T;
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

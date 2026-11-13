import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RollbackTransactionCommand,
  type ColumnMetadata,
  type Field,
  type SqlParameter,
} from "@aws-sdk/client-rds-data";
import type { Database, Queryable, SqlValue } from "./core.ts";
import type { Sender } from "./aws.ts";
import { toNamedParameters } from "./sql.ts";

/**
 * A database error with the SQLSTATE and the message exactly as Postgres raised them, for
 * example `MC409` and `wrong_state: ...` from session B's rules. The same shape as session E's
 * (name `DatabaseError`, fields `code` and `message`), so session G maps errors one way.
 */
export class DatabaseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DatabaseError";
    this.code = code;
  }
}

export interface DataApiDatabaseOptions {
  /** An RDS Data API client (or a stand-in with the same `send`). */
  client: Sender;
  /** The Aurora cluster ARN. */
  resourceArn: string;
  /** The Secrets Manager secret that holds the database login. */
  secretArn: string;
  /** The database name inside the cluster. */
  database: string;
  /** Tries when Aurora is waking from a pause. Default 6 (about 45 s in all). */
  resumeRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Postgres SQLSTATE 54000 (program_limit_exceeded): the result was over the Data API's 1 MB. */
export const RESULT_TOO_LARGE = "54000";
/** Postgres SQLSTATE 57014 (query_canceled): the call ran past the Data API's 45 seconds. */
export const CALL_TIMED_OUT = "57014";

function toParameter(name: string, value: SqlValue): SqlParameter {
  if (value === null || value === undefined) return { name, value: { isNull: true } };
  if (typeof value === "string") return { name, value: { stringValue: value } };
  if (typeof value === "boolean") return { name, value: { booleanValue: value } };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("a parameter number must be finite");
    return Number.isSafeInteger(value)
      ? { name, value: { longValue: value } }
      : { name, value: { doubleValue: value } };
  }
  // Dates as ISO text and lists or objects as JSON text, as on session E. Cast them in the SQL
  // text ($1::timestamptz, $2::jsonb).
  if (value instanceof Date) return { name, value: { stringValue: value.toISOString() } };
  return { name, value: { stringValue: JSON.stringify(value) } };
}

/** Postgres prints a timestamp with no trailing zeros in its fraction; do the same. */
function trimFraction(fraction: string | undefined): string {
  if (!fraction) return "";
  const digits = fraction.slice(1).replace(/0+$/, "");
  return digits ? `.${digits}` : "";
}

const TIMESTAMP = /^(\d{4,}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d(?::?\d\d)?)?$/;

/**
 * Text for date and time values, as session E returns them (Postgres's own output with the
 * session in UTC): `2026-11-13`, `2026-11-13 10:00:00.123456`, `2026-11-13 10:00:00.123456+00`.
 * The Data API returns a timestamptz in UTC without an offset, so the `+00` is added back.
 */
function timeText(typeName: string, text: string): string {
  if (typeName === "date") return text;
  const m = TIMESTAMP.exec(text);
  if (!m) return text;
  const base = `${m[1]} ${m[2]}${trimFraction(m[3])}`;
  if (typeName === "timestamptz") {
    const zone = !m[4] || m[4] === "Z" ? "+00" : m[4].replace(/:00$/, "").replace(/^([+-]\d\d)00$/, "$1");
    return `${base}${zone}`;
  }
  return base;
}

/**
 * One value from the Data API, read the way session E's Database returns it:
 * `numeric`, `bigint`, `date` and `timestamptz` as text; `json` and `jsonb` parsed; other
 * integers and floats as numbers; booleans as booleans; `bytea` as bytes.
 */
export function fromField(field: Field, column: ColumnMetadata | undefined): unknown {
  const typeName = (column?.typeName ?? "").toLowerCase().replace(/^"|"$/g, "");
  if (field.isNull) return null;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.blobValue !== undefined) return field.blobValue;
  if (field.arrayValue !== undefined) {
    const a = field.arrayValue;
    if (a.stringValues) return a.stringValues;
    if (a.longValues) return typeName.startsWith("_int8") ? a.longValues.map(String) : a.longValues;
    if (a.doubleValues) return a.doubleValues;
    if (a.booleanValues) return a.booleanValues;
    if (a.arrayValues) return a.arrayValues.map((inner) => (inner ? fromField({ arrayValue: inner } as Field, column) : null));
    return [];
  }
  if (field.longValue !== undefined) {
    // bigint (and its serial) is text, as on session E, so no value loses digits.
    return typeName === "int8" || typeName === "bigserial" ? String(field.longValue) : field.longValue;
  }
  if (field.doubleValue !== undefined) {
    return typeName === "numeric" ? String(field.doubleValue) : field.doubleValue;
  }
  if (field.stringValue !== undefined) {
    const text = field.stringValue;
    if (typeName === "json" || typeName === "jsonb") return JSON.parse(text);
    if (typeName === "date" || typeName === "timestamp" || typeName === "timestamptz") return timeText(typeName, text);
    return text;
  }
  return null;
}

/**
 * The Data API reports a Postgres error as text such as
 * `ERROR: wrong_state: a release cannot move from draft to live\n  Where: PL/pgSQL ...; SQLState: MC409`.
 * Returns the SQLSTATE and the first line of the message, as Postgres raised it.
 */
export function parseDataApiError(error: unknown): DatabaseError | null {
  const name = (error as { name?: string })?.name ?? "";
  const text = (error as { message?: string })?.message;
  if (typeof text !== "string") return null;
  if (/StatementTimeoutException/.test(name)) {
    return new DatabaseError(CALL_TIMED_OUT, "the database call ran past the Data API's 45 second limit");
  }
  if (/response size limit|exceeded the maximum.*size|more than the allowed response size/i.test(text)) {
    return new DatabaseError(RESULT_TOO_LARGE, "the result was over the Data API's 1 MB limit; ask for fewer rows");
  }
  const state = /;\s*SQLState:\s*([0-9A-Z]{5})\s*$/.exec(text);
  if (!state) return null;
  let body = text.slice(0, state.index);
  body = body.replace(/^(ERROR|FATAL|PANIC):\s+/, "");
  const first = body.split("\n")[0].trimEnd();
  return new DatabaseError(state[1], first);
}

function isResuming(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? "";
  const text = (error as { message?: string })?.message ?? "";
  return name === "DatabaseResumingException" || /is resuming after being auto-paused/i.test(text);
}

export function rowsFrom(output: {
  records?: Field[][];
  columnMetadata?: ColumnMetadata[];
}): Record<string, unknown>[] {
  const columns = output.columnMetadata ?? [];
  return (output.records ?? []).map((record) => {
    const row: Record<string, unknown> = {};
    record.forEach((field, k) => {
      const column = columns[k];
      row[column?.label || column?.name || `column${k + 1}`] = fromField(field, column);
    });
    return row;
  });
}

/**
 * `Database` over the RDS Data API.
 *
 * - `$1`, `$2` become `:p1`, `:p2` and travel as typed parameters; values never go into the
 *   SQL text. Cast in the SQL text as session B asks (`$1::uuid`, `$2::jsonb`).
 * - A transaction is a Data API transaction id, carried on every statement in it. Statements in
 *   one transaction run one at a time (the Data API refuses two at once).
 * - Limits: one statement per call, 1 MB per result, 45 seconds per call. A result over 1 MB
 *   becomes `DatabaseError` 54000 and a call past 45 s becomes 57014, in plain words. Keep
 *   results small and page with keys, as session B's functions do.
 * - A Postgres error becomes `DatabaseError` with `code` (the SQLSTATE) and the message.
 */
export function dataApiDatabase(options: DataApiDatabaseOptions): Database {
  const base = { resourceArn: options.resourceArn, secretArn: options.secretArn, database: options.database };
  const retries = options.resumeRetries ?? 6;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function send<T>(command: unknown, retryOnResume: boolean): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await options.client.send(command as never)) as T;
      } catch (error) {
        // Aurora Serverless v2 at zero capacity wakes on the first call and refuses it meanwhile.
        if (retryOnResume && isResuming(error) && attempt < retries) {
          await sleep(Math.min(1000 * 2 ** attempt, 15_000));
          continue;
        }
        throw parseDataApiError(error) ?? error;
      }
    }
  }

  async function run<Row>(sql: string, params: SqlValue[], transactionId?: string): Promise<Row[]> {
    const named = toNamedParameters(sql);
    if (named.highest > params.length) {
      throw new Error(`the SQL uses $${named.highest} but only ${params.length} values were given`);
    }
    const output = await send<{ records?: Field[][]; columnMetadata?: ColumnMetadata[] }>(
      new ExecuteStatementCommand({
        ...base,
        sql: named.sql,
        parameters: params.map((v, k) => toParameter(`p${k + 1}`, v)),
        includeResultMetadata: true,
        ...(transactionId ? { transactionId } : {}),
      }),
      // Inside a transaction the cluster is already awake.
      !transactionId,
    );
    return rowsFrom(output) as Row[];
  }

  return {
    query<Row = Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<Row[]> {
      return run<Row>(sql, params);
    },

    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const { transactionId } = await send<{ transactionId?: string }>(new BeginTransactionCommand(base), true);
      if (!transactionId) throw new Error("the Data API returned no transaction id");
      // One statement at a time within the transaction.
      let chain: Promise<unknown> = Promise.resolve();
      const tx: Queryable = {
        query<Row = Record<string, unknown>>(sql: string, params: SqlValue[] = []): Promise<Row[]> {
          const next = chain.then(() => run<Row>(sql, params, transactionId));
          chain = next.catch(() => {});
          return next;
        },
      };
      let result: T;
      try {
        result = await fn(tx);
        await chain;
      } catch (error) {
        await send(new RollbackTransactionCommand({ resourceArn: base.resourceArn, secretArn: base.secretArn, transactionId }), false).catch(
          () => {},
        );
        throw error;
      }
      await send(new CommitTransactionCommand({ resourceArn: base.resourceArn, secretArn: base.secretArn, transactionId }), false);
      return result;
    },
  };
}

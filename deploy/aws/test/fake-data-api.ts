// A stand-in for the RDS Data API over a real local PostgreSQL, for tests only. It answers
// ExecuteStatement, BeginTransaction, CommitTransaction and RollbackTransaction the way the
// Data API documents them:
//   - named parameters (:name), one statement per call (extended protocol only);
//   - typed result fields (longValue for integers, stringValue for numeric, text, uuid, dates,
//     json and jsonb; timestamptz in UTC with no offset), with column type names;
//   - a Postgres error as "ERROR: <message>\n  Where: ...; SQLState: <code>".
// It is not the Data API: what it cannot show is listed in the README ("Not run here").
import pg from "pg";
import { randomUUID } from "node:crypto";
import { lex } from "../src/sql.ts";
import type { Sender } from "../src/aws.ts";

const TYPE_NAMES: Record<number, string> = {
  16: "bool", 17: "bytea", 18: "char", 19: "name", 20: "int8", 21: "int2", 23: "int4", 25: "text", 26: "oid",
  114: "json", 700: "float4", 701: "float8", 1009: "_text", 1043: "varchar", 1082: "date", 1114: "timestamp",
  1184: "timestamptz", 1700: "numeric", 2278: "void", 2950: "uuid", 3802: "jsonb",
};

const raw = { getTypeParser: () => (value: string) => value };

/** Postgres text array literal {a,b,"c d"} → strings (enough for tests). */
function parseTextArray(text: string): (string | null)[] {
  const inner = text.slice(1, -1);
  if (!inner) return [];
  const out: (string | null)[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g;
  for (const m of inner.matchAll(re)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] === "NULL" ? null : m[2]);
  return out;
}

function encode(value: string | null, typeName: string): Record<string, unknown> {
  if (value === null) return { isNull: true };
  switch (typeName) {
    case "bool": return { booleanValue: value === "t" };
    case "int2": case "int4": case "int8": case "oid": return { longValue: Number(value) };
    case "float4": case "float8": return { doubleValue: Number(value) };
    case "bytea": return { blobValue: Buffer.from(value.replace(/^\\x/, ""), "hex") };
    case "_text": return { arrayValue: { stringValues: parseTextArray(value) } };
    // The Data API gives a timestamptz in UTC without its offset.
    case "timestamptz": return { stringValue: value.replace(/[+-]\d\d(:\d\d)?$/, "") };
    default: return { stringValue: value };
  }
}

function decode(field: Record<string, unknown>): unknown {
  if (field.isNull) return null;
  for (const k of ["stringValue", "longValue", "doubleValue", "booleanValue", "blobValue"]) if (k in field) return field[k];
  throw new Error(`the fake cannot pass ${JSON.stringify(field)}`);
}

/** :name in code becomes $n; names repeat to the same number. */
function positional(sql: string, parameters: { name: string; value: Record<string, unknown> }[]) {
  const order: string[] = [];
  const text = lex(sql)
    .map((s) =>
      s.kind !== "code"
        ? s.text
        : s.text.replace(/(^|[^:]):([A-Za-z_][A-Za-z0-9_]*)/g, (_m, before: string, name: string) => {
            let k = order.indexOf(name);
            if (k < 0) { order.push(name); k = order.length - 1; }
            return `${before}$${k + 1}`;
          }),
    )
    .join("");
  const byName = new Map(parameters.map((p) => [p.name, decode(p.value)]));
  return { text, values: order.map((n) => { if (!byName.has(n)) throw dataApiError("BadRequestException", `parameter ${n} is missing`); return byName.get(n); }) };
}

function dataApiError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

export class FakeDataApi implements Sender {
  private pool: pg.Pool;
  private transactions = new Map<string, pg.PoolClient>();
  statements = 0;

  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 4, options: "-c TimeZone=UTC -c client_min_messages=warning" });
  }

  async send(command: any): Promise<any> {
    const name: string = command.constructor.name;
    const input = command.input;
    if (name === "BeginTransactionCommand") {
      const client = await this.pool.connect();
      await client.query("begin");
      const id = randomUUID();
      this.transactions.set(id, client);
      return { transactionId: id };
    }
    if (name === "CommitTransactionCommand" || name === "RollbackTransactionCommand") {
      const client = this.transactions.get(input.transactionId);
      if (!client) throw dataApiError("NotFoundException", "Transaction not found");
      this.transactions.delete(input.transactionId);
      try {
        await client.query(name === "CommitTransactionCommand" ? "commit" : "rollback");
      } finally {
        client.release();
      }
      return { transactionStatus: "done" };
    }
    if (name !== "ExecuteStatementCommand") throw new Error(`the fake Data API has no ${name}`);
    const client = input.transactionId ? this.transactions.get(input.transactionId) : undefined;
    if (input.transactionId && !client) throw dataApiError("NotFoundException", "Transaction not found");
    const { text, values } = positional(input.sql, input.parameters ?? []);
    this.statements++;
    let result: pg.QueryArrayResult;
    try {
      result = await (client ?? this.pool).query({ text, values, rowMode: "array", types: raw, queryMode: "extended" } as never);
    } catch (error) {
      const e = error as { code?: string; message: string; where?: string };
      if (!e.code) throw error;
      throw dataApiError("DatabaseErrorException", `ERROR: ${e.message}${e.where ? `\n  Where: ${e.where}` : ""}; SQLState: ${e.code}`);
    }
    const fields = result.fields ?? [];
    const columnMetadata = fields.map((f) => ({ name: f.name, label: f.name, typeName: TYPE_NAMES[f.dataTypeID] ?? `oid${f.dataTypeID}` }));
    return {
      numberOfRecordsUpdated: result.rowCount ?? 0,
      ...(input.includeResultMetadata ? { columnMetadata } : {}),
      records: (result.rows ?? []).map((row: unknown[]) => row.map((v, k) => encode(v as string | null, columnMetadata[k].typeName))),
    };
  }

  async close(): Promise<void> {
    for (const c of this.transactions.values()) c.release();
    await this.pool.end();
  }
}

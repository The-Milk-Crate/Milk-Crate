export type SqlValue = string | number | boolean | null | Date | SqlValue[] | { [key: string]: SqlValue };

/** Run SQL with parameters. Use `$1`, `$2` and so on in the text. Never put values in the text. */
export interface Queryable {
  query<Row = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<Row[]>;
}

/**
 * Reach the database. Supabase uses a Postgres connection; AWS uses the RDS Data API.
 * Keep results small: the Data API caps a response at 1 MB and a call at 45 seconds.
 */
export interface Database extends Queryable {
  /** Everything in `fn` commits together, or none of it does. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

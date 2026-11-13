import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "./core.ts";
import { hasColonName, splitStatements } from "./sql.ts";

/** db/migrations/*.sql in number order (0001_..., 0002_...). Never db/supabase/. */
export function migrationFiles(dir: string): { name: string; statements: string[] }[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((name) => {
      const statements = splitStatements(readFileSync(join(dir, name), "utf8"));
      // The Data API reads `:name` as a parameter; B's files have none outside strings.
      const bad = statements.findIndex((s) => hasColonName(s));
      if (bad >= 0) throw new Error(`${name}, statement ${bad + 1}, has a :name the Data API would read as a parameter`);
      return { name, statements };
    });
}

/**
 * Applies session B's migrations through the Data API: each file whole, in one transaction
 * (the Data API runs one statement per call, so the file is split with the tested splitter
 * and its statements run in order inside the transaction). A failure rolls that file back and
 * stops. B's files are safe to run twice, so the stand-up runs them all every time.
 */
export async function applyMigrations(database: Database, dir: string, log: (m: string) => void = console.log): Promise<number> {
  const files = migrationFiles(dir);
  for (const file of files) {
    await database.transaction(async (tx) => {
      for (const statement of file.statements) await tx.query(statement);
    });
    log(`ok - ${file.name} (${file.statements.length} statements)`);
  }
  return files.length;
}

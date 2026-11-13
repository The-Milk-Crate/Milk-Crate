// Used by test/run.sh: applies db/migrations/ the way the stand-up does (split into single
// statements, each file in one Data API transaction), through the fake Data API over local
// Postgres. run.sh then compares the schema with psql's whole-file apply.
import { join } from "node:path";
import { dataApiDatabase } from "../src/database.ts";
import { applyMigrations } from "../src/migrations.ts";
import { FakeDataApi } from "./fake-data-api.ts";

const url = process.env.MC_SPLIT_DB_URL;
if (!url) throw new Error("MC_SPLIT_DB_URL is not set");
const api = new FakeDataApi(url);
try {
  const db = dataApiDatabase({ client: api, resourceArn: "arn:cluster", secretArn: "arn:secret", database: "x" });
  const files = await applyMigrations(db, join(import.meta.dirname, "../../../db/migrations"), () => {});
  console.log(`${files} files, ${api.statements} statements, one per Data API call`);
} finally {
  await api.close();
}

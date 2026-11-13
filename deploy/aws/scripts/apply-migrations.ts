// Applies db/migrations/ (session B; never db/supabase/) to Aurora through the RDS Data API,
// each file whole in one transaction. Run by stand-up.sh with your AWS credentials.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RDSDataClient } from "@aws-sdk/client-rds-data";
import { dataApiDatabase } from "../src/database.ts";
import { applyMigrations } from "../src/migrations.ts";
import { get, readOutputs, region } from "./outputs.ts";

const outputs = readOutputs();
const database = dataApiDatabase({
  client: new RDSDataClient({ region: region() }),
  resourceArn: get(outputs, "DbClusterArn"),
  secretArn: get(outputs, "DbSecretArn"),
  database: get(outputs, "DbName"),
});
const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const count = await applyMigrations(database, dir);
console.log(`applied ${count} migration files`);

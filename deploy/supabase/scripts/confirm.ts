// The checks behind confirm.sh: Infrastructure.confirm with the real database and APIs.
import { required } from "../src/env.ts";
import { postgresDatabase } from "../src/database.ts";
import { confirmDeployment } from "../src/infrastructure.ts";
import { parseFileSize } from "../src/size.ts";

const env = (name: string) => process.env[name];
const database = postgresDatabase({ url: required(env, "MC_DB_URL"), max: 1 });
try {
  const result = await confirmDeployment({
    database,
    projectRef: required(env, "MC_SUPABASE_PROJECT_REF"),
    accessToken: required(env, "SUPABASE_ACCESS_TOKEN"),
    flyApp: required(env, "MC_FLY_APP"),
    flyToken: required(env, "FLY_API_TOKEN"),
    fileSizeLimitBytes: parseFileSize(env("MC_FILE_SIZE_LIMIT")),
  });
  if (result.ok) {
    console.log("ok - the Phase 0 Supabase deployment checks passed");
  } else {
    for (const p of result.problems) console.log(`problem - ${p}`);
    process.exitCode = 1;
  }
} finally {
  await database.close();
}

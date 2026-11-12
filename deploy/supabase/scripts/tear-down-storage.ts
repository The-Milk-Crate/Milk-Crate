// Tear-down only: empties and deletes the three Phase 0 buckets through the Storage API.
// The app's own buckets are never touched.
import { required } from "../src/env.ts";
import { DEFAULT_BUCKETS, emptyAndDeleteBucket } from "../src/storage.ts";

const env = (name: string) => process.env[name];
const options = { supabaseUrl: required(env, "SUPABASE_URL"), serviceKey: required(env, "SUPABASE_SERVICE_ROLE_KEY") };
for (const bucket of Object.values(DEFAULT_BUCKETS)) {
  // Emptying a large bucket runs in the background on Supabase; try the delete a few times.
  for (let attempt = 1; ; attempt++) {
    try {
      await emptyAndDeleteBucket(options, bucket);
      console.log(`deleted bucket ${bucket}`);
      break;
    } catch (error) {
      if (attempt >= 6) throw error;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

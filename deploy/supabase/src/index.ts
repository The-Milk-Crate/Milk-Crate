// The Supabase implementations of core/src/platform/.
export { postgresDatabase, DatabaseError, type ClosableDatabase } from "./database.ts";
export { supabaseIdentity } from "./identity.ts";
export { supabaseStorage, StorageError, DEFAULT_BUCKETS, type Buckets } from "./storage.ts";
export { supabaseJobs, type ApplyJobResult } from "./jobs.ts";
export { flyMachines } from "./fly.ts";
export { supabaseSchedules } from "./schedules.ts";
export { edgeFunctions } from "./functions.ts";
export { supabaseSecretsAndEmail } from "./secrets-email.ts";
export { supabaseInfrastructure, confirmDeployment } from "./infrastructure.ts";
export { createSupabaseModules } from "./modules.ts";
export { parseFileSize, CONTRACT_MASTER_MAX_BYTES } from "./size.ts";

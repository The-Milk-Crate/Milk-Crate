import type { Identity } from "./identity";
import type { ObjectStorage } from "./storage";
import type { Jobs } from "./jobs";
import type { Schedules } from "./schedules";
import type { SecretsAndEmail } from "./secrets-email";

export type * from "./types";
export type * from "./identity";
export type * from "./storage";
export type * from "./playback";
export type * from "./jobs";
export type * from "./schedules";
export type * from "./functions";
export type * from "./secrets-email";
export type * from "./infrastructure";

/** What a handler in the shared core is given. */
export interface Modules {
  identity: Identity;
  storage: ObjectStorage;
  jobs: Jobs;
  schedules: Schedules;
  secretsAndEmail: SecretsAndEmail;
}

// The account sync (Lambda, Node 22): puts every Cognito user in the group their api_accounts
// row names, and in no group without a row or when suspended. Runs every 15 minutes (the
// stack's schedule) and by hand (scripts/sync-accounts.sh). With { "userId": "<sub>" } it syncs
// one user. See src/accounts.ts.
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { required } from "../src/env.ts";
import { databaseFromEnv } from "../src/modules.ts";
import { syncAccounts, syncOneAccount } from "../src/accounts.ts";

const env = (name: string) => process.env[name];

export async function handler(event: { userId?: string } = {}) {
  const deps = {
    database: databaseFromEnv(env),
    cognito: new CognitoIdentityProviderClient({ region: env("AWS_REGION") }),
    userPoolId: required(env, "MC_COGNITO_USER_POOL_ID"),
  };
  return event?.userId ? syncOneAccount(deps, event.userId) : syncAccounts(deps);
}

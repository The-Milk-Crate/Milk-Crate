// Cognito's post-confirmation trigger (Lambda, Node 22). See src/accounts.ts.
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { databaseFromEnv } from "../src/modules.ts";
import { postConfirmation, type PostConfirmationEvent } from "../src/accounts.ts";

const env = (name: string) => process.env[name];
let deps: Parameters<typeof postConfirmation>[0] | undefined;

export async function handler<E extends PostConfirmationEvent>(event: E): Promise<E> {
  deps ??= {
    database: databaseFromEnv(env),
    cognito: new CognitoIdentityProviderClient({ region: env("AWS_REGION") }),
    // The pool is the one that called: the stack cannot pass its own id without a loop.
    userPoolId: event.userPoolId,
  };
  return postConfirmation({ ...deps, userPoolId: event.userPoolId }, event);
}

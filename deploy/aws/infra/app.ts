// The CDK app. The stand-up runs it with settings from the shell and the settings file
// (scripts/settings.env.example); nothing here holds a real value.
//
//   npx cdk synth   (from deploy/aws; cdk.json points here)
import { readFileSync } from "node:fs";
import { App } from "aws-cdk-lib";
import { MilkCrateStack, readRoutes } from "./stack.ts";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see scripts/settings.env.example)`);
  return value;
};

const app = new App();
new MilkCrateStack(
  app,
  process.env.MC_STACK_NAME || "MilkCratePhase0",
  {
    emailDomain: env("MC_EMAIL_DOMAIN"),
    emailFrom: env("MC_EMAIL_FROM"),
    cloudFrontPublicKeyPem: readFileSync(env("MC_CLOUDFRONT_PUBLIC_KEY_FILE"), "utf8").trim(),
    uploadOrigins: process.env.MC_UPLOAD_ORIGINS ? process.env.MC_UPLOAD_ORIGINS.split(",").map((s) => s.trim()) : undefined,
  },
  readRoutes(),
  // No account or region in the stack: the stand-up checks the account and region it deploys
  // to (scripts/stand-up.sh) and sets AWS_REGION. This also lets the tests synthesize offline.
  { description: "Milk Crate Phase 0 (session F)" },
);
app.synth();

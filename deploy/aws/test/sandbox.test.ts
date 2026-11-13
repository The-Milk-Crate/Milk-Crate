// The sandbox run from GitHub: the OIDC role template, the workflow's safety properties, the
// settings script and the scripts' non-interactive switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dirname;
const root = join(here, "../../..");
const scripts = join(here, "../scripts");
const workflow = readFileSync(join(root, ".github/workflows/aws-sandbox.yml"), "utf8");
const template = JSON.parse(readFileSync(join(here, "../infra/github-oidc.json"), "utf8"));

test("the OIDC role trusts only this repository's aws-sandbox environment, for 3 hours", () => {
  const role = template.Resources.SandboxRole.Properties;
  const [statement] = role.AssumeRolePolicyDocument.Statement;
  assert.equal(role.AssumeRolePolicyDocument.Statement.length, 1);
  assert.equal(statement.Action, "sts:AssumeRoleWithWebIdentity");
  assert.deepEqual(statement.Condition, {
    StringEquals: {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": "repo:The-Milk-Crate@353489113/Milk-Crate@1421168430:environment:aws-sandbox",
    },
  });
  assert.ok(!JSON.stringify(statement).includes("StringLike"), "no wildcard trust");
  assert.equal(role.MaxSessionDuration, 10800);
  // No IAM changes (PowerUserAccess) beyond passing the stack's own roles to the worker task.
  assert.deepEqual(role.ManagedPolicyArns, [{ "Fn::Sub": "arn:${AWS::Partition}:iam::aws:policy/PowerUserAccess" }]);
  const pass = role.Policies[0].PolicyDocument.Statement[0];
  assert.equal(pass.Action, "iam:PassRole");
  assert.deepEqual(pass.Condition, { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } });
  assert.match(pass.Resource["Fn::Sub"], /:role\/MilkCratePhase0-\*$/);
  assert.ok(!JSON.stringify(template).includes("AdministratorAccess"));
});

test("the workflow runs only on its two branches, needs the approved environment, and holds no secrets", () => {
  const on = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
  assert.match(on, /push:\s+branches: \[aws-sandbox-run, aws-sandbox-teardown\]/);
  assert.ok(!/pull_request|workflow_dispatch|schedule|workflow_run|repository_dispatch/.test(on), on);
  assert.match(workflow, /\npermissions:\n {2}contents: read\n {2}id-token: write/);
  assert.match(workflow, /\n {4}environment: aws-sandbox\n/);
  assert.ok(!/\$\{\{\s*secrets\./.test(workflow), "no GitHub secrets");
  // Every action pinned to a full commit.
  const uses = [...workflow.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 3);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
  // The session length asked for fits the role's maximum.
  const asked = Number(/role-duration-seconds: (\d+)/.exec(workflow)?.[1]);
  assert.ok(asked > 0 && asked <= template.Resources.SandboxRole.Properties.MaxSessionDuration);
  // No expression inside a run: line (inputs go through env).
  const lines = workflow.split("\n");
  const runLines: string[] = [];
  lines.forEach((line, i) => {
    const m = /^(\s+)run:(.*)$/.exec(line);
    if (!m) return;
    runLines.push(line);
    if (m[2].trim() !== "|") return;
    for (let j = i + 1; j < lines.length && (lines[j].trim() === "" || lines[j].search(/\S/) > m[1].length); j++) runLines.push(lines[j]);
  });
  assert.ok(runLines.length >= 6);
  for (const line of runLines) assert.ok(!line.includes("${{"), line);
  // Tear-down runs after a failure too, unless the run is kept.
  assert.match(workflow, /if: always\(\) && \(env\.MODE == 'teardown' \|\| env\.MC_SANDBOX_KEEP != 'true'\)/);
});

test("ci-settings.sh writes private settings and a matching key pair outside the repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-ci-"));
  try {
    const env = { ...process.env, MC_AWS_ACCOUNT: "123456789012", MC_AWS_REGION: "eu-west-2", MC_EMAIL_DOMAIN: "example.com" };
    const file = execFileSync("bash", [join(scripts, "ci-settings.sh"), join(dir, "out")], { env, encoding: "utf8" }).trim();
    assert.equal(file, join(dir, "out/aws.settings.env"));
    const settings = readFileSync(file, "utf8");
    assert.match(settings, /^MC_AWS_ACCOUNT=123456789012$/m);
    assert.match(settings, /^MC_EMAIL_FROM=Milk Crate <noreply@example\.com>$/m);
    assert.match(settings, /^MC_OUTPUTS_FILE=.*\/out\/outputs\.json$/m);
    for (const f of ["aws.settings.env", "cloudfront-private.pem", "cloudfront-public.pem"]) {
      assert.equal(statSync(join(dir, "out", f)).mode & 0o077, 0, `${f} is private`);
    }
    const derived = execFileSync("openssl", ["rsa", "-in", join(dir, "out/cloudfront-private.pem"), "-pubout"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    assert.equal(derived, readFileSync(join(dir, "out/cloudfront-public.pem"), "utf8"));
    // Refused: a folder inside the repository (and nothing is made there), or missing variables.
    const inside = spawnSync("bash", [join(scripts, "ci-settings.sh"), join(root, "deploy/aws/tmp-ci")], { env, encoding: "utf8" });
    assert.equal(inside.status, 2);
    assert.throws(() => statSync(join(root, "deploy/aws/tmp-ci")));
    const { MC_EMAIL_DOMAIN: _drop, ...noDomain } = env;
    const missing = spawnSync("bash", [join(scripts, "ci-settings.sh"), join(dir, "x")], { env: noDomain, encoding: "utf8" });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /MC_EMAIL_DOMAIN/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs confirm_target from lib.sh with a stub `aws` that reports `account`. */
function confirm(env: Record<string, string>, account = "123456789012") {
  const dir = mkdtempSync(join(tmpdir(), "mc-lib-"));
  try {
    writeFileSync(join(dir, "aws"), `#!/usr/bin/env bash\necho ${account}\n`);
    chmodSync(join(dir, "aws"), 0o755);
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GITHUB_") && k !== "MC_NONINTERACTIVE"));
    return spawnSync(
      "bash",
      ["-c", `source "${join(scripts, "lib.sh")}" && confirm_target "This changes things:" && echo PASSED`],
      {
        env: { ...clean, PATH: `${dir}:${process.env.PATH}`, MC_AWS_ACCOUNT: "123456789012", MC_AWS_REGION: "eu-west-2", MC_STACK_NAME: "S", ...env },
        input: "",
        encoding: "utf8",
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the scripts skip the typed confirmation only inside GitHub Actions with MC_NONINTERACTIVE=1", () => {
  const ci = { MC_NONINTERACTIVE: "1", GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "42" };
  const approved = confirm(ci);
  assert.equal(approved.status, 0, approved.stderr);
  assert.match(approved.stdout, /approved in the aws-sandbox environment/);
  assert.match(approved.stdout, /PASSED/);
  // Without any one of the three, it asks; with no answer, it stops.
  for (const drop of Object.keys(ci)) {
    const { [drop]: _gone, ...partial } = ci as Record<string, string>;
    const asked = confirm(partial);
    assert.notEqual(asked.status, 0, `without ${drop}`);
    assert.doesNotMatch(asked.stdout, /PASSED/);
  }
  // The account check still applies in the workflow.
  const wrong = confirm(ci, "999999999999");
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /credentials are for account 999999999999/);
});

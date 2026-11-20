// Both platforms' worker images carry this step the same way (decision 8): the same pinned base
// image and ffmpeg line, the copy of worker/src/ in _worker/, and main.ts passing the step in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const platforms = ["deploy/supabase", "deploy/aws"] as const;

function lines(dockerfile: string, start: RegExp): string[] {
  return dockerfile.split("\n").filter((l) => start.test(l));
}

test("the two worker Dockerfiles have the same pinned base image and the same ffmpeg line", () => {
  const [fly, fargate] = platforms.map((p) => read(`${p}/worker/Dockerfile`));
  const from = lines(fly, /^FROM /);
  assert.equal(from.length, 1);
  assert.match(from[0], /^FROM node:22\.\d+\.\d+-bookworm-slim@sha256:[0-9a-f]{64}$/, "pinned by version and digest");
  assert.deepEqual(lines(fargate, /^FROM /), from);
  const ffmpeg = lines(fly, /ffmpeg/).filter((l) => !l.startsWith("#"));
  assert.equal(ffmpeg.length, 1);
  assert.match(ffmpeg[0], /^RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg /);
  assert.deepEqual(lines(fargate, /ffmpeg/).filter((l) => !l.startsWith("#")), ffmpeg);
});

test("each image copies _worker/, which its copy-core.sh makes from worker/src/", () => {
  for (const p of platforms) {
    assert.ok(read(`${p}/worker/Dockerfile`).includes("\nCOPY _worker ./_worker\n"), p);
    const copy = read(`${p}/scripts/copy-core.sh`);
    assert.match(copy, /worker_src="\$\(cd "\$pkg\/\.\.\/\.\.\/worker\/src" && pwd\)"/, p);
    assert.match(copy, /cp -R "\$worker_src\/\." "\$pkg\/_worker\/"/, p);
    assert.match(read(`${p}/.gitignore`), /^_worker\/$/m, `${p}: the copy is not committed`);
  }
});

test("each worker passes the shared step to its skeleton, not the placeholder", () => {
  for (const p of platforms) {
    const main = read(`${p}/worker/main.ts`);
    assert.match(main, /import \{ makeProcessRelease \} from "\.\.\/_worker\/index\.ts";/, p);
    assert.match(main, /process: makeProcessRelease\(\{ database[^}]*storage[^}]*\}\),/, p);
    assert.ok(!main.includes("processingNotBuilt"), p);
  }
});

// The Edge Function's deno.lock (security review L9): it pins exactly the packages in deno.json,
// with the same hashes as package-lock.json, and nothing else (no _core/, no remote modules).
// Remake it as deploy/supabase/README.md says ("Edge Function dependencies").
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const lock = read("../supabase/functions/deno.lock");
const denoJson = read("../supabase/functions/deno.json");
const packageLock = read("../package-lock.json");
const imports = Object.values(denoJson.imports as Record<string, string>).sort();

describe("the Edge Function's deno.lock", () => {
  test("is lock version 4, which the deploy's edge-runtime (Deno 2.1.4) reads", () => {
    assert.equal(lock.version, "4");
  });

  test("lists exactly the npm imports in deno.json, and nothing else", () => {
    assert.ok(imports.length > 0 && imports.every((s) => /^npm:[^@]+@\d+\.\d+\.\d+$/.test(s)), "deno.json imports exact npm versions");
    assert.deepEqual(Object.keys(lock).sort(), ["npm", "specifiers", "version", "workspace"]);
    assert.deepEqual(Object.keys(lock.specifiers).sort(), imports);
    assert.deepEqual([...lock.workspace.dependencies].sort(), imports);
    const pinned = imports.map((s) => s.slice("npm:".length));
    assert.deepEqual(Object.keys(lock.npm).sort(), pinned.sort(), "no other packages (both have no dependencies)");
    assert.doesNotMatch(JSON.stringify(lock), /_core/);
  });

  test("has the same hash for each package as package-lock.json", () => {
    for (const [key, entry] of Object.entries(lock.npm as Record<string, { integrity: string }>)) {
      const at = key.lastIndexOf("@");
      const [name, version] = [key.slice(0, at), key.slice(at + 1)];
      const node = packageLock.packages[`node_modules/${name}`];
      assert.ok(node, `${name} is in package-lock.json`);
      assert.equal(node.version, version, `${name}: the same version in package-lock.json`);
      assert.match(entry.integrity, /^sha512-/);
      assert.equal(entry.integrity, node.integrity, `${name}: the same hash in package-lock.json`);
    }
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_MASTER_MAX_BYTES, parseFileSize } from "../src/size.ts";

test("MC_FILE_SIZE_LIMIT: 5 GiB by default, 50 MiB on the free project, never above 5 GiB", () => {
  assert.equal(parseFileSize(undefined), CONTRACT_MASTER_MAX_BYTES);
  assert.equal(parseFileSize(""), CONTRACT_MASTER_MAX_BYTES);
  assert.equal(parseFileSize("50MiB"), 52428800);
  assert.equal(parseFileSize("50mb"), 50_000_000);
  assert.equal(parseFileSize("5GiB"), 5368709120);
  assert.equal(parseFileSize("500GB"), CONTRACT_MASTER_MAX_BYTES);
  assert.throws(() => parseFileSize("fifty"), /look like 50MiB/);
  assert.throws(() => parseFileSize("0MiB"), /bad MC_FILE_SIZE_LIMIT/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { Crc64Nvme, crc64nvme } from "../src/crc64nvme.ts";

test("CRC-64/NVME: the standard check value for 123456789", () => {
  const hex = Buffer.from(new Crc64Nvme().update(new TextEncoder().encode("123456789")).digest()).toString("hex");
  assert.equal(hex, "ae8b14860a799888");
  assert.equal(crc64nvme(new TextEncoder().encode("123456789")), Buffer.from("ae8b14860a799888", "hex").toString("base64"));
});

test("CRC-64/NVME: empty input, and updating in pieces equals one pass", () => {
  assert.equal(Buffer.from(new Crc64Nvme().digest()).toString("hex"), "0000000000000000");
  const data = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 31 + 7) & 0xff);
  const whole = crc64nvme(data);
  const pieces = new Crc64Nvme().update(data.subarray(0, 1000)).update(data.subarray(1000, 2_000_001)).update(data.subarray(2_000_001)).base64();
  assert.equal(pieces, whole);
  assert.match(whole, /^[A-Za-z0-9+/]{11}=$/);
});

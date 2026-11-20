// Every operation's allowed and refused account types, read from x-account-types in the contract.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AccountType } from "../src/platform/index.ts";
import type { OperationId } from "../src/handlers/index.ts";
import { account, db, harness, seedRelease, uuid, type Account, type CallInput, type Seeded } from "./helpers.ts";

after(() => db.close());

const TYPES: AccountType[] = ["end_user", "artist", "third_party", "administrator", "internal", "internal_accounting"];

/** operationId → x-account-types, from api/openapi.yaml (no YAML library: the lines are simple). */
function contractAccountTypes(): Map<string, AccountType[]> {
  const text = readFileSync(new URL("../../api/openapi.yaml", import.meta.url), "utf8");
  const out = new Map<string, AccountType[]>();
  let current: string | null = null;
  for (const line of text.split("\n")) {
    const op = /^\s+operationId:\s*(\w+)/.exec(line);
    if (op) current = op[1];
    const types = /^\s+x-account-types:\s*\[([^\]]*)\]/.exec(line);
    if (types && current) {
      out.set(current, types[1].split(",").map((t) => t.trim()) as AccountType[]);
      current = null;
    }
  }
  return out;
}

const allowedByContract = contractAccountTypes();

function request(op: OperationId, s: Seeded): CallInput {
  const releaseId = s.releaseId;
  const trackId = s.trackIds[0];
  const code = { inviteCode: "x".repeat(20) };
  switch (op) {
    case "createRelease":
      return { body: { title: "P", releaseDate: "2026-01-01", tracks: [{ title: "A" }] } };
    case "getRelease":
    case "getPublicRelease":
    case "getCover":
    case "submitRelease":
    case "publishRelease":
      return { params: { releaseId } };
    case "updateRelease":
      return { params: { releaseId }, body: { title: "Q" } };
    case "listReleases":
      return {};
    case "startUpload":
      return { params: { releaseId, trackId }, body: { format: "wav", sizeBytes: 10 } };
    case "startCoverUpload":
      return { params: { releaseId }, body: { format: "png", sizeBytes: 10 } };
    case "getUpload":
      return { params: { uploadId: s.uploadId } };
    case "signUploadParts":
      return { params: { uploadId: s.uploadId }, body: { partNumbers: [1] } };
    case "confirmUpload":
      return { params: { uploadId: s.uploadId }, body: { sha256: "a".repeat(64) } };
    case "putRights":
      return {
        params: { releaseId },
        body: {
          parties: [
            { side: "recording", role: "a", name: "Me", percent: 100 },
            { side: "composition", role: "w", name: "Me", percent: 100 },
          ],
        },
      };
    case "getInvitation":
      return { params: { releaseId, partyId: uuid() }, body: code };
    case "respondToSplit":
      return { params: { releaseId, partyId: uuid() }, body: { response: "accept", ...code } };
    case "resendInvitation":
      return { params: { releaseId, partyId: uuid() } };
    case "reviewRelease":
      return { params: { releaseId }, body: { decision: "approve" } };
    case "takedownRelease":
      return { params: { releaseId }, body: { reason: "Test." } };
    case "getPlayback":
      return { params: { trackId } };
    case "recordPlays":
      return {
        headers: { "idempotency-key": uuid() },
        body: { events: [{ type: "start", trackId, playId: uuid(), positionMs: 0, occurredAt: "2026-06-01T12:00:00Z" }] },
      };
  }
}

describe("account types per operation (x-account-types)", () => {
  const h = harness();
  let owner: Account;
  const callers = new Map<AccountType, Account>();
  before(async () => {
    owner = await account("artist");
    for (const type of TYPES) callers.set(type, type === "artist" ? owner : await account(type));
  });

  it("the contract lists 21 operations and the core has a handler for each", () => {
    assert.equal(allowedByContract.size, 21);
    assert.deepEqual([...allowedByContract.keys()].sort(), Object.keys(h.ops).sort());
  });

  for (const [op, allowed] of allowedByContract) {
    it(`${op}: ${allowed.join(", ")}`, async () => {
      const wrong: string[] = [];
      for (const type of TYPES) {
        const s = await seedRelease(owner, "draft");
        const r = await h.call(op as OperationId, { as: callers.get(type), ...request(op as OperationId, s) });
        const refused = r.status === 403 && r.body.code === "forbidden";
        if (allowed.includes(type) === refused || r.status === 401 || r.status === 400 || r.status === 500) {
          wrong.push(`${type}: ${r.status} ${JSON.stringify(r.body)}`);
        }
      }
      assert.deepEqual(wrong, []);
    });
  }

  it("with no token every operation is 401", async () => {
    const s = await seedRelease(owner, "draft");
    for (const op of allowedByContract.keys()) {
      const r = await h.call(op as OperationId, request(op as OperationId, s));
      assert.equal(r.status, 401, op);
    }
  });
});

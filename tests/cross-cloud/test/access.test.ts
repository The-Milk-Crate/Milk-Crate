// Session C's fixture, db/test/access-expected.json, cell by cell on both module sets. Each side
// must match the fixture itself, not only the other side. The file is read at run time, so a
// change to it shows up here; a new operation in it with no driver fails.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AccountType, ReleaseState } from "../../../core/src/platform/index.ts";
import { makeDeployment, SIDES, type Account, type MockDeployment, type Side } from "../lib/mocks.ts";
import { expireInvitation, seedRelease, type Seeded } from "../lib/seed.ts";

const fixture = JSON.parse(readFileSync(new URL("../../../db/test/access-expected.json", import.meta.url), "utf8")) as {
  accountTypes: AccountType[];
  states: ReleaseState[];
  operations: Record<string, { byAccountType: Record<string, Partial<Record<"own" | "other", Record<string, ReleaseState[]>>>> }>;
  invitation: {
    callers: Record<AccountType, "allowed" | number>;
    cases: Record<string, { status: string; getInvitation: number; respondToSplit: number }>;
    invitationFields: string[];
  };
};

interface World {
  d: MockDeployment;
  owner: Account;
  callers: Map<AccountType, Account>;
  seeded: Map<ReleaseState, Seeded>;
}
const worlds = new Map<Side, World>();

before(async () => {
  for (const side of SIDES) {
    const d = await makeDeployment(side);
    const owner = await d.account("artist");
    const callers = new Map<AccountType, Account>();
    for (const type of fixture.accountTypes) callers.set(type, await d.account(type));
    const seeded = new Map<ReleaseState, Seeded>();
    for (const state of fixture.states) seeded.set(state, await seedRelease(d, owner, state));
    worlds.set(side, { d, owner, callers, seeded });
  }
});
after(async () => {
  for (const w of worlds.values()) await w.d.close();
});

async function listed(w: World, as: Account, state: ReleaseState, releaseId: string): Promise<string> {
  let cursor: string | undefined;
  for (;;) {
    const r = await w.d.api.call("listReleases", { token: as.token, query: { state, limit: "100", ...(cursor ? { cursor } : {}) } });
    if (r.status !== 200) return String(r.status);
    if (r.body.items.some((i: { id: string }) => i.id === releaseId)) return "listed";
    if (!r.body.nextCursor) return "not_listed";
    cursor = r.body.nextCursor;
  }
}

async function outcome(w: World, op: string, as: Account, s: Seeded, state: ReleaseState): Promise<string> {
  const api = w.d.api;
  const t = as.token;
  switch (op) {
    case "getRelease":
      return String((await api.call(op, { token: t, params: { releaseId: s.releaseId } })).status);
    case "getPublicRelease":
      return String((await api.call(op, { token: t, params: { releaseId: s.releaseId } })).status);
    case "getPlayback":
      return String((await api.call(op, { token: t, params: { trackId: s.trackIds[0] } })).status);
    case "getCover":
      return String((await api.call(op, { token: t, params: { releaseId: s.releaseId } })).status);
    case "getUpload":
      return String((await api.call(op, { token: t, params: { uploadId: s.openUploadId } })).status);
    case "listReleases":
      return listed(w, as, state, s.releaseId);
    case "recordPlays": {
      const playId = crypto.randomUUID();
      const r = await api.call(op, {
        token: t,
        headers: { "idempotency-key": crypto.randomUUID() },
        body: {
          events: [
            { type: "start", trackId: s.trackIds[0], playId, positionMs: 0, occurredAt: "2026-06-01T12:00:00Z" },
            { type: "end", trackId: s.trackIds[0], playId, positionMs: 31000, occurredAt: "2026-06-01T12:00:31Z" },
          ],
        },
      });
      if (r.status !== 202) return String(r.status);
      const [{ events, qualified }] = await w.d.db.query<{ events: number; qualified: number }>(
        `select (select count(*)::int from public.api_play_events where play_id = $1::uuid) as events,
                (select count(*)::int from public.api_qualified_streams where play_id = $1::uuid) as qualified`,
        [playId],
      );
      if (events !== 2) return `kept ${events} events`;
      return qualified === 1 ? "qualifies" : "kept";
    }
    default:
      throw new Error(`no driver for ${op} in this test: add one`);
  }
}

describe("read access from db/test/access-expected.json, on both module sets", () => {
  for (const side of SIDES) {
    for (const [op, spec] of Object.entries(fixture.operations)) {
      for (const [type, cells] of Object.entries(spec.byAccountType)) {
        for (const [whose, outcomes] of Object.entries(cells) as ["own" | "other", Record<string, ReleaseState[]>][]) {
          test(`${side}: ${op}, ${type}, ${whose} release`, async () => {
            const w = worlds.get(side)!;
            const as = whose === "own" ? w.owner : w.callers.get(type as AccountType)!;
            if (whose === "own") assert.equal(type, "artist", "only an artist owns a release");
            const seen: string[] = [];
            for (const [want, states] of Object.entries(outcomes)) {
              for (const state of states) {
                const got = await outcome(w, op, as, w.seeded.get(state)!, state);
                if (got !== want) seen.push(`${state}: want ${want}, got ${got}`);
              }
            }
            assert.deepEqual(seen, []);
          });
        }
      }
    }
  }

  test("the fixture covers every account type and every state in each cell", () => {
    for (const [op, spec] of Object.entries(fixture.operations)) {
      assert.deepEqual(Object.keys(spec.byAccountType).sort(), [...fixture.accountTypes].sort(), op);
      for (const cells of Object.values(spec.byAccountType)) {
        for (const outcomes of Object.values(cells)) assert.deepEqual(Object.values(outcomes!).flat().sort(), [...fixture.states].sort(), op);
      }
    }
  });
});

describe("invitations from the fixture (getInvitation and respondToSplit), on both module sets", () => {
  /** A release in awaiting_splits with one invited party per case, through putRights. */
  async function invitations(w: World, n: number) {
    const s = await seedRelease(w.d, w.owner, "awaiting_splits");
    const emails = Array.from({ length: n }, (_, i) => `fixture-${i}-${s.releaseId.slice(0, 8)}@example.com`);
    const r = await w.d.api.call("putRights", {
      token: w.owner.token,
      params: { releaseId: s.releaseId },
      body: {
        parties: [
          { side: "recording", role: "artist", name: "Owner", percent: 100 },
          ...emails.map((email, i) => ({ side: "composition", role: "songwriter", name: `P${i}`, email, percent: i === 0 ? 100 - (n - 1) : 1 })),
        ],
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const parties = emails.map((email) => {
      const p = (r.body.parties as { id: string; email?: string }[]).find((x) => x.email === email)!;
      const text = w.d.emails.filter((e) => e.to === email).at(-1)!.text;
      return { id: p.id, code: /Your invite code: (\S+)/.exec(text)![1] };
    });
    return { releaseId: s.releaseId, parties };
  }

  for (const side of SIDES) {
    test(`${side}: each case gives the fixture's status on the view and on the reply`, async () => {
      const w = worlds.get(side)!;
      const listener = w.callers.get("end_user")!;
      const seen: string[] = [];
      for (const [name, want] of Object.entries(fixture.invitation.cases)) {
        for (const op of ["getInvitation", "respondToSplit"] as const) {
          const { releaseId, parties } = await invitations(w, 1);
          const party = parties[0];
          let code = party.code;
          let partyId = party.id;
          if (name === "wrong_code") code = "wrong-0123456789abcdef";
          if (name === "expired") await expireInvitation(w.d, party.id);
          if (name === "not_found") partyId = crypto.randomUUID();
          if (name === "replied") {
            const r = await w.d.api.call("respondToSplit", { token: listener.token, params: { releaseId, partyId }, body: { response: "accept", inviteCode: code } });
            assert.equal(r.status, 200);
          }
          if (name === "taken_down") {
            const admin = w.callers.get("administrator")!;
            const r = await w.d.api.call("takedownRelease", { token: admin.token, params: { releaseId }, body: { reason: "Fixture." } });
            assert.equal(r.status, 200);
          }
          if (name === "rate_limited") {
            for (let i = 0; i < 10; i++) {
              await w.d.api.call("getInvitation", { token: listener.token, params: { releaseId, partyId }, body: { inviteCode: `wrong-${i}-0123456789abcdef` } });
            }
          }
          const body = op === "getInvitation" ? { inviteCode: code } : { response: "accept", inviteCode: code };
          const r = await w.d.api.call(op, { token: listener.token, params: { releaseId, partyId }, body });
          if (r.status !== want[op]) seen.push(`${name}, ${op}: want ${want[op]}, got ${r.status} ${r.body?.code ?? ""}`);
          if (r.status === 200 && op === "getInvitation") {
            const fields = [...Object.keys(r.body).filter((k) => k !== "party"), ...Object.keys(r.body.party).map((k) => `party.${k}`)].sort();
            if (JSON.stringify(fields) !== JSON.stringify([...fixture.invitation.invitationFields].sort())) seen.push(`${name}: fields ${fields.join(", ")}`);
          }
          if (r.status !== 200 && r.body && ("party" in r.body || "releaseTitle" in r.body)) seen.push(`${name}, ${op}: fields on a refusal`);
        }
      }
      assert.deepEqual(seen, []);
    });

    test(`${side}: callers by account type as the fixture says`, async () => {
      const w = worlds.get(side)!;
      const seen: string[] = [];
      for (const [type, want] of Object.entries(fixture.invitation.callers) as [AccountType, "allowed" | number][]) {
        const { releaseId, parties } = await invitations(w, 2);
        const as = w.callers.get(type)!;
        const view = await w.d.api.call("getInvitation", { token: as.token, params: { releaseId, partyId: parties[0].id }, body: { inviteCode: parties[0].code } });
        const reply = await w.d.api.call("respondToSplit", { token: as.token, params: { releaseId, partyId: parties[1].id }, body: { response: "accept", inviteCode: parties[1].code } });
        const expect = want === "allowed" ? 200 : want;
        if (view.status !== expect) seen.push(`${type}, getInvitation: want ${expect}, got ${view.status}`);
        if (reply.status !== expect) seen.push(`${type}, respondToSplit: want ${expect}, got ${reply.status}`);
      }
      assert.deepEqual(seen, []);
    });
  }
});

describe("the staff row check (settled with session C), on both module sets", () => {
  for (const side of SIDES) {
    test(`${side}: a staff token whose row was removed, changed or suspended acts as end_user at once`, async () => {
      const w = worlds.get(side)!;
      const draft = w.seeded.get("draft")!;
      const live = w.seeded.get("live")!;
      const review = w.seeded.get("awaiting_review")!;
      const removed = await w.d.account("administrator");
      await w.d.db.query("delete from public.api_accounts where user_id = $1::uuid", [removed.userId]);
      const changed = await w.d.account("internal_accounting");
      const suspended = await w.d.account("administrator", { suspended: true });
      const stale = [
        { name: "removed", token: removed.token },
        { name: "changed type", token: await w.d.token(changed.userId, "administrator") },
        { name: "suspended", token: await w.d.token(suspended.userId, "administrator") },
      ];
      const seen: string[] = [];
      for (const s of stale) {
        const calls: [string, Record<string, unknown>, number][] = [
          ["getRelease", { params: { releaseId: draft.releaseId } }, 403],
          ["listReleases", {}, 403],
          ["getPlayback", { params: { trackId: draft.trackIds[0] } }, 404],
          ["getCover", { params: { releaseId: draft.releaseId } }, 404],
          ["getPlayback", { params: { trackId: live.trackIds[0] } }, 200],
          ["reviewRelease", { params: { releaseId: review.releaseId }, body: { decision: "approve" } }, 403],
          ["takedownRelease", { params: { releaseId: draft.releaseId }, body: { reason: "test" } }, 403],
        ];
        for (const [op, input, want] of calls) {
          const r = await w.d.api.call(op, { ...input, token: s.token });
          if (r.status !== want) seen.push(`${s.name}: ${op} want ${want}, got ${r.status}`);
        }
      }
      // A new role waits for the token refresh: the row says administrator, the token end_user.
      const fresh = await w.d.account("administrator");
      const early = await w.d.api.call("getRelease", { token: await w.d.token(fresh.userId, "end_user"), params: { releaseId: draft.releaseId } });
      if (early.status !== 403) seen.push(`new role before refresh: getRelease want 403, got ${early.status}`);
      assert.deepEqual(seen, []);
    });
  }
});

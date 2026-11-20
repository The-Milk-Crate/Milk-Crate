// putRights, the 100-percent rule, invite codes (single use, expiry, wrong codes, resend).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hashInviteCode } from "../src/handlers/index.ts";
import { account, db, harness, seedRelease, uuid, type Account } from "./helpers.ts";

after(() => db.close());

const OWN = [
  { side: "recording", role: "artist", name: "Me", percent: 50 },
  { side: "composition", role: "songwriter", name: "Me", percent: 100 },
];

async function withInvitee(h: ReturnType<typeof harness>, artist: Account, releaseId: string) {
  const r = await h.call("putRights", {
    as: artist,
    params: { releaseId },
    body: { parties: [...OWN, { side: "recording", role: "producer", name: "Pro", email: "pro@example.invalid", percent: 50 }] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const party = r.body.parties.find((p: { name: string }) => p.name === "Pro");
  const mail = h.modules.secretsAndEmail.sent.filter((m) => m.template === "split_invitation").at(-1)!;
  return { partyId: party.id as string, code: mail.data.inviteCode, parties: r.body.parties };
}

describe("putRights", () => {
  it("the 100-percent rule: each side adds up to exactly 100", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    for (const parties of [
      [{ side: "recording", role: "artist", name: "Me", percent: 99.99 }, { side: "composition", role: "w", name: "Me", percent: 100 }],
      [{ side: "recording", role: "artist", name: "Me", percent: 100 }],
      [
        { side: "recording", role: "artist", name: "Me", percent: 60 },
        { side: "recording", role: "artist", name: "B", email: "b@example.invalid", percent: 40.01 },
        { side: "composition", role: "w", name: "Me", percent: 100 },
      ],
    ]) {
      const r = await h.call("putRights", { as: artist, params: { releaseId: s.releaseId }, body: { parties } });
      assert.equal(r.status, 422, JSON.stringify(r.body));
      assert.equal(r.body.code, "shares_not_100");
    }
    const exact = await h.call("putRights", {
      as: artist,
      params: { releaseId: s.releaseId },
      body: {
        parties: [
          { side: "recording", role: "artist", name: "Me", percent: 33.33 },
          { side: "recording", role: "artist", name: "B", email: "b@example.invalid", percent: 33.33 },
          { side: "recording", role: "artist", name: "C", email: "c@example.invalid", percent: 33.34 },
          { side: "composition", role: "w", name: "Me", percent: 100 },
        ],
      },
    });
    assert.equal(exact.status, 200, JSON.stringify(exact.body));
    assert.deepEqual(exact.body.parties.map((p: { percent: number }) => p.percent), [33.33, 33.33, 33.34, 100]);
  });

  it("refuses bad shapes (400) and bad party lists (422)", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const bad400 = [
      { parties: [] },
      { parties: [{ ...OWN[0], percent: 10.001 }, OWN[1]] },
      { parties: [{ ...OWN[0], side: "mechanical" }, OWN[1]] },
      { parties: [{ ...OWN[0], email: "not-an-email" }, OWN[1]] },
      { parties: [{ ...OWN[0], name: "" }, OWN[1]] },
    ];
    for (const body of bad400) {
      const r = await h.call("putRights", { as: artist, params: { releaseId: s.releaseId }, body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    const unknown = await h.call("putRights", { as: artist, params: { releaseId: s.releaseId }, body: { parties: [{ ...OWN[0], id: uuid() }, OWN[1], { ...OWN[0], name: "B", email: "b@example.invalid", percent: 50 }] } });
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.code, "bad_parties");
  });

  it("keeps an unchanged party's state and code; a changed party is invited again with a new code", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const { partyId, code, parties } = await withInvitee(h, artist, s.releaseId);
    const invitee = await account("third_party");
    const ok = await h.call("respondToSplit", { as: invitee, params: { releaseId: s.releaseId, partyId }, body: { response: "accept", inviteCode: code } });
    assert.equal(ok.status, 200);

    // Send the same list back with ids: nothing changes, no new email.
    const before = h.modules.secretsAndEmail.sent.length;
    const same = await h.call("putRights", {
      as: artist,
      params: { releaseId: s.releaseId },
      body: { parties: parties.map((p: Record<string, unknown>) => ({ ...p, state: undefined })) },
    });
    assert.equal(same.status, 200, JSON.stringify(same.body));
    assert.equal(same.body.parties.find((p: { id: string }) => p.id === partyId).state, "accepted");
    assert.equal(h.modules.secretsAndEmail.sent.length, before);
    assert.deepEqual(same.body.parties.map((p: { id: string }) => p.id), parties.map((p: { id: string }) => p.id), "party ids are kept");

    // Change the producer's share: back to invited, with a new code by email.
    const changed = await h.call("putRights", {
      as: artist,
      params: { releaseId: s.releaseId },
      body: {
        parties: parties.map((p: { id: string; name: string; percent: number }) =>
          p.id === partyId ? { ...p, state: undefined, percent: 40 } : p.name === "Me" && p.percent === 50 ? { ...p, state: undefined, percent: 60 } : { ...p, state: undefined },
        ),
      },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.parties.find((p: { id: string }) => p.id === partyId).state, "invited");
    const owners = changed.body.parties.filter((p: { name: string }) => p.name === "Me");
    assert.ok(owners.every((p: { state: string }) => p.state === "accepted"), "the owner's share stays accepted");
    const mail = h.modules.secretsAndEmail.sent.at(-1)!;
    assert.equal(mail.template, "split_invitation");
    assert.notEqual(mail.data.inviteCode, code);
    const stale = await h.call("getInvitation", { as: invitee, params: { releaseId: s.releaseId, partyId }, body: { inviteCode: code } });
    assert.equal(stale.status, 403, "the old code stopped working");

    // Drop the producer: the party is removed.
    const dropped = await h.call("putRights", {
      as: artist,
      params: { releaseId: s.releaseId },
      body: { parties: [{ ...OWN[0], percent: 100 }, OWN[1]] },
    });
    assert.equal(dropped.status, 200);
    assert.equal(dropped.body.parties.length, 2);
  });

  it("a party needs an email, and the owner's share has none", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const { parties } = await withInvitee(h, artist, s.releaseId);
    const ownerParty = parties.find((p: { name: string; side: string }) => p.name === "Me" && p.side === "recording");
    const r = await h.call("putRights", {
      as: artist,
      params: { releaseId: s.releaseId },
      body: { parties: parties.map((p: { id: string }) => (p.id === ownerParty.id ? { ...p, state: undefined, email: "me@example.invalid" } : { ...p, state: undefined })) },
    });
    assert.equal(r.status, 422);
  });

  it("is the owner's only: another artist gets 404, staff and listeners 403", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const body = { parties: [{ ...OWN[0], percent: 100 }, OWN[1]] };
    assert.equal((await h.call("putRights", { as: await account("artist"), params: { releaseId: s.releaseId }, body })).status, 404);
    for (const type of ["end_user", "third_party", "administrator", "internal", "internal_accounting"] as const) {
      assert.equal((await h.call("putRights", { as: await account(type), params: { releaseId: s.releaseId }, body })).status, 403, type);
    }
  });
});

describe("invite codes", () => {
  it("hash as SHA-256 of the UTF-8 code, lowercase hex, as session C's wrappers do", async () => {
    for (const code of ["abcdefghijklmnop", "ünïcødé-code-1234567"]) {
      assert.equal(await hashInviteCode(code), createHash("sha256").update(code, "utf8").digest("hex"));
    }
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const { partyId, code } = await withInvitee(h, artist, s.releaseId);
    const [row] = await db.query<{ hash: string }>("select invite_code_hash as hash from public.api_parties where id = $1::uuid", [partyId]);
    assert.equal(row.hash, createHash("sha256").update(code, "utf8").digest("hex"));
    assert.equal(code.length, 43);
  });

  it("are single use: getInvitation does not use one up; respondToSplit does", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const { partyId, code } = await withInvitee(h, artist, s.releaseId);
    const invitee = await account("artist");
    for (let i = 0; i < 2; i++) {
      assert.equal((await h.call("getInvitation", { as: invitee, params: { releaseId: s.releaseId, partyId }, body: { inviteCode: code } })).status, 200);
    }
    const r = await h.call("respondToSplit", { as: invitee, params: { releaseId: s.releaseId, partyId }, body: { response: "decline", inviteCode: code } });
    assert.equal(r.status, 200);
    assert.equal(r.body.parties[0].state, "declined");
    const [linked] = await db.query<{ who: string }>("select responder_user_id::text as who from public.api_parties where id = $1::uuid", [partyId]);
    assert.equal(linked.who, invitee.userId, "the signed-in account is linked");
    const again = await h.call("respondToSplit", { as: invitee, params: { releaseId: s.releaseId, partyId }, body: { response: "accept", inviteCode: code } });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "already_replied");
    const view = await h.call("getInvitation", { as: invitee, params: { releaseId: s.releaseId, partyId }, body: { inviteCode: code } });
    assert.equal(view.status, 409);
  });

  it("expire after 14 days (403)", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const { partyId, code } = await withInvitee(h, artist, s.releaseId);
    await db.query(
      "update public.api_parties set invite_sent_at = now() - interval '15 days', invite_expires_at = now() - interval '1 day' where id = $1::uuid",
      [partyId],
    );
    const invitee = await account("end_user");
    for (const op of ["getInvitation", "respondToSplit"] as const) {
      const r = await h.call(op, { as: invitee, params: { releaseId: s.releaseId, partyId }, body: { response: "accept", inviteCode: code } });
      assert.equal(r.status, 403, op);
      assert.equal(r.body.code, "expired");
    }
  });

  it("wrong codes count per party across both calls; the 11th is 429 even with the right code", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const { partyId, code } = await withInvitee(h, artist, s.releaseId);
    const invitee = await account("end_user");
    for (let i = 0; i < 10; i++) {
      const op = i % 2 ? "getInvitation" : "respondToSplit";
      const r = await h.call(op, { as: invitee, params: { releaseId: s.releaseId, partyId }, body: { response: "accept", inviteCode: `wrong-code-number-${i}` } });
      assert.equal(r.status, 403, `${op} ${i}`);
      assert.equal(r.body.code, "wrong_code");
    }
    const locked = await h.call("respondToSplit", { as: invitee, params: { releaseId: s.releaseId, partyId }, body: { response: "accept", inviteCode: code } });
    assert.equal(locked.status, 429);
    assert.equal(locked.headers.get("retry-after"), "3600");
  });

  it("taken down is 409; no such party is 404; staff are 403; a short code is 400", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const { partyId, code } = await withInvitee(h, artist, s.releaseId);
    const invitee = await account("end_user");
    for (const type of ["administrator", "internal", "internal_accounting"] as const) {
      const r = await h.call("getInvitation", { as: await account(type), params: { releaseId: s.releaseId, partyId }, body: { inviteCode: code } });
      assert.equal(r.status, 403, type);
    }
    assert.equal((await h.call("getInvitation", { as: invitee, params: { releaseId: s.releaseId, partyId: uuid() }, body: { inviteCode: code } })).status, 404);
    assert.equal((await h.call("getInvitation", { as: invitee, params: { releaseId: s.releaseId, partyId }, body: { inviteCode: "short" } })).status, 400);
    assert.equal((await h.call("getInvitation", { params: { releaseId: s.releaseId, partyId }, body: { inviteCode: code } })).status, 401);
    await h.call("takedownRelease", { as: await account("administrator"), params: { releaseId: s.releaseId }, body: { reason: "Test." } });
    const r = await h.call("getInvitation", { as: invitee, params: { releaseId: s.releaseId, partyId }, body: { inviteCode: code } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "taken_down");
  });

  it("getInvitation shows only the release basics and this party's share", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const { partyId, code } = await withInvitee(h, artist, s.releaseId);
    const r = await h.call("getInvitation", { as: await account("end_user"), params: { releaseId: s.releaseId, partyId }, body: { inviteCode: code } });
    assert.equal(r.status, 200);
    const text = JSON.stringify(r.body);
    for (const never of [artist.userId, "pro@example.invalid", "Pro", code, "Me", "masters/"]) assert.ok(!text.includes(never), never);
    assert.deepEqual(Object.keys(r.body.party).sort(), ["percent", "role", "side", "state"]);
  });
});

describe("resendInvitation", () => {
  it("issues a new code and voids the old; only for invited parties; limited per day", async () => {
    const h = harness("tus", { inviteDailyLimit: 3 });
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const { partyId, code, parties } = await withInvitee(h, artist, s.releaseId);
    const r = await h.call("resendInvitation", { as: artist, params: { releaseId: s.releaseId, partyId } });
    assert.equal(r.status, 204);
    assert.equal(r.body, null);
    const fresh = h.modules.secretsAndEmail.sent.at(-1)!.data.inviteCode;
    assert.notEqual(fresh, code);
    const invitee = await account("end_user");
    assert.equal((await h.call("getInvitation", { as: invitee, params: { releaseId: s.releaseId, partyId }, body: { inviteCode: code } })).status, 403);
    assert.equal((await h.call("getInvitation", { as: invitee, params: { releaseId: s.releaseId, partyId }, body: { inviteCode: fresh } })).status, 200);

    // The first send counted, so two resends reach the limit of 3.
    assert.equal((await h.call("resendInvitation", { as: artist, params: { releaseId: s.releaseId, partyId } })).status, 204);
    const limited = await h.call("resendInvitation", { as: artist, params: { releaseId: s.releaseId, partyId } });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), String(12 * 3600), "until midnight UTC by the injected clock");

    const owner = parties.find((p: { name: string }) => p.name === "Me");
    assert.equal((await h.call("resendInvitation", { as: artist, params: { releaseId: s.releaseId, partyId: owner.id } })).status, 409);
    assert.equal((await h.call("resendInvitation", { as: artist, params: { releaseId: s.releaseId, partyId: uuid() } })).status, 404);
    assert.equal((await h.call("resendInvitation", { as: await account("artist"), params: { releaseId: s.releaseId, partyId } })).status, 404);
    assert.equal((await h.call("resendInvitation", { as: await account("administrator"), params: { releaseId: s.releaseId, partyId } })).status, 403);
  });

  it("is 409 once the party replied", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const { partyId, code } = await withInvitee(h, artist, s.releaseId);
    await h.call("respondToSplit", { as: await account("end_user"), params: { releaseId: s.releaseId, partyId }, body: { response: "accept", inviteCode: code } });
    const r = await h.call("resendInvitation", { as: artist, params: { releaseId: s.releaseId, partyId } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "not_invited");
  });

  it("a failed email still saves the rights, and is logged", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    h.modules.secretsAndEmail.fail = true;
    const r = await h.call("putRights", {
      as: artist,
      params: { releaseId: s.releaseId },
      body: { parties: [...OWN, { side: "recording", role: "producer", name: "Pro", email: "pro@example.invalid", percent: 50 }] },
    });
    assert.equal(r.status, 200);
    assert.ok(h.options.logs.some((l) => l.includes("invitation email")));
  });
});

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

/**
 * A new address each time: the database counts invitations per address per day (3, session J1),
 * across every test in the run.
 */
const address = (name: string) => `${name}-${uuid().slice(0, 8)}@example.invalid`;

/** The owner's own share on a side: the party with no email. */
const isOwnShare = (p: { email?: string }) => p.email === undefined || p.email === null;

async function withInvitee(h: ReturnType<typeof harness>, artist: Account, releaseId: string) {
  const email = address("pro");
  const r = await h.call("putRights", {
    as: artist,
    params: { releaseId },
    body: { parties: [...OWN, { side: "recording", role: "producer", name: "Pro", email, percent: 50 }] },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const party = r.body.parties.find((p: { name: string }) => p.name === "Pro");
  const mail = h.modules.secretsAndEmail.sent.filter((m) => m.template === "split_invitation").at(-1)!;
  return { partyId: party.id as string, code: mail.data.inviteCode, parties: r.body.parties, email };
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
        { side: "recording", role: "artist", name: "B", email: address("b"), percent: 40.01 },
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
          { side: "recording", role: "artist", name: "B", email: address("b"), percent: 33.33 },
          { side: "recording", role: "artist", name: "C", email: address("c"), percent: 33.34 },
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
    const unknown = await h.call("putRights", { as: artist, params: { releaseId: s.releaseId }, body: { parties: [{ ...OWN[0], id: uuid() }, OWN[1], { ...OWN[0], name: "B", email: address("b"), percent: 50 }] } });
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
        parties: parties.map((p: { id: string; name: string; email?: string; percent: number }) =>
          p.id === partyId ? { ...p, state: undefined, percent: 40 } : isOwnShare(p) && p.percent === 50 ? { ...p, state: undefined, percent: 60 } : { ...p, state: undefined },
        ),
      },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.parties.find((p: { id: string }) => p.id === partyId).state, "invited");
    const owners = changed.body.parties.filter(isOwnShare);
    assert.equal(owners.length, 2);
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

  it("getRelease lists the parties in the order sent, also after a reorder (position)", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const sent = [
      { side: "composition", role: "publisher", name: "P", email: address("p"), percent: 10 },
      { side: "recording", role: "artist", name: "Me", percent: 25 },
      ...Array.from({ length: 6 }, (_, i) => ({ side: "recording", role: "player", name: `R${i}`, email: address(`r${i}`), percent: 12.5 })),
      { side: "composition", role: "songwriter", name: "Me", percent: 90 },
    ];
    const put = await h.call("putRights", { as: artist, params: { releaseId: s.releaseId }, body: { parties: sent } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const names = (parties: { name: string }[]) => parties.map((p) => p.name);
    // The owner's shares come back named from the artist profile.
    const sentNames = sent.map((p) => ("email" in p ? p.name : "Test Artist"));
    assert.deepEqual(names(put.body.parties), sentNames);
    const read = await h.call("getRelease", { as: artist, params: { releaseId: s.releaseId } });
    assert.deepEqual(names(read.body.rights.parties), sentNames);

    // The same parties, reversed: only the order changes, so states and codes are kept.
    const reversed = [...put.body.parties].reverse().map((p: Record<string, unknown>) => ({
      id: p.id, side: p.side, role: p.role, name: p.name, percent: p.percent, ...(p.email ? { email: p.email } : {}),
    }));
    const codes = async () =>
      (await db.query<{ id: string; hash: string | null }>("select id::text as id, invite_code_hash as hash from public.api_parties where release_id = $1::uuid order by id", [s.releaseId]));
    const before = await codes();
    const again = await h.call("putRights", { as: artist, params: { releaseId: s.releaseId }, body: { parties: reversed } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const reread = await h.call("getRelease", { as: artist, params: { releaseId: s.releaseId } });
    assert.deepEqual(names(reread.body.rights.parties), reversed.map((p) => p.name as string));
    assert.deepEqual(await codes(), before, "a reorder voids no code");
  });

  it("a party needs an email, and the owner's share has none", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const { parties } = await withInvitee(h, artist, s.releaseId);
    const ownerParty = parties.find((p: { email?: string; side: string }) => isOwnShare(p) && p.side === "recording");
    const r = await h.call("putRights", {
      as: artist,
      params: { releaseId: s.releaseId },
      body: { parties: parties.map((p: { id: string }) => (p.id === ownerParty.id ? { ...p, state: undefined, email: address("me") } : { ...p, state: undefined })) },
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

describe("owner shares (finding L2)", () => {
  it("R5: a second share with no email on one side is 422 bad_parties", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const r = await h.call("putRights", {
      as: artist,
      params: { releaseId: s.releaseId },
      body: {
        parties: [
          { side: "recording", role: "producer", name: "A Famous Producer", percent: 50 },
          { side: "recording", role: "artist", name: "Me", percent: 25 },
          { side: "recording", role: "writer", name: "Another Writer", percent: 25 },
          { side: "composition", role: "songwriter", name: "Me", percent: 100 },
        ],
      },
    });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, "bad_parties");
    const [n] = await db.query<{ n: number }>("select count(*)::int as n from public.api_parties where release_id = $1::uuid", [s.releaseId]);
    assert.equal(n.n, 0, "nothing saved");
  });

  it("a kept owner share plus a new share with no email on the same side is 422", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const { parties } = await withInvitee(h, artist, s.releaseId);
    const r = await h.call("putRights", {
      as: artist,
      params: { releaseId: s.releaseId },
      body: {
        parties: [
          ...parties.map((p: Record<string, unknown>) => ({ ...p, state: undefined, ...(p.side === "recording" && isOwnShare(p) ? { percent: 25 } : {}) })),
          { side: "recording", role: "artist", name: "Someone", percent: 25 },
        ],
      },
    });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, "bad_parties");
  });

  it("the owner's share is named from the artist profile, whatever name is sent", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const r = await h.call("putRights", {
      as: artist,
      params: { releaseId: s.releaseId },
      body: {
        parties: [
          { side: "recording", role: "artist", name: "A Famous Producer", percent: 100 },
          { side: "composition", role: "songwriter", name: "Anyone", percent: 100 },
        ],
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.parties.map((p: { name: string; state: string }) => [p.name, p.state]), [["Test Artist", "accepted"], ["Test Artist", "accepted"]]);
    // Sending the kept party again under another name changes nothing.
    const again = await h.call("putRights", {
      as: artist,
      params: { releaseId: s.releaseId },
      body: { parties: r.body.parties.map((p: Record<string, unknown>) => ({ ...p, state: undefined, name: "Someone Else" })) },
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body.parties.map((p: { name: string }) => p.name), ["Test Artist", "Test Artist"]);
  });
});

describe("invitation caps (finding M1)", () => {
  const invited = (n: number, side: "recording" | "composition" = "recording", name = "R") =>
    Array.from({ length: n }, (_, i) => ({ side, role: "player", name: `${name}${i}`, email: address(`${name}${i}`), percent: 0 }));
  const own = [
    { side: "recording", role: "artist", name: "Me", percent: 100 },
    { side: "composition", role: "songwriter", name: "Me", percent: 100 },
  ];
  const invitations = (h: ReturnType<typeof harness>) => h.modules.secretsAndEmail.sent.filter((m) => m.template === "split_invitation").length;

  it("R4: at most 20 parties invited per release, all time; the rest are saved, not emailed, and logged", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    // Session I's R4: three putRights calls with new parties each time (99 then), here 15 each.
    for (let call = 0; call < 3; call++) {
      const r = await h.call("putRights", { as: artist, params: { releaseId: s.releaseId }, body: { parties: [...own, ...invited(15, "recording", `C${call}-`)] } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.parties.length, 17, "every party is saved");
    }
    assert.equal(invitations(h), 20);
    assert.ok(h.options.logs.some((l) => l.includes("invitation not sent (release_limited)")));
    const [party] = await db.query<{ id: string }>(
      "select id::text as id from public.api_parties where release_id = $1::uuid and email is not null and invite_code_hash is null limit 1",
      [s.releaseId],
    );
    const resend = await h.call("resendInvitation", { as: artist, params: { releaseId: s.releaseId, partyId: party.id } });
    assert.equal(resend.status, 429);
    assert.equal(resend.body.code, "rate_limited");
    assert.equal(resend.headers.get("retry-after"), null, "an all-time cap: no Retry-After");
  });

  it("at most 50 invitations per artist per UTC day; resend is 429 with Retry-After to midnight", async () => {
    const h = harness();
    const artist = await account("artist");
    for (let n = 0; n < 3; n++) {
      const s = await seedRelease(artist, "draft");
      const r = await h.call("putRights", { as: artist, params: { releaseId: s.releaseId }, body: { parties: [...own, ...invited(20, "recording", `A${n}-`)] } });
      assert.equal(r.status, 200);
    }
    assert.equal(invitations(h), 50);
    assert.ok(h.options.logs.some((l) => l.includes("invitation not sent (artist_limited)")));
    const [party] = await db.query<{ id: string; release_id: string }>(
      `select p.id::text as id, p.release_id::text as release_id from public.api_parties p join public.api_releases r on r.id = p.release_id
        where r.owner_id = $1::uuid and p.email is not null and p.invite_code_hash is null limit 1`,
      [artist.userId],
    );
    const resend = await h.call("resendInvitation", { as: artist, params: { releaseId: party.release_id, partyId: party.id } });
    assert.equal(resend.status, 429);
    assert.equal(resend.headers.get("retry-after"), String(12 * 3600), "until midnight UTC by the injected clock");
  });

  it("at most 3 invitations per recipient address per UTC day (lowercased, trimmed)", async () => {
    const h = harness();
    const target = address("target");
    const sameAddress = [target, target.toUpperCase(), ` ${target} `, target.replace("target", "TARGET")];
    for (const email of sameAddress) {
      const artist = await account("artist");
      const s = await seedRelease(artist, "draft");
      const r = await h.call("putRights", {
        as: artist,
        params: { releaseId: s.releaseId },
        body: { parties: [...own.slice(0, 1), { ...own[1], percent: 50 }, { side: "composition", role: "w", name: "T", email: email.trim(), percent: 50 }] },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    assert.equal(invitations(h), 3);
    assert.ok(h.options.logs.some((l) => l.includes("invitation not sent (address_limited)")));
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

  it("wrong codes count per party across both calls; once locked, only wrong codes are 429 (R2)", async () => {
    const h = harness();
    const artist = await account("artist");
    const s = await seedRelease(artist, "draft");
    const { partyId, code } = await withInvitee(h, artist, s.releaseId);
    // Session I's R2: 10 wrong codes from another account.
    const guesser = await account("end_user");
    for (let i = 0; i < 10; i++) {
      const op = i % 2 ? "getInvitation" : "respondToSplit";
      const r = await h.call(op, { as: guesser, params: { releaseId: s.releaseId, partyId }, body: { response: "accept", inviteCode: `wrong-code-number-${i}` } });
      assert.equal(r.status, 403, `${op} ${i}`);
      assert.equal(r.body.code, "wrong_code");
    }
    const locked = await h.call("getInvitation", { as: guesser, params: { releaseId: s.releaseId, partyId }, body: { inviteCode: "wrong-code-number-10" } });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.code, "rate_limited");
    assert.equal(locked.headers.get("retry-after"), "3600");
    // The invitee's right code still works (finding L1, session J1).
    const invitee = await account("end_user");
    const seen = await h.call("getInvitation", { as: invitee, params: { releaseId: s.releaseId, partyId }, body: { inviteCode: code } });
    assert.equal(seen.status, 200, JSON.stringify(seen.body));
    const replied = await h.call("respondToSplit", { as: invitee, params: { releaseId: s.releaseId, partyId }, body: { response: "accept", inviteCode: code } });
    assert.equal(replied.status, 200, JSON.stringify(replied.body));
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
    const { partyId, code, email } = await withInvitee(h, artist, s.releaseId);
    const r = await h.call("getInvitation", { as: await account("end_user"), params: { releaseId: s.releaseId, partyId }, body: { inviteCode: code } });
    assert.equal(r.status, 200);
    const text = JSON.stringify(r.body);
    for (const never of [artist.userId, email, "Pro", code, "Me", "masters/"]) assert.ok(!text.includes(never), never);
    assert.deepEqual(Object.keys(r.body.party).sort(), ["percent", "role", "side", "state"]);
  });
});

describe("resendInvitation", () => {
  it("issues a new code and voids the old; only for invited parties; limited per day", async () => {
    const h = harness(); // the default: 3 a day per party
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

    const owner = parties.find(isOwnShare);
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
      body: { parties: [...OWN, { side: "recording", role: "producer", name: "Pro", email: address("pro"), percent: 50 }] },
    });
    assert.equal(r.status, 200);
    assert.ok(h.options.logs.some((l) => l.includes("invitation email")));
  });
});

// recordPlays: idempotent batches, the server's qualified-stream rule, and bad input.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { account, db, harness, seedRelease, uuid } from "./helpers.ts";

after(() => db.close());

function batch(trackId: string, playId: string, seconds: number) {
  return {
    events: [
      { type: "start", trackId, playId, positionMs: 0, occurredAt: "2026-06-01T12:00:00Z" },
      { type: "progress", trackId, playId, positionMs: Math.floor((seconds * 1000) / 2), occurredAt: "2026-06-01T12:00:10Z" },
      { type: "end", trackId, playId, positionMs: seconds * 1000, occurredAt: new Date(Date.UTC(2026, 5, 1, 12, 0, seconds)).toISOString() },
    ],
  };
}

async function qualified(playId: string) {
  const [r] = await db.query<{ n: number }>("select count(*)::int as n from public.api_qualified_streams where play_id = $1::uuid", [playId]);
  return r.n;
}

describe("recordPlays", () => {
  it("the same Idempotency-Key twice counts once and says duplicate", async () => {
    const h = harness();
    const s = await seedRelease(await account("artist"), "live");
    const listener = await account("end_user");
    const key = uuid();
    const playId = uuid();
    const first = await h.call("recordPlays", { as: listener, headers: { "idempotency-key": key }, body: batch(s.trackIds[0], playId, 40) });
    assert.equal(first.status, 202);
    assert.deepEqual(first.body, { duplicate: false });
    // Extra fields and another key order still hash the same: only the contract's fields are sent.
    const again = await h.call("recordPlays", {
      as: listener,
      headers: { "idempotency-key": key },
      body: { events: batch(s.trackIds[0], playId, 40).events.map((e) => ({ extra: 1, occurredAt: e.occurredAt, positionMs: e.positionMs, playId: e.playId, trackId: e.trackId, type: e.type })) },
    });
    assert.equal(again.status, 202);
    assert.deepEqual(again.body, { duplicate: true });
    assert.equal(await qualified(playId), 1);
    const [events] = await db.query<{ n: number }>("select count(*)::int as n from public.api_play_events where play_id = $1::uuid", [playId]);
    assert.equal(events.n, 3);
  });

  it("the same key with other events is 409", async () => {
    const h = harness();
    const s = await seedRelease(await account("artist"), "live");
    const listener = await account("end_user");
    const key = uuid();
    await h.call("recordPlays", { as: listener, headers: { "idempotency-key": key }, body: batch(s.trackIds[0], uuid(), 40) });
    const r = await h.call("recordPlays", { as: listener, headers: { "idempotency-key": key }, body: batch(s.trackIds[0], uuid(), 40) });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "idempotency_conflict");
  });

  it("the server decides what qualifies: under 30 seconds does not", async () => {
    const h = harness();
    const s = await seedRelease(await account("artist"), "live");
    const listener = await account("end_user");
    const short = uuid();
    await h.call("recordPlays", { as: listener, headers: { "idempotency-key": uuid() }, body: batch(s.trackIds[0], short, 29) });
    assert.equal(await qualified(short), 0);
    const long = uuid();
    await h.call("recordPlays", { as: listener, headers: { "idempotency-key": uuid() }, body: batch(s.trackIds[0], long, 30) });
    assert.equal(await qualified(long), 1);
  });

  it("an unknown track is 422; a bad batch or key is 400; no token is 401", async () => {
    const h = harness();
    const s = await seedRelease(await account("artist"), "live");
    const listener = await account("end_user");
    const unknown = await h.call("recordPlays", { as: listener, headers: { "idempotency-key": uuid() }, body: batch(uuid(), uuid(), 40) });
    assert.equal(unknown.status, 422);
    assert.equal(unknown.body.code, "unknown_track");
    const good = batch(s.trackIds[0], uuid(), 40).events[0];
    for (const [headers, body] of [
      [{}, { events: [good] }],
      [{ "idempotency-key": "short" }, { events: [good] }],
      [{ "idempotency-key": uuid() }, { events: [] }],
      [{ "idempotency-key": uuid() }, { events: Array(101).fill(good) }],
      [{ "idempotency-key": uuid() }, { events: [{ ...good, type: "pause" }] }],
      [{ "idempotency-key": uuid() }, { events: [{ ...good, positionMs: -1 }] }],
      [{ "idempotency-key": uuid() }, { events: [{ ...good, occurredAt: "yesterday" }] }],
      [{ "idempotency-key": uuid() }, { events: [{ ...good, count: 5, trackId: "x" }] }],
    ] as [Record<string, string>, unknown][]) {
      const r = await h.call("recordPlays", { as: listener, headers, body });
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    }
    assert.equal((await h.call("recordPlays", { headers: { "idempotency-key": uuid() }, body: { events: [good] } })).status, 401);
  });
});

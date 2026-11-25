// recordPlays: idempotent batches, the server's qualified-stream rule (session J1: server time,
// track length, one play at a time), the limits, and bad input. The receive time comes from the
// harness's test-only clock (CoreOptions.playsReceivedAt), never from the request.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { account, db, harness, realPlay, SEEDED_DURATION_MS, seedRelease, uuid, type Harness } from "./helpers.ts";

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

/** The harness's receive clock, `seconds` on from where it is. */
const later = (h: Harness, seconds: number) => new Date(h.playsAt.time.getTime() + seconds * 1000);

async function qualifiedFor(userId: string) {
  const [r] = await db.query<{ n: number }>("select count(*)::int as n from public.api_qualified_streams where user_id = $1::uuid", [userId]);
  return r.n;
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
    const start = await h.call("recordPlays", {
      as: listener,
      headers: { "idempotency-key": uuid() },
      body: { events: [batch(s.trackIds[0], playId, 40).events[0]] },
    });
    assert.equal(start.status, 202);
    h.playsAt.time = later(h, 40);
    const rest = { events: batch(s.trackIds[0], playId, 40).events.slice(1) };
    const first = await h.call("recordPlays", { as: listener, headers: { "idempotency-key": key }, body: rest });
    assert.equal(first.status, 202);
    assert.deepEqual(first.body, { duplicate: false });
    // Extra fields and another key order still hash the same: only the contract's fields are sent.
    const again = await h.call("recordPlays", {
      as: listener,
      headers: { "idempotency-key": key },
      body: { events: rest.events.map((e) => ({ extra: 1, occurredAt: e.occurredAt, positionMs: e.positionMs, playId: e.playId, trackId: e.trackId, type: e.type })) },
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
    const short = await realPlay(h, listener, s.trackIds[0], { seconds: 29 });
    assert.equal(await qualified(short.playId), 0);
    const long = await realPlay(h, listener, s.trackIds[0], { seconds: 30 });
    assert.equal(await qualified(long.playId), 1);
  });

  it("R1: 50 fake plays in one batch, with device times in 2020, count 0", async () => {
    const h = harness();
    const s = await seedRelease(await account("artist"), "live");
    const listener = await account("end_user");
    // Session I sent 3 such requests and got 150 qualified streams.
    const fake = () =>
      Array.from({ length: 50 }, (_, i) => {
        const playId = uuid();
        const at = (sec: number) => new Date(Date.UTC(2020, 0, 1, 0, i, sec)).toISOString();
        return [
          { type: "start", trackId: s.trackIds[0], playId, positionMs: 0, occurredAt: at(0) },
          { type: "end", trackId: s.trackIds[0], playId, positionMs: 30000, occurredAt: at(30) },
        ];
      }).flat();
    for (let n = 0; n < 3; n++) {
      const r = await h.call("recordPlays", { as: listener, headers: { "idempotency-key": uuid() }, body: { events: fake() } });
      assert.equal(r.status, 202, JSON.stringify(r.body));
    }
    assert.equal(await qualifiedFor(listener.userId), 0, "a whole play in one request spans no server time");
    const [kept] = await db.query<{ n: number }>("select count(*)::int as n from public.api_play_events where user_id = $1::uuid", [listener.userId]);
    assert.equal(kept.n, 300, "the events are kept");
  });

  it("a real play (start, progress 15 seconds of server time later, end) counts once", async () => {
    const h = harness();
    const s = await seedRelease(await account("artist"), "live");
    const listener = await account("end_user");
    const playId = uuid();
    const t0 = h.playsAt.time;
    const at = (sec: number) => new Date(t0.getTime() + sec * 1000).toISOString();
    const send = (events: unknown[]) => h.call("recordPlays", { as: listener, headers: { "idempotency-key": uuid() }, body: { events } });
    assert.equal((await send([{ type: "start", trackId: s.trackIds[0], playId, positionMs: 0, occurredAt: at(0) }])).status, 202);
    h.playsAt.time = later(h, 15);
    assert.equal((await send([{ type: "progress", trackId: s.trackIds[0], playId, positionMs: 15000, occurredAt: at(15) }])).status, 202);
    assert.equal(await qualified(playId), 0, "15 seconds in: not yet");
    h.playsAt.time = later(h, 16);
    assert.equal((await send([{ type: "end", trackId: s.trackIds[0], playId, positionMs: 31000, occurredAt: at(31) }])).status, 202);
    assert.equal(await qualified(playId), 1);
    h.playsAt.time = later(h, 30);
    await send([{ type: "end", trackId: s.trackIds[0], playId, positionMs: 61000, occurredAt: at(61) }]);
    assert.equal(await qualified(playId), 1, "once");
  });

  it("two plays overlapping in server time count once", async () => {
    const h = harness();
    const s = await seedRelease(await account("artist"), "live", { tracks: 2 });
    await db.query("update public.api_tracks set duration_ms = 200000 where id = $1::uuid", [s.trackIds[1]]);
    const listener = await account("end_user");
    const [a, b] = [uuid(), uuid()];
    const t0 = h.playsAt.time;
    const at = (sec: number) => new Date(t0.getTime() + sec * 1000).toISOString();
    await h.call("recordPlays", {
      as: listener,
      headers: { "idempotency-key": uuid() },
      body: {
        events: [
          { type: "start", trackId: s.trackIds[0], playId: a, positionMs: 0, occurredAt: at(0) },
          { type: "start", trackId: s.trackIds[1], playId: b, positionMs: 0, occurredAt: at(0) },
        ],
      },
    });
    h.playsAt.time = later(h, 31);
    await h.call("recordPlays", {
      as: listener,
      headers: { "idempotency-key": uuid() },
      body: {
        events: [
          { type: "end", trackId: s.trackIds[0], playId: a, positionMs: 31000, occurredAt: at(31) },
          { type: "end", trackId: s.trackIds[1], playId: b, positionMs: 31000, occurredAt: at(31) },
        ],
      },
    });
    assert.equal((await qualified(a)) + (await qualified(b)), 1);
    // Another account at the same time counts on its own.
    const other = await account("end_user");
    h.playsAt.time = t0;
    const theirs = await realPlay(h, other, s.trackIds[0]);
    assert.equal(await qualified(theirs.playId), 1);
  });

  it("a position past the track's length (plus 1 second) does not count; no length, no count", async () => {
    const h = harness();
    const s = await seedRelease(await account("artist"), "live", { tracks: 2 });
    const listener = await account("end_user");
    const past = await realPlay(h, listener, s.trackIds[0], { endPositionMs: SEEDED_DURATION_MS + 1001 });
    assert.equal(past.second.status, 202);
    assert.equal(await qualified(past.playId), 0);
    const edge = await realPlay(h, listener, s.trackIds[0], { endPositionMs: SEEDED_DURATION_MS + 1000 });
    assert.equal(await qualified(edge.playId), 1, "up to the length plus 1 second counts");
    // The second seeded track has no streaming copy and no duration_ms.
    const none = await realPlay(h, listener, s.trackIds[1]);
    assert.equal(await qualified(none.playId), 0);
  });

  it("60 batches a minute per account; the 61st is 429 with Retry-After and is not stored", async () => {
    const h = harness();
    const s = await seedRelease(await account("artist"), "live");
    const listener = await account("end_user");
    h.playsAt.time = new Date("2026-06-01T12:00:20.000Z");
    const one = () => ({ events: [{ type: "start", trackId: s.trackIds[0], playId: uuid(), positionMs: 0, occurredAt: "2026-06-01T12:00:00Z" }] });
    for (let i = 0; i < 60; i++) {
      assert.equal((await h.call("recordPlays", { as: listener, headers: { "idempotency-key": uuid() }, body: one() })).status, 202, `batch ${i + 1}`);
    }
    const key = uuid();
    const over = await h.call("recordPlays", { as: listener, headers: { "idempotency-key": key }, body: one() });
    assert.equal(over.status, 429);
    assert.equal(over.body.code, "rate_limited");
    assert.equal(over.headers.get("retry-after"), "40", "to the next minute");
    const [stored] = await db.query<{ n: number }>(
      "select count(*)::int as n from public.api_play_batches where user_id = $1::uuid and idempotency_key = $2::text",
      [listener.userId, key],
    );
    assert.equal(stored.n, 0);
    h.playsAt.time = new Date("2026-06-01T12:01:00.000Z");
    assert.equal((await h.call("recordPlays", { as: listener, headers: { "idempotency-key": key }, body: one() })).status, 202);
  });

  it("10,000 stored events a UTC day per account; over it is 429 until the next day", async () => {
    const h = harness();
    const s = await seedRelease(await account("artist"), "live");
    const listener = await account("end_user");
    h.playsAt.time = new Date("2026-06-01T18:00:00.000Z");
    const events = (n: number) =>
      Array.from({ length: n }, () => ({ type: "start", trackId: s.trackIds[0], playId: uuid(), positionMs: 0, occurredAt: "2026-06-01T18:00:00Z" }));
    assert.equal((await h.call("recordPlays", { as: listener, headers: { "idempotency-key": uuid() }, body: { events: events(1) } })).status, 202);
    // Today's count as if 9,950 had been stored.
    await db.query("update public.api_rate_counters set hits = 9950 where bucket = 'play_events_day' and subject = $1::text", [listener.userId]);
    const over = await h.call("recordPlays", { as: listener, headers: { "idempotency-key": uuid() }, body: { events: events(51) } });
    assert.equal(over.status, 429);
    assert.equal(over.headers.get("retry-after"), String(6 * 3600), "to midnight UTC");
    assert.equal((await h.call("recordPlays", { as: listener, headers: { "idempotency-key": uuid() }, body: { events: events(50) } })).status, 202);
    assert.equal((await h.call("recordPlays", { as: listener, headers: { "idempotency-key": uuid() }, body: { events: events(1) } })).status, 429);
    h.playsAt.time = new Date("2026-06-02T00:00:01.000Z");
    assert.equal((await h.call("recordPlays", { as: listener, headers: { "idempotency-key": uuid() }, body: { events: events(1) } })).status, 202);
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

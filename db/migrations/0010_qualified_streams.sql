-- 0010: a tighter qualified-stream rule, and limits on recordPlays (session J1, findings H1
-- and M2 of docs/security/review-phase0.md; decided by K Marcus, 21 November 2026).
--
-- This reopens the rule settled with session B. A play (one playId, one track) qualifies
-- once, on a live release, when all of these hold over all of its events so far:
--   - the position moved by 30 seconds or more, and the device time passed by 30 seconds or
--     more (as before; the smaller of the two counts);
--   - server time: its events were received over at least c_min_server_span (15 seconds) of
--     server time, the span of received_at across its batches. A whole play sent in one
--     request spans 0 and never qualifies;
--   - track length: no event's positionMs is past the track's duration_ms plus
--     c_duration_slack_ms (1 second). A track with no duration_ms has no streaming copy and
--     never qualifies;
--   - no overlap: its server-time span does not overlap the span of another qualified play by
--     the same user, so one account counts at most one play at a time.
-- Events that do not qualify are kept, as before. Offline listening sent later in one batch
-- no longer qualifies (accepted for Phase 0).
--
-- Limits (counters from 0009): 60 batches per user per minute and 10,000 stored events per
-- user per UTC day. Over either, the batch is not stored and the status says so, with the
-- seconds to wait.
--
-- Existing rows: qualified streams counted before this stay counted; their span columns are
-- empty and they overlap nothing. Existing events are kept as they are.

alter table public.api_qualified_streams add column if not exists first_received_at timestamptz;
alter table public.api_qualified_streams add column if not exists last_received_at timestamptz;
create index if not exists api_qualified_streams_user_span
  on public.api_qualified_streams (user_id, first_received_at);

-- The old function took three arguments. Dropped, so a three-argument call is not ambiguous.
drop function if exists public.api_record_play_batch(uuid, text, jsonb);

-- Record a batch for recordPlays. p_events is the request's `events` array as JSON.
-- p_received_at is the server receive time: null in the deployments (the database's clock);
-- the tests pass their own.
-- status: ok (recorded), duplicate (same key and same events: counted once already),
-- conflict (same key, different events), too_many_batches or too_many_events (over a limit:
-- nothing stored; retry_after_seconds says how long to wait).
-- qualified_new is the qualified streams this call added.
-- Bad events (wrong shape, unknown track) raise MC422 and record nothing.
create or replace function public.api_record_play_batch(
  p_user_id uuid, p_idempotency_key text, p_events jsonb, p_received_at timestamptz default null)
returns table (status text, duplicate boolean, qualified_new integer, retry_after_seconds integer)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  -- The qualified-stream rule. 15 seconds and 1 second are starting values.
  c_min_listened_ms constant bigint := 30000;
  c_min_server_span constant interval := interval '15 seconds';
  c_duration_slack_ms constant bigint := 1000;
  v_now timestamptz := coalesce(p_received_at, now());
  v_hash text;
  v_existing text;
  v_rows integer;
  v_new integer := 0;
  v_hit record;
  v_play record;
begin
  if p_user_id is null then
    raise exception using errcode = 'MC422', message = 'no_user: the listener is needed';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 128 then
    raise exception using errcode = 'MC422', message = 'bad_key: Idempotency-Key must be 8 to 128 characters';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array'
     or jsonb_array_length(p_events) not between 1 and 100 then
    raise exception using errcode = 'MC422', message = 'bad_events: send 1 to 100 events';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_events) e
    where jsonb_typeof(e) <> 'object'
       or coalesce(e ->> 'type', '') not in ('start', 'progress', 'end')
       or coalesce(e ->> 'trackId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(e ->> 'playId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(e -> 'positionMs') is distinct from 'number'
       or (e ->> 'positionMs') !~ '^[0-9]{1,12}$'
       or jsonb_typeof(e -> 'occurredAt') is distinct from 'string'
  ) then
    raise exception using errcode = 'MC422', message = 'bad_events: each event needs type, trackId, playId, positionMs and occurredAt';
  end if;

  -- One batch at a time per listener, so two batches sent together cannot both count
  -- overlapping plays.
  perform pg_advisory_xact_lock(hashtext('api_record_play_batch'), hashtext(p_user_id::text));

  -- Every call counts toward the per-minute limit, duplicates included.
  select * into v_hit from public.api_rate_hit('play_batches_minute', p_user_id::text, 1, v_now);
  if not v_hit.allowed then
    return query select 'too_many_batches'::text, false, 0, v_hit.retry_after_seconds;
    return;
  end if;

  v_hash := encode(sha256(convert_to(p_events::text, 'UTF8')), 'hex');

  insert into public.api_play_batches (user_id, idempotency_key, events_sha256, event_count, received_at)
    values (p_user_id, p_idempotency_key, v_hash, jsonb_array_length(p_events), v_now)
    on conflict (user_id, idempotency_key) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    select b.events_sha256 into v_existing from public.api_play_batches b
      where b.user_id = p_user_id and b.idempotency_key = p_idempotency_key;
    if v_existing = v_hash then
      return query select 'duplicate'::text, true, 0, null::integer;
    else
      return query select 'conflict'::text, false, 0, null::integer;
    end if;
    return;
  end if;

  -- Only a new batch counts toward the daily limit on stored events. Over it, the batch row
  -- just written is removed again: nothing is stored.
  select * into v_hit from public.api_rate_hit('play_events_day', p_user_id::text, jsonb_array_length(p_events), v_now);
  if not v_hit.allowed then
    delete from public.api_play_batches b where b.user_id = p_user_id and b.idempotency_key = p_idempotency_key;
    return query select 'too_many_events'::text, false, 0, v_hit.retry_after_seconds;
    return;
  end if;

  begin
    insert into public.api_play_events
      (user_id, idempotency_key, play_id, track_id, event_type, position_ms, occurred_at, received_at)
    select p_user_id, p_idempotency_key, (e ->> 'playId')::uuid, (e ->> 'trackId')::uuid,
           e ->> 'type', (e ->> 'positionMs')::bigint, (e ->> 'occurredAt')::timestamptz, v_now
    from jsonb_array_elements(p_events) e;
  exception
    when foreign_key_violation then
      raise exception using errcode = 'MC422', message = 'unknown_track: an event names a track that does not exist';
    when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then
      raise exception using errcode = 'MC422', message = 'bad_events: occurredAt must be a date-time';
  end;

  -- Work out each play in this batch over all of its events so far, oldest first, and count
  -- the ones that qualify and overlap no play already counted (including ones counted here).
  for v_play in
    with batch_plays as (
      select distinct e.play_id, e.track_id
      from public.api_play_events e
      where e.user_id = p_user_id and e.idempotency_key = p_idempotency_key
    ),
    totals as (
      select p.play_id, p.track_id,
             least(max(e.position_ms) - min(e.position_ms),
                   floor(extract(epoch from (max(e.occurred_at) - min(e.occurred_at))) * 1000)::bigint) as listened_ms,
             max(e.position_ms) as max_position_ms,
             min(e.received_at) as first_at,
             max(e.received_at) as last_at
      from batch_plays p
      join public.api_play_events e
        on e.user_id = p_user_id and e.play_id = p.play_id and e.track_id = p.track_id
      group by p.play_id, p.track_id
    )
    select t.play_id, t.track_id, tr.release_id, t.listened_ms, t.first_at, t.last_at
    from totals t
    join public.api_tracks tr on tr.id = t.track_id
    join public.api_releases r on r.id = tr.release_id
    where r.state = 'live'
      and t.listened_ms >= c_min_listened_ms
      and t.last_at - t.first_at >= c_min_server_span
      and tr.duration_ms is not null
      and t.max_position_ms <= tr.duration_ms + c_duration_slack_ms
      and not exists (select 1 from public.api_qualified_streams q
                       where q.user_id = p_user_id and q.play_id = t.play_id)
    order by t.first_at, t.play_id
  loop
    if exists (select 1 from public.api_qualified_streams q
                where q.user_id = p_user_id
                  and q.first_received_at < v_play.last_at
                  and v_play.first_at < q.last_received_at) then
      continue;
    end if;
    insert into public.api_qualified_streams
      (user_id, play_id, track_id, release_id, listened_ms, first_received_at, last_received_at)
      values (p_user_id, v_play.play_id, v_play.track_id, v_play.release_id, v_play.listened_ms,
              v_play.first_at, v_play.last_at)
      on conflict (user_id, play_id) do nothing;
    get diagnostics v_rows = row_count;
    v_new := v_new + v_rows;
  end loop;

  return query select 'ok'::text, false, v_new, null::integer;
end
$$;

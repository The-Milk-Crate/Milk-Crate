-- 0005: play events and qualified streams.
--
-- The client sends start, progress and end events, never counts. A batch is kept once per
-- (listener, Idempotency-Key). The server decides a qualified stream: one per play, when both
-- the position moved and the device time passed by 30 seconds or more, on a live release.
-- user_id has no foreign key: a listener (end_user) has no api_accounts row.

create table if not exists public.api_play_batches (
  user_id uuid not null,
  idempotency_key text not null check (length(idempotency_key) between 8 and 128),
  -- SHA-256 of the events, so the same key with different events is refused.
  events_sha256 text not null,
  event_count integer not null check (event_count between 1 and 100),
  received_at timestamptz not null default now(),
  primary key (user_id, idempotency_key)
);

create table if not exists public.api_play_events (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  idempotency_key text not null,
  play_id uuid not null,
  track_id uuid not null references public.api_tracks (id) on delete cascade,
  event_type text not null check (event_type in ('start', 'progress', 'end')),
  position_ms bigint not null check (position_ms >= 0),
  -- Device time from the client.
  occurred_at timestamptz not null,
  -- Server time.
  received_at timestamptz not null default now(),
  constraint api_play_events_batch foreign key (user_id, idempotency_key)
    references public.api_play_batches (user_id, idempotency_key) on delete cascade
);

create index if not exists api_play_events_play on public.api_play_events (user_id, play_id);
create index if not exists api_play_events_batch on public.api_play_events (user_id, idempotency_key);

create table if not exists public.api_qualified_streams (
  user_id uuid not null,
  play_id uuid not null,
  track_id uuid not null references public.api_tracks (id) on delete cascade,
  release_id uuid not null references public.api_releases (id) on delete cascade,
  listened_ms bigint not null check (listened_ms >= 30000),
  qualified_at timestamptz not null default now(),
  primary key (user_id, play_id)
);

create index if not exists api_qualified_streams_track on public.api_qualified_streams (track_id);
create index if not exists api_qualified_streams_release on public.api_qualified_streams (release_id);

-- Record a batch for recordPlays. p_events is the request's `events` array as JSON.
-- status: ok (recorded), duplicate (same key and same events: counted once already),
-- conflict (same key, different events). qualified_new is the qualified streams this call added.
-- Bad events (wrong shape, unknown track) raise MC422 and record nothing.
create or replace function public.api_record_play_batch(p_user_id uuid, p_idempotency_key text, p_events jsonb)
returns table (status text, duplicate boolean, qualified_new integer)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_hash text;
  v_existing text;
  v_rows integer;
  v_new integer;
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

  v_hash := encode(sha256(convert_to(p_events::text, 'UTF8')), 'hex');

  insert into public.api_play_batches (user_id, idempotency_key, events_sha256, event_count)
    values (p_user_id, p_idempotency_key, v_hash, jsonb_array_length(p_events))
    on conflict (user_id, idempotency_key) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    select b.events_sha256 into v_existing from public.api_play_batches b
      where b.user_id = p_user_id and b.idempotency_key = p_idempotency_key;
    if v_existing = v_hash then
      return query select 'duplicate'::text, true, 0;
    else
      return query select 'conflict'::text, false, 0;
    end if;
    return;
  end if;

  begin
    insert into public.api_play_events
      (user_id, idempotency_key, play_id, track_id, event_type, position_ms, occurred_at)
    select p_user_id, p_idempotency_key, (e ->> 'playId')::uuid, (e ->> 'trackId')::uuid,
           e ->> 'type', (e ->> 'positionMs')::bigint, (e ->> 'occurredAt')::timestamptz
    from jsonb_array_elements(p_events) e;
  exception
    when foreign_key_violation then
      raise exception using errcode = 'MC422', message = 'unknown_track: an event names a track that does not exist';
    when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then
      raise exception using errcode = 'MC422', message = 'bad_events: occurredAt must be a date-time';
  end;

  -- Work out each play in this batch over all of its events so far.
  with batch_plays as (
    select distinct e.play_id, e.track_id
    from public.api_play_events e
    where e.user_id = p_user_id and e.idempotency_key = p_idempotency_key
  ),
  totals as (
    select p.play_id, p.track_id,
           least(max(e.position_ms) - min(e.position_ms),
                 floor(extract(epoch from (max(e.occurred_at) - min(e.occurred_at))) * 1000)::bigint) as listened_ms
    from batch_plays p
    join public.api_play_events e
      on e.user_id = p_user_id and e.play_id = p.play_id and e.track_id = p.track_id
    group by p.play_id, p.track_id
  )
  insert into public.api_qualified_streams (user_id, play_id, track_id, release_id, listened_ms)
  select p_user_id, t.play_id, t.track_id, tr.release_id, t.listened_ms
  from totals t
  join public.api_tracks tr on tr.id = t.track_id
  join public.api_releases r on r.id = tr.release_id
  where t.listened_ms >= 30000 and r.state = 'live'
  on conflict (user_id, play_id) do nothing;
  get diagnostics v_new = row_count;

  return query select 'ok'::text, false, v_new;
end
$$;

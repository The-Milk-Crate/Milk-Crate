-- 0002: releases, tracks, uploads, cover art and review decisions, with the state rules.

-- State moves the server may make. Matches the table at the top of api/openapi.yaml.
create or replace function public.api_release_move_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_to = 'taken_down' then p_from is distinct from 'taken_down'
    else (p_from, p_to) in (
      ('draft', 'uploading'),
      ('uploading', 'processing'),
      ('processing', 'awaiting_splits'),
      ('processing', 'failed'),
      ('failed', 'uploading'),
      ('awaiting_splits', 'awaiting_review'),
      ('awaiting_review', 'needs_changes'),
      ('needs_changes', 'uploading'),
      ('needs_changes', 'awaiting_splits'),
      ('awaiting_review', 'scheduled'),
      ('awaiting_review', 'live'),
      ('scheduled', 'live')
    )
  end
$$;

-- Title, release date, track titles and track order (updateRelease).
create or replace function public.api_release_details_editable(p_state text)
returns boolean language sql immutable set search_path = '' as $$
  select p_state in ('draft', 'uploading', 'awaiting_splits', 'needs_changes')
$$;

-- Parties and shares (putRights).
create or replace function public.api_release_rights_editable(p_state text)
returns boolean language sql immutable set search_path = '' as $$
  select p_state in ('draft', 'uploading', 'processing', 'awaiting_splits', 'needs_changes')
$$;

-- startUpload.
create or replace function public.api_master_upload_allowed(p_state text)
returns boolean language sql immutable set search_path = '' as $$
  select p_state in ('draft', 'uploading', 'needs_changes', 'failed')
$$;

-- startCoverUpload and its confirm.
create or replace function public.api_cover_upload_allowed(p_state text)
returns boolean language sql immutable set search_path = '' as $$
  select p_state in ('draft', 'uploading', 'processing', 'awaiting_splits', 'needs_changes')
$$;

-- Object keys. Keys only, never URLs. {artist} is the artist profile id.
create or replace function public.api_master_key(p_artist_id uuid, p_release_id uuid, p_track_id uuid)
returns text language sql immutable set search_path = '' as $$
  select format('masters/%s/%s/%s/original', p_artist_id, p_release_id, p_track_id)
$$;

create or replace function public.api_cover_key(p_artist_id uuid, p_release_id uuid)
returns text language sql immutable set search_path = '' as $$
  select format('art/%s/%s/cover/original', p_artist_id, p_release_id)
$$;

-- Streaming copies live under this prefix. Session H picks the file names inside.
create or replace function public.api_stream_prefix(p_artist_id uuid, p_release_id uuid, p_track_id uuid)
returns text language sql immutable set search_path = '' as $$
  select format('streams/%s/%s/%s/', p_artist_id, p_release_id, p_track_id)
$$;

-- Releases ---------------------------------------------------------------------------

create table if not exists public.api_releases (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.api_accounts (user_id),
  -- Copied from the owner's api_accounts row when the release is created, so keys stay put.
  artist_id uuid not null,
  title text not null check (length(btrim(title)) between 1 and 200),
  release_date date not null,
  state text not null default 'draft'
    constraint api_releases_state_check
    check (state in ('draft', 'uploading', 'processing', 'awaiting_splits', 'awaiting_review',
                     'needs_changes', 'scheduled', 'live', 'failed', 'taken_down')),
  -- Plain words for the artist. Set only while the state is failed.
  failure_reason text,
  review_decision text not null default 'none'
    check (review_decision in ('none', 'approved', 'needs_changes')),
  review_reason text check (review_reason is null or length(review_reason) <= 2000),
  review_decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint api_releases_failure_reason check ((state = 'failed') = (failure_reason is not null)),
  constraint api_releases_review_reason check (review_decision <> 'needs_changes' or review_reason is not null),
  constraint api_releases_review_time check ((review_decision = 'none') = (review_decided_at is null))
);

create index if not exists api_releases_newest on public.api_releases (created_at desc, id desc);
create index if not exists api_releases_owner_newest on public.api_releases (owner_id, created_at desc, id desc);
create index if not exists api_releases_state_newest on public.api_releases (state, created_at desc, id desc);

-- The state rules. Only these moves happen, whoever writes the row.
create or replace function public.api_releases_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_type text;
  v_artist uuid;
  v_side text;
  v_total numeric;
  v_count integer;
  v_max integer;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'draft' or new.review_decision <> 'none' then
      raise exception using errcode = 'MC409', message = 'wrong_state: a new release starts as draft';
    end if;
    select a.account_type, a.artist_id into v_type, v_artist
      from public.api_accounts a where a.user_id = new.owner_id;
    if v_type is distinct from 'artist' then
      raise exception using errcode = 'MC403', message = 'not_artist: only an artist account can own a release';
    end if;
    if new.artist_id is null then
      new.artist_id := v_artist;
    elsif new.artist_id <> v_artist then
      raise exception using errcode = 'MC422', message = 'wrong_artist: artist_id must be the owner''s artist id';
    end if;
    return new;
  end if;

  if new.id <> old.id or new.owner_id <> old.owner_id or new.artist_id <> old.artist_id
     or new.created_at <> old.created_at then
    raise exception using errcode = 'MC422', message = 'fixed_field: id, owner_id, artist_id and created_at cannot change';
  end if;

  if (new.title is distinct from old.title or new.release_date is distinct from old.release_date)
     and not public.api_release_details_editable(old.state) then
    raise exception using errcode = 'MC409',
      message = format('not_editable: a release cannot be edited while %s', old.state);
  end if;

  if new.state <> old.state then
    if not public.api_release_move_allowed(old.state, new.state) then
      raise exception using errcode = 'MC409',
        message = format('wrong_state: a release cannot move from %s to %s', old.state, new.state);
    end if;

    if old.state = 'failed' then
      new.failure_reason := null;
    end if;

    if new.state = 'processing' then
      if exists (select 1 from public.api_tracks t
                 where t.release_id = new.id and t.master_confirmed_at is null) then
        raise exception using errcode = 'MC422', message = 'masters_missing: every track needs a confirmed master';
      end if;
    elsif new.state = 'awaiting_review' then
      -- submitRelease: masters processed, shares at 100 for each side, no declined party.
      select count(*), max(t.position) into v_count, v_max
        from public.api_tracks t where t.release_id = new.id;
      if v_count = 0 then
        raise exception using errcode = 'MC422', message = 'no_tracks: a release needs at least one track';
      end if;
      if v_count <> v_max then
        raise exception using errcode = 'MC422', message = 'track_order: track positions must run 1, 2, 3 and so on';
      end if;
      if exists (select 1 from public.api_tracks t
                 where t.release_id = new.id and t.master_confirmed_at is null) then
        raise exception using errcode = 'MC422', message = 'masters_missing: every track needs a confirmed master';
      end if;
      foreach v_side in array array['recording', 'composition'] loop
        select coalesce(sum(p.percent), 0) into v_total
          from public.api_parties p where p.release_id = new.id and p.side = v_side;
        if v_total <> 100 then
          raise exception using errcode = 'MC422',
            message = format('shares_not_100: %s shares add up to %s, not 100', v_side, v_total);
        end if;
      end loop;
      if exists (select 1 from public.api_parties p where p.release_id = new.id and p.state = 'declined') then
        raise exception using errcode = 'MC422', message = 'declined_party: a party declined; change the rights first';
      end if;
      -- Submitting clears any earlier review decision.
      new.review_decision := 'none';
      new.review_reason := null;
      new.review_decided_at := null;
    elsif new.state in ('scheduled', 'live') and old.state = 'awaiting_review'
          and new.review_decision <> 'approved' then
      raise exception using errcode = 'MC409', message = 'not_approved: a reviewer has not approved this release';
    elsif new.state = 'needs_changes' and new.review_decision <> 'needs_changes' then
      raise exception using errcode = 'MC409', message = 'no_decision: needs_changes comes only from a review decision';
    end if;
  end if;

  -- Approve does not change the state; it only records the decision.
  if (new.review_decision, new.review_reason, new.review_decided_at)
     is distinct from (old.review_decision, old.review_reason, old.review_decided_at) then
    if (new.review_decision = 'approved'
          and not (old.state = 'awaiting_review' and new.state = 'awaiting_review'))
       or (new.review_decision = 'needs_changes'
          and not (old.state = 'awaiting_review' and new.state = 'needs_changes'))
       or (new.review_decision = 'none'
          and not (new.state = 'awaiting_review' and old.state <> 'awaiting_review')) then
      raise exception using errcode = 'MC409', message = 'wrong_state: a review decision is recorded only while awaiting_review';
    end if;
  end if;

  return new;
end
$$;

drop trigger if exists api_releases_guard on public.api_releases;
create trigger api_releases_guard
  before insert or update on public.api_releases
  for each row execute function public.api_releases_guard();

drop trigger if exists api_releases_touch on public.api_releases;
create trigger api_releases_touch
  before update on public.api_releases
  for each row execute function public.api_touch_updated_at();

-- Tracks -----------------------------------------------------------------------------

create table if not exists public.api_tracks (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.api_releases (id) on delete cascade,
  position integer not null check (position >= 1),
  title text not null check (length(btrim(title)) between 1 and 200),
  -- The confirmed master. All set together, or all empty.
  master_upload_id uuid,
  master_key text,
  master_format text check (master_format in ('wav', 'aiff', 'flac')),
  master_size_bytes bigint check (master_size_bytes between 1 and 5368709120),
  master_sha256 text check (master_sha256 ~ '^[0-9a-f]{64}$'),
  master_confirmed_at timestamptz,
  -- What playback needs. Session H fills these; getPlayback reads stream_key.
  stream_key text,
  duration_ms integer check (duration_ms > 0),
  sample_rate_hz integer check (sample_rate_hz > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Deferred, so a reorder can swap positions inside one transaction.
  constraint api_tracks_position_unique unique (release_id, position) deferrable initially deferred,
  constraint api_tracks_release_track unique (release_id, id),
  constraint api_tracks_master_fields check (
    (master_upload_id is null and master_key is null and master_format is null
      and master_size_bytes is null and master_sha256 is null and master_confirmed_at is null)
    or (master_upload_id is not null and master_key is not null and master_format is not null
      and master_size_bytes is not null and master_sha256 is not null and master_confirmed_at is not null)
  )
);

-- Tracks are added only with a draft and never removed. Title and order change only in the
-- editable states. Keys must follow the layout.
create or replace function public.api_tracks_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_state text;
  v_artist uuid;
  v_prefix text;
begin
  select r.state, r.artist_id into v_state, v_artist
    from public.api_releases r where r.id = coalesce(new.release_id, old.release_id);

  if tg_op = 'DELETE' then
    if v_state is not null then
      raise exception using errcode = 'MC409', message = 'tracks_fixed: tracks cannot be removed from a release';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if v_state is distinct from 'draft' then
      raise exception using errcode = 'MC409', message = 'tracks_fixed: tracks are added only when the release is created';
    end if;
  else
    if new.id <> old.id or new.release_id <> old.release_id then
      raise exception using errcode = 'MC422', message = 'fixed_field: id and release_id cannot change';
    end if;
    if (new.title <> old.title or new.position <> old.position)
       and not public.api_release_details_editable(v_state) then
      raise exception using errcode = 'MC409',
        message = format('not_editable: tracks cannot be edited while %s', v_state);
    end if;
  end if;

  if new.master_key is not null
     and new.master_key <> public.api_master_key(v_artist, new.release_id, new.id) then
    raise exception using errcode = 'MC422', message = 'bad_key: master key must be masters/{artist}/{release}/{track}/original';
  end if;
  if new.stream_key is not null then
    v_prefix := public.api_stream_prefix(v_artist, new.release_id, new.id);
    if length(new.stream_key) <= length(v_prefix) or left(new.stream_key, length(v_prefix)) <> v_prefix then
      raise exception using errcode = 'MC422', message = 'bad_key: stream key must be under streams/{artist}/{release}/{track}/';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists api_tracks_guard on public.api_tracks;
create trigger api_tracks_guard
  before insert or update or delete on public.api_tracks
  for each row execute function public.api_tracks_guard();

drop trigger if exists api_tracks_touch on public.api_tracks;
create trigger api_tracks_touch
  before update on public.api_tracks
  for each row execute function public.api_touch_updated_at();

-- Uploads (masters and cover art) ----------------------------------------------------

create table if not exists public.api_uploads (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.api_releases (id) on delete cascade,
  -- Set only when kind is master.
  track_id uuid,
  kind text not null check (kind in ('master', 'cover')),
  method text not null check (method in ('tus', 's3_multipart')),
  -- The storage module's own id for the upload.
  provider_upload_id text not null check (length(provider_upload_id) between 1 and 1024),
  object_key text not null,
  format text not null,
  size_bytes bigint not null,
  -- open: in progress. confirmed: done. replaced: a newer upload took its place.
  -- cancelled: the release was taken down.
  state text not null default 'open' check (state in ('open', 'confirmed', 'replaced', 'cancelled')),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  crc64nvme text check (length(crc64nvme) <= 64),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint api_uploads_track foreign key (release_id, track_id)
    references public.api_tracks (release_id, id) on delete cascade,
  constraint api_uploads_kind_track check ((kind = 'master') = (track_id is not null)),
  constraint api_uploads_format_size check (
    (kind = 'master' and format in ('wav', 'aiff', 'flac') and size_bytes between 1 and 5368709120)
    or (kind = 'cover' and format in ('jpeg', 'png') and size_bytes between 1 and 20971520)
  ),
  constraint api_uploads_confirmed check ((state = 'confirmed') = (confirmed_at is not null)),
  constraint api_uploads_confirmed_sha check (state <> 'confirmed' or sha256 is not null)
);

create index if not exists api_uploads_release on public.api_uploads (release_id);
-- At most one open upload per track, and one open cover upload per release.
create unique index if not exists api_uploads_one_open_master
  on public.api_uploads (track_id) where state = 'open' and kind = 'master';
create unique index if not exists api_uploads_one_open_cover
  on public.api_uploads (release_id) where state = 'open' and kind = 'cover';

create or replace function public.api_uploads_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_state text;
  v_artist uuid;
  v_key text;
begin
  if tg_op = 'UPDATE' then
    if new.id <> old.id or new.release_id <> old.release_id
       or new.track_id is distinct from old.track_id or new.kind <> old.kind
       or new.object_key <> old.object_key or new.method <> old.method then
      raise exception using errcode = 'MC422', message = 'fixed_field: an upload''s target cannot change';
    end if;
    if new.state <> old.state and old.state <> 'open' then
      raise exception using errcode = 'MC409', message = format('upload_closed: this upload is %s', old.state);
    end if;
    return new;
  end if;

  select r.state, r.artist_id into v_state, v_artist from public.api_releases r where r.id = new.release_id;
  if new.state <> 'open' then
    raise exception using errcode = 'MC422', message = 'wrong_state: a new upload starts open';
  end if;
  if new.kind = 'master' then
    if not public.api_master_upload_allowed(v_state) then
      raise exception using errcode = 'MC409', message = format('wrong_state: no master upload while %s', v_state);
    end if;
    v_key := public.api_master_key(v_artist, new.release_id, new.track_id);
  else
    if not public.api_cover_upload_allowed(v_state) then
      raise exception using errcode = 'MC409', message = format('wrong_state: no cover upload while %s', v_state);
    end if;
    v_key := public.api_cover_key(v_artist, new.release_id);
  end if;
  if new.object_key <> v_key then
    raise exception using errcode = 'MC422', message = format('bad_key: the key must be %s', v_key);
  end if;
  return new;
end
$$;

drop trigger if exists api_uploads_guard on public.api_uploads;
create trigger api_uploads_guard
  before insert or update on public.api_uploads
  for each row execute function public.api_uploads_guard();

drop trigger if exists api_uploads_touch on public.api_uploads;
create trigger api_uploads_touch
  before update on public.api_uploads
  for each row execute function public.api_touch_updated_at();

-- Cover art: one confirmed cover per release. No row means no cover. -----------------

create table if not exists public.api_covers (
  release_id uuid primary key references public.api_releases (id) on delete cascade,
  upload_id uuid not null references public.api_uploads (id) on delete cascade,
  -- art/{artist}/{release}/cover/original
  object_key text not null,
  format text not null check (format in ('jpeg', 'png')),
  size_bytes bigint not null check (size_bytes between 1 and 20971520),
  width integer not null,
  height integer not null,
  confirmed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint api_covers_square check (width > 0 and width = height)
);

create or replace function public.api_covers_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_artist uuid;
begin
  select r.artist_id into v_artist from public.api_releases r where r.id = new.release_id;
  if new.object_key <> public.api_cover_key(v_artist, new.release_id) then
    raise exception using errcode = 'MC422', message = 'bad_key: cover key must be art/{artist}/{release}/cover/original';
  end if;
  return new;
end
$$;

drop trigger if exists api_covers_guard on public.api_covers;
create trigger api_covers_guard
  before insert or update on public.api_covers
  for each row execute function public.api_covers_guard();

drop trigger if exists api_covers_touch on public.api_covers;
create trigger api_covers_touch
  before update on public.api_covers
  for each row execute function public.api_touch_updated_at();

-- Review decisions: every decision, kept. The release holds the current one. ---------

create table if not exists public.api_review_decisions (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.api_releases (id) on delete cascade,
  reviewer_id uuid not null references public.api_accounts (user_id),
  decision text not null check (decision in ('approved', 'needs_changes')),
  reason text check (reason is null or length(reason) <= 2000),
  decided_at timestamptz not null default now(),
  constraint api_review_decisions_reason check (decision <> 'needs_changes' or reason is not null)
);

create index if not exists api_review_decisions_release
  on public.api_review_decisions (release_id, decided_at desc);

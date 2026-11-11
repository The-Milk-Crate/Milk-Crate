-- 0007: functions the handlers and schedules call for uploads, review, publish and listing.
-- Each one locks the release row first, so moves on one release happen one at a time.

-- The key an upload will use, for ObjectStorage.startUpload before api_start_upload.
-- p_track_id is null for a cover.
create or replace function public.api_upload_key(p_release_id uuid, p_track_id uuid, p_kind text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_artist uuid;
begin
  select r.artist_id into v_artist from public.api_releases r where r.id = p_release_id;
  if not found then
    raise exception using errcode = 'MC404', message = 'not_found: no such release';
  end if;
  if p_kind = 'master' then
    if p_track_id is null or not exists (select 1 from public.api_tracks t
                                         where t.id = p_track_id and t.release_id = p_release_id) then
      raise exception using errcode = 'MC404', message = 'not_found: no such track on this release';
    end if;
    return public.api_master_key(v_artist, p_release_id, p_track_id);
  elsif p_kind = 'cover' then
    return public.api_cover_key(v_artist, p_release_id);
  end if;
  raise exception using errcode = 'MC422', message = 'bad_kind: kind must be master or cover';
end
$$;

-- startUpload and startCoverUpload, database part. Records the upload and replaces any open
-- one for the same track (or cover). For a master it clears the track's old master and
-- streaming copy, and moves draft, needs_changes or failed to uploading.
create or replace function public.api_start_upload(
  p_release_id uuid, p_track_id uuid, p_kind text, p_method text, p_provider_upload_id text,
  p_format text, p_size_bytes bigint, p_expires_at timestamptz)
returns table (upload_id uuid, object_key text, release_state text)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_release public.api_releases%rowtype;
  v_key text;
  v_id uuid;
begin
  select r.* into v_release from public.api_releases r where r.id = p_release_id for update;
  if not found then
    raise exception using errcode = 'MC404', message = 'not_found: no such release';
  end if;

  if p_kind = 'master' then
    if not public.api_master_upload_allowed(v_release.state) then
      raise exception using errcode = 'MC409', message = format('wrong_state: no master upload while %s', v_release.state);
    end if;
    v_key := public.api_upload_key(p_release_id, p_track_id, p_kind);
    update public.api_uploads u set state = 'replaced'
      where u.track_id = p_track_id and u.kind = 'master' and u.state = 'open';
    update public.api_tracks t
      set master_upload_id = null, master_key = null, master_format = null, master_size_bytes = null,
          master_sha256 = null, master_confirmed_at = null,
          stream_key = null, duration_ms = null, sample_rate_hz = null
      where t.id = p_track_id;
    if v_release.state <> 'uploading' then
      update public.api_releases r set state = 'uploading' where r.id = p_release_id;
    end if;
  elsif p_kind = 'cover' then
    if p_track_id is not null then
      raise exception using errcode = 'MC422', message = 'bad_track: a cover upload has no track';
    end if;
    if not public.api_cover_upload_allowed(v_release.state) then
      raise exception using errcode = 'MC409', message = format('wrong_state: no cover upload while %s', v_release.state);
    end if;
    v_key := public.api_upload_key(p_release_id, null, p_kind);
    update public.api_uploads u set state = 'replaced'
      where u.release_id = p_release_id and u.kind = 'cover' and u.state = 'open';
  else
    raise exception using errcode = 'MC422', message = 'bad_kind: kind must be master or cover';
  end if;

  insert into public.api_uploads
    (release_id, track_id, kind, method, provider_upload_id, object_key, format, size_bytes, expires_at)
    values (p_release_id, p_track_id, p_kind, p_method, p_provider_upload_id, v_key, p_format,
            p_size_bytes, p_expires_at)
    returning id into v_id;

  return query select v_id, v_key, r.state from public.api_releases r where r.id = p_release_id;
end
$$;

-- confirmUpload, database part, after storage confirmed the size (and CRC64NVME on S3).
-- A master: records it on the track; when every track has one, uploading moves to processing
-- and start_processing is true (the caller then queues the job).
-- A cover: p_width and p_height are read from the image head; it must be square. Replaces the
-- release's cover. Never changes the release state.
create or replace function public.api_confirm_upload(
  p_upload_id uuid, p_sha256 text, p_crc64nvme text, p_width integer, p_height integer)
returns table (kind text, track_id uuid, release_state text, start_processing boolean)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_release_id uuid;
  v_release_state text;
  v_up public.api_uploads%rowtype;
  v_start boolean := false;
begin
  select u.release_id into v_release_id from public.api_uploads u where u.id = p_upload_id;
  if not found then
    raise exception using errcode = 'MC404', message = 'not_found: no such upload';
  end if;
  select r.state into v_release_state from public.api_releases r where r.id = v_release_id for update;
  select u.* into v_up from public.api_uploads u where u.id = p_upload_id for update;

  if v_up.state <> 'open' then
    raise exception using errcode = 'MC409', message = format('upload_closed: this upload is %s', v_up.state);
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'MC422', message = 'bad_sha256: sha256 must be 64 lowercase hex characters';
  end if;

  if v_up.kind = 'master' then
    if v_release_state <> 'uploading' then
      raise exception using errcode = 'MC409', message = format('wrong_state: no master confirm while %s', v_release_state);
    end if;
    update public.api_uploads u
      set state = 'confirmed', sha256 = p_sha256, crc64nvme = p_crc64nvme, confirmed_at = now()
      where u.id = p_upload_id;
    update public.api_tracks t
      set master_upload_id = v_up.id, master_key = v_up.object_key, master_format = v_up.format,
          master_size_bytes = v_up.size_bytes, master_sha256 = p_sha256, master_confirmed_at = now()
      where t.id = v_up.track_id;
    if not exists (select 1 from public.api_tracks t
                   where t.release_id = v_release_id and t.master_confirmed_at is null) then
      update public.api_releases r set state = 'processing' where r.id = v_release_id
        returning r.state into v_release_state;
      v_start := true;
    end if;
  else
    if not public.api_cover_upload_allowed(v_release_state) then
      raise exception using errcode = 'MC409', message = format('wrong_state: no cover confirm while %s', v_release_state);
    end if;
    if p_width is null or p_height is null or p_width <= 0 or p_width <> p_height then
      raise exception using errcode = 'MC422', message = 'not_square: the cover must be a square image';
    end if;
    update public.api_uploads u
      set state = 'confirmed', sha256 = p_sha256, crc64nvme = p_crc64nvme, confirmed_at = now()
      where u.id = p_upload_id;
    insert into public.api_covers as c (release_id, upload_id, object_key, format, size_bytes, width, height)
      values (v_release_id, v_up.id, v_up.object_key, v_up.format, v_up.size_bytes, p_width, p_height)
      on conflict (release_id) do update
        set upload_id = excluded.upload_id, object_key = excluded.object_key, format = excluded.format,
            size_bytes = excluded.size_bytes, width = excluded.width, height = excluded.height,
            confirmed_at = now();
  end if;

  return query select v_up.kind, v_up.track_id, v_release_state, v_start;
end
$$;

-- reviewRelease, database part. Only administrator or internal, never the owner, and only
-- while awaiting_review. approve records the decision and leaves the state alone.
-- needs_changes needs a reason and moves the release to needs_changes.
create or replace function public.api_record_review(
  p_release_id uuid, p_reviewer_id uuid, p_decision text, p_reason text)
returns table (release_state text, review_decision text)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_release public.api_releases%rowtype;
  v_type text;
begin
  select r.* into v_release from public.api_releases r where r.id = p_release_id for update;
  if not found then
    raise exception using errcode = 'MC404', message = 'not_found: no such release';
  end if;
  select a.account_type into v_type from public.api_accounts a where a.user_id = p_reviewer_id;
  if v_type is null or v_type not in ('administrator', 'internal') or p_reviewer_id = v_release.owner_id then
    raise exception using errcode = 'MC403', message = 'not_allowed: only an administrator or internal reviewer can review';
  end if;
  if v_release.state <> 'awaiting_review' then
    raise exception using errcode = 'MC409', message = format('wrong_state: no review while %s', v_release.state);
  end if;

  if p_decision = 'approve' then
    update public.api_releases r
      set review_decision = 'approved', review_reason = null, review_decided_at = now()
      where r.id = p_release_id;
    insert into public.api_review_decisions (release_id, reviewer_id, decision)
      values (p_release_id, p_reviewer_id, 'approved');
  elsif p_decision = 'needs_changes' then
    if p_reason is null or length(btrim(p_reason)) not between 1 and 2000 then
      raise exception using errcode = 'MC422', message = 'no_reason: needs_changes needs a reason of 1 to 2000 characters';
    end if;
    update public.api_releases r
      set state = 'needs_changes', review_decision = 'needs_changes',
          review_reason = btrim(p_reason), review_decided_at = now()
      where r.id = p_release_id;
    insert into public.api_review_decisions (release_id, reviewer_id, decision, reason)
      values (p_release_id, p_reviewer_id, 'needs_changes', btrim(p_reason));
  else
    raise exception using errcode = 'MC422', message = 'bad_decision: decision must be approve or needs_changes';
  end if;

  return query select r.state, r.review_decision from public.api_releases r where r.id = p_release_id;
end
$$;

-- publishRelease, database part. Only after approval. A release date after today (UTC) gives
-- scheduled; today or earlier gives live. When scheduled, the caller sets a schedule that runs
-- api_release_go_live on the release date.
create or replace function public.api_publish_release(p_release_id uuid)
returns table (release_state text, release_date date)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_release public.api_releases%rowtype;
  v_to text;
begin
  select r.* into v_release from public.api_releases r where r.id = p_release_id for update;
  if not found then
    raise exception using errcode = 'MC404', message = 'not_found: no such release';
  end if;
  if v_release.state <> 'awaiting_review' then
    raise exception using errcode = 'MC409', message = format('wrong_state: no publish while %s', v_release.state);
  end if;
  if v_release.review_decision <> 'approved' then
    raise exception using errcode = 'MC409', message = 'not_approved: a reviewer has not approved this release';
  end if;
  v_to := case when v_release.release_date > (now() at time zone 'UTC')::date then 'scheduled' else 'live' end;
  update public.api_releases r set state = v_to where r.id = p_release_id;
  return query select v_to, v_release.release_date;
end
$$;

-- The schedule runs this on the release date. It moves only scheduled to live and does
-- nothing in any other state, so a release taken down while scheduled stays taken down.
-- Safe to run more than once. Returns the state after the call (null if no such release).
create or replace function public.api_release_go_live(p_release_id uuid)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_state text;
begin
  update public.api_releases r set state = 'live'
    where r.id = p_release_id and r.state = 'scheduled';
  select r.state into v_state from public.api_releases r where r.id = p_release_id;
  return v_state;
end
$$;

-- listReleases. Summaries, newest first, for the caller:
-- administrator and internal see every release, an artist sees only their own, anyone else
-- sees nothing. p_state filters (null for all). Keyset paging: pass the created_at and id of
-- the last row of the previous page (both null for the first page). At most 101 rows: ask for
-- limit + 1 to learn whether there is a next page.
create or replace function public.api_list_releases(
  p_caller uuid, p_state text, p_limit integer, p_after_created_at timestamptz, p_after_id uuid)
returns table (
  id uuid,
  owner_id uuid,
  title text,
  release_date date,
  state text,
  track_count integer,
  has_cover boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select r.id, r.owner_id, r.title, r.release_date, r.state,
         (select count(*)::integer from public.api_tracks t where t.release_id = r.id),
         exists (select 1 from public.api_covers c where c.release_id = r.id),
         r.created_at, r.updated_at
  from public.api_releases r
  join public.api_accounts a on a.user_id = p_caller
  where (a.account_type in ('administrator', 'internal')
         or (a.account_type = 'artist' and r.owner_id = p_caller))
    and (p_state is null or r.state = p_state)
    and (p_after_created_at is null or (r.created_at, r.id) < (p_after_created_at, p_after_id))
  order by r.created_at desc, r.id desc
  limit least(greatest(coalesce(p_limit, 25), 1), 101)
$$;

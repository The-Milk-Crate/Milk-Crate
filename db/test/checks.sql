-- Database checks. Run by db/test/run.sh on a throwaway cluster after the migrations.
-- Each check prints "ok - ..."; a failure raises and stops the run.

set client_min_messages = warning;
drop schema if exists t cascade;
set client_min_messages = notice;
create schema t;

-- Helpers ----------------------------------------------------------------------------

create table t.ids (name text primary key, id uuid not null);

create function t.put(p_name text, p_id uuid) returns uuid language sql as $$
  insert into t.ids values (p_name, p_id) on conflict (name) do update set id = excluded.id returning id
$$;

create function t.id(p_name text) returns uuid language sql stable as $$
  select id from t.ids where name = p_name
$$;

create function t.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'FAIL - %', p_label;
  end if;
  raise notice 'ok - %', p_label;
end
$$;

create function t.eq(p_got text, p_want text, p_label text) returns void language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception 'FAIL - %: got %, wanted %', p_label, coalesce(p_got, 'null'), coalesce(p_want, 'null');
  end if;
  raise notice 'ok - %', p_label;
end
$$;

-- Runs p_sql and expects it to fail with p_sqlstate. Its changes are rolled back.
create function t.fails(p_sql text, p_sqlstate text, p_label text) returns void language plpgsql as $$
declare
  v_state text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state = p_sqlstate then
      raise notice 'ok - % (%)', p_label, v_msg;
      return;
    end if;
    raise exception 'FAIL - %: wanted error %, got % (%)', p_label, p_sqlstate, v_state, v_msg;
  end;
  raise exception 'FAIL - %: wanted error %, got none', p_label, p_sqlstate;
end
$$;

create function t.hash(p_code text) returns text language sql immutable as $$
  select encode(sha256(convert_to(p_code, 'UTF8')), 'hex')
$$;

create function t.today() returns date language sql stable as $$
  select (now() at time zone 'UTC')::date
$$;

create function t.state(p_release uuid) returns text language sql stable as $$
  select state from public.api_releases where id = p_release
$$;

-- A draft with p_tracks tracks.
create function t.new_release(p_owner uuid, p_title text, p_date date, p_tracks integer)
returns uuid language plpgsql as $$
declare
  v_id uuid;
begin
  insert into public.api_releases (owner_id, title, release_date)
    values (p_owner, p_title, p_date) returning id into v_id;
  for i in 1..p_tracks loop
    insert into public.api_tracks (release_id, position, title) values (v_id, i, p_title || ' track ' || i);
  end loop;
  return v_id;
end
$$;

-- Start and confirm one master upload.
create function t.upload_master(p_release uuid, p_track uuid) returns boolean language plpgsql as $$
declare
  v_upload uuid;
  v_start boolean;
begin
  select s.upload_id into v_upload
    from public.api_start_upload(p_release, p_track, 'master', 'tus', 'prov-' || p_track,
                                 'wav', 1000, now() + interval '1 day') s;
  select c.start_processing into v_start
    from public.api_confirm_upload(v_upload, repeat('a', 64), null, null, null) c;
  return v_start;
end
$$;

-- Upload every master and finish processing: the release ends awaiting_splits.
create function t.to_awaiting_splits(p_release uuid) returns void language plpgsql as $$
declare
  v_track uuid;
  v_job uuid;
begin
  for v_track in select id from public.api_tracks where release_id = p_release order by position loop
    perform t.upload_master(p_release, v_track);
  end loop;
  v_job := public.api_create_job(p_release, 'process_release');
  perform public.api_apply_job_result(v_job, true, null);
end
$$;

create function t.full_rights(p_release uuid) returns void language sql as $$
  insert into public.api_parties (release_id, side, role, name, percent) values
    (p_release, 'recording', 'artist', 'Owner', 100),
    (p_release, 'composition', 'songwriter', 'Owner', 100)
$$;

-- Accounts ---------------------------------------------------------------------------
\echo '# api_accounts: one role per account'

do $$
begin
  perform t.put('artist', '00000000-0000-0000-0000-0000000000a1');
  perform t.put('artist_profile', '00000000-0000-0000-0000-0000000000a2');
  perform t.put('artist2', '00000000-0000-0000-0000-0000000000b1');
  perform t.put('artist2_profile', '00000000-0000-0000-0000-0000000000b2');
  perform t.put('admin', '00000000-0000-0000-0000-0000000000d1');
  perform t.put('internal', '00000000-0000-0000-0000-0000000000e1');
  perform t.put('third', '00000000-0000-0000-0000-0000000000f1');
  perform t.put('listener', '00000000-0000-0000-0000-000000000011');

  insert into public.api_accounts (user_id, account_type, email, artist_id, artist_name) values
    (t.id('artist'), 'artist', 'a@example.invalid', t.id('artist_profile'), 'Artist A'),
    (t.id('artist2'), 'artist', 'b@example.invalid', t.id('artist2_profile'), 'Artist B');
  insert into public.api_accounts (user_id, account_type, email) values
    (t.id('admin'), 'administrator', 'admin@example.invalid'),
    (t.id('internal'), 'internal', 'internal@example.invalid'),
    (t.id('third'), 'third_party', 'third@example.invalid');

  perform t.fails($q$insert into public.api_accounts (user_id, account_type) values (gen_random_uuid(), 'end_user')$q$,
                  '23514', 'end_user has no row');
  perform t.fails($q$insert into public.api_accounts (user_id, account_type) values (gen_random_uuid(), 'artist')$q$,
                  '23514', 'an artist row needs artist_id and artist_name');
  perform t.fails(format($q$insert into public.api_accounts (user_id, account_type, artist_id, artist_name)
                           values (gen_random_uuid(), 'administrator', gen_random_uuid(), 'X')$q$),
                  '23514', 'a staff row has no artist fields');
  perform t.fails(format($q$insert into public.api_accounts (user_id, account_type) values (%L, 'internal')$q$, t.id('artist')),
                  '23505', 'one row per account');
  perform t.fails(format($q$update public.api_accounts set account_type = 'administrator', artist_id = null, artist_name = null
                           where user_id = %L$q$, t.id('artist')),
                  'MC403', 'artist cannot become administrator');
  perform t.fails(format($q$update public.api_accounts set account_type = 'artist', artist_id = gen_random_uuid(), artist_name = 'X'
                           where user_id = %L$q$, t.id('admin')),
                  'MC403', 'administrator cannot become artist');
  perform t.fails(format($q$update public.api_accounts set account_type = 'artist', artist_id = gen_random_uuid(), artist_name = 'X'
                           where user_id = %L$q$, t.id('internal')),
                  'MC403', 'internal cannot become artist');
  update public.api_accounts set account_type = 'internal' where user_id = t.id('admin');
  update public.api_accounts set account_type = 'administrator' where user_id = t.id('admin');
  perform t.ok(true, 'a staff row can change between staff types');
end
$$;

-- Release state rules ----------------------------------------------------------------
\echo '# release state rules'

do $$
declare
  v_rel uuid;
  v_t1 uuid;
  v_t2 uuid;
  v_job uuid;
  v_row record;
begin
  perform t.fails(format($q$insert into public.api_releases (owner_id, title, release_date, state)
                           values (%L, 'X', current_date, 'live')$q$, t.id('artist')),
                  'MC409', 'a new release starts as draft');
  perform t.fails(format($q$insert into public.api_releases (owner_id, title, release_date)
                           values (%L, 'X', current_date)$q$, t.id('admin')),
                  'MC403', 'only an artist owns a release');
  perform t.fails(format($q$insert into public.api_releases (owner_id, title, release_date)
                           values (%L, 'X', current_date)$q$, t.id('listener')),
                  'MC403', 'an account with no row (end_user) owns no release');

  v_rel := t.put('rel1', t.new_release(t.id('artist'), 'First', t.today() + 30, 2));
  select id into v_t1 from public.api_tracks where release_id = v_rel and position = 1;
  select id into v_t2 from public.api_tracks where release_id = v_rel and position = 2;
  perform t.eq((select artist_id::text from public.api_releases where id = v_rel), t.id('artist_profile')::text,
               'artist_id is copied from the owner');

  perform t.fails(format($q$update public.api_releases set state = 'live' where id = %L$q$, v_rel),
                  'MC409', 'draft cannot jump to live');
  perform t.fails(format($q$update public.api_releases set state = 'processing' where id = %L$q$, v_rel),
                  'MC409', 'draft cannot jump to processing');

  -- Reorder by swapping positions in one statement (the unique check is deferred).
  update public.api_tracks set position = 3 - position where release_id = v_rel;
  perform t.eq((select position::text from public.api_tracks where id = v_t1), '2', 'track order is a position per track');
  update public.api_tracks set position = 3 - position where release_id = v_rel;

  perform t.ok(t.upload_master(v_rel, v_t1) is false, 'first confirmed master does not start processing');
  perform t.eq(t.state(v_rel), 'uploading', 'startUpload moves draft to uploading');
  perform t.fails(format($q$insert into public.api_tracks (release_id, position, title) values (%L, 3, 'late')$q$, v_rel),
                  'MC409', 'tracks cannot be added after draft');
  perform t.fails(format($q$delete from public.api_tracks where id = %L$q$, v_t1),
                  'MC409', 'tracks cannot be removed');
  update public.api_releases set title = 'First (edited)' where id = v_rel;
  perform t.ok(true, 'details can be edited while uploading');

  perform t.ok(t.upload_master(v_rel, v_t2) is true, 'last confirmed master starts processing');
  perform t.eq(t.state(v_rel), 'processing', 'uploading moves to processing when every track is confirmed');
  perform t.fails(format($q$update public.api_releases set title = 'nope' where id = %L$q$, v_rel),
                  'MC409', 'details cannot be edited while processing');
  perform t.fails(format($q$update public.api_tracks set title = 'nope' where id = %L$q$, v_t1),
                  'MC409', 'track titles cannot be edited while processing');

  -- Keys follow the layout.
  perform t.eq((select master_key from public.api_tracks where id = v_t1),
               format('masters/%s/%s/%s/original', t.id('artist_profile'), v_rel, v_t1), 'master key layout');
  perform t.fails(format($q$update public.api_tracks set master_key = 'https://example.invalid/x' where id = %L$q$, v_t1),
                  'MC422', 'a master key cannot be a URL or another path');
  perform t.fails(format($q$update public.api_tracks set stream_key = 'streams/other/place.m4a' where id = %L$q$, v_t1),
                  'MC422', 'a stream key must be under streams/{artist}/{release}/{track}/');
  update public.api_tracks
    set stream_key = public.api_stream_prefix(t.id('artist_profile'), v_rel, v_t1) || 'stream.m4a',
        duration_ms = 180000, sample_rate_hz = 44100
    where id = v_t1;
  update public.api_tracks
    set stream_key = public.api_stream_prefix(t.id('artist_profile'), v_rel, v_t2) || 'stream.m4a',
        duration_ms = 200000, sample_rate_hz = 48000
    where id = v_t2;
  perform t.ok(true, 'processing records stream key, duration and sample rate');

  -- Jobs: a stale result changes nothing; the newest job moves the release.
  v_job := public.api_create_job(v_rel, 'process_release');
  perform t.put('rel1_job_old', v_job);
  v_job := public.api_create_job(v_rel, 'process_release');
  select * into v_row from public.api_apply_job_result(t.id('rel1_job_old'), true, null);
  perform t.ok(v_row.finished and not v_row.moved, 'an older job''s result does not move the release');
  perform t.ok(public.api_job_started(v_job), 'a queued job can start');
  select * into v_row from public.api_apply_job_result(v_job, true, null);
  perform t.ok(v_row.finished and v_row.moved, 'the newest job''s success moves the release');
  perform t.eq(t.state(v_rel), 'awaiting_splits', 'processing moves to awaiting_splits');
  select * into v_row from public.api_apply_job_result(v_job, false, 'late');
  perform t.ok(not v_row.finished and not v_row.moved, 'a job result counts once');
  perform t.fails(format($q$select public.api_create_job(%L, 'process_release')$q$, v_rel),
                  'MC409', 'no job unless processing');
end
$$;

-- 100-percent rule and review ----------------------------------------------------------
\echo '# shares must total 100 at submit; review and publish'

do $$
declare
  v_rel uuid := t.id('rel1');
  v_row record;
begin
  perform t.fails(format($q$update public.api_releases set state = 'awaiting_review' where id = %L$q$, v_rel),
                  'MC422', 'submit refuses a release with no rights');
  insert into public.api_parties (release_id, side, role, name, email, percent) values
    (v_rel, 'recording', 'artist', 'Owner', null, 60),
    (v_rel, 'composition', 'songwriter', 'Owner', null, 100);
  perform t.fails(format($q$update public.api_releases set state = 'awaiting_review' where id = %L$q$, v_rel),
                  'MC422', 'submit refuses recording shares of 60');
  insert into public.api_parties (release_id, side, role, name, email, percent)
    values (v_rel, 'recording', 'producer', 'Producer', 'p@example.invalid', 40.01);
  perform t.fails(format($q$update public.api_releases set state = 'awaiting_review' where id = %L$q$, v_rel),
                  'MC422', 'submit refuses recording shares of 100.01');
  update public.api_parties set percent = 40 where release_id = v_rel and role = 'producer';
  update public.api_releases set state = 'awaiting_review' where id = v_rel;
  perform t.eq(t.state(v_rel), 'awaiting_review', 'submit works when each side totals 100');
  perform t.eq((select review_decision from public.api_releases where id = v_rel), 'none', 'submit clears the review decision');

  perform t.fails(format($q$update public.api_releases set title = 'nope' where id = %L$q$, v_rel),
                  'MC409', 'details cannot be edited while awaiting_review');
  perform t.fails(format($q$update public.api_parties set percent = 50 where release_id = %L and role = 'producer'$q$, v_rel),
                  'MC409', 'rights cannot be edited while awaiting_review');
  perform t.fails(format($q$select public.api_publish_release(%L)$q$, v_rel),
                  'MC409', 'publish needs an approval');
  perform t.fails(format($q$update public.api_releases set state = 'live' where id = %L$q$, v_rel),
                  'MC409', 'awaiting_review cannot go live without approval');
  perform t.fails(format($q$update public.api_releases set state = 'needs_changes' where id = %L$q$, v_rel),
                  'MC409', 'needs_changes comes only from a review decision');
  perform t.fails(format($q$select public.api_record_review(%L, %L, 'approve', null)$q$, v_rel, t.id('artist')),
                  'MC403', 'an artist cannot review');
  perform t.fails(format($q$select public.api_record_review(%L, %L, 'approve', null)$q$, v_rel, t.id('third')),
                  'MC403', 'third_party cannot review');
  perform t.fails(format($q$select public.api_record_review(%L, %L, 'needs_changes', ' ')$q$, v_rel, t.id('internal')),
                  'MC422', 'needs_changes needs a reason');

  select * into v_row from public.api_record_review(v_rel, t.id('internal'), 'approve', null);
  perform t.eq(v_row.release_state, 'awaiting_review', 'approve does not change the state');
  perform t.eq(v_row.review_decision, 'approved', 'approve records review.decision = approved');
  perform t.eq((select count(*)::text from public.api_review_decisions where release_id = v_rel), '1', 'the decision is kept');

  select * into v_row from public.api_publish_release(v_rel);
  perform t.eq(v_row.release_state, 'scheduled', 'publish with a future date gives scheduled');
  perform t.eq(public.api_release_go_live(v_rel), 'live', 'the schedule moves scheduled to live');
  perform t.eq(public.api_release_go_live(v_rel), 'live', 'running the schedule again changes nothing');
  perform t.ok(public.api_release_go_live(gen_random_uuid()) is null, 'the schedule ignores an unknown release');
  perform t.fails(format($q$update public.api_releases set state = 'draft' where id = %L$q$, v_rel),
                  'MC409', 'live cannot go back to draft');
end
$$;

\echo '# needs_changes, failed, publish today, takedown'

do $$
declare
  v_rel uuid;
  v_t1 uuid;
  v_job uuid;
  v_row record;
  v_removed jsonb;
begin
  -- needs_changes, then the artist replaces a master.
  v_rel := t.put('rel2', t.new_release(t.id('artist'), 'Second', t.today() - 1, 1));
  select id into v_t1 from public.api_tracks where release_id = v_rel;
  perform t.to_awaiting_splits(v_rel);
  perform t.full_rights(v_rel);
  update public.api_releases set state = 'awaiting_review' where id = v_rel;
  select * into v_row from public.api_record_review(v_rel, t.id('admin'), 'needs_changes', 'Fix the title');
  perform t.eq(v_row.release_state, 'needs_changes', 'needs_changes sends the release back');
  update public.api_releases set title = 'Second (fixed)' where id = v_rel;
  perform t.ok(true, 'details can be edited in needs_changes');
  perform t.ok(t.upload_master(v_rel, v_t1), 'a replaced master is confirmed again');
  perform t.eq(t.state(v_rel), 'processing', 'needs_changes to uploading to processing');
  perform t.ok((select stream_key is null from public.api_tracks where id = v_t1), 'a new master clears the old streaming copy');

  -- The worker fails; the artist replaces the master (failed to uploading).
  v_job := public.api_create_job(v_rel, 'process_release');
  perform t.fails(format($q$select public.api_apply_job_result(%L, false, '  ')$q$, v_job),
                  'MC422', 'a failed job needs a message');
  select * into v_row from public.api_apply_job_result(v_job, false, 'The file is not a WAV file.');
  perform t.eq(v_row.release_state, 'failed', 'a worker error moves processing to failed');
  perform t.eq((select failure_reason from public.api_releases where id = v_rel), 'The file is not a WAV file.',
               'failed keeps the plain-words reason');
  perform t.eq((select failure_message from public.api_jobs where id = v_job), 'The file is not a WAV file.',
               'the job keeps the message');
  perform t.fails(format($q$update public.api_releases set state = 'awaiting_splits' where id = %L$q$, v_rel),
                  'MC409', 'failed cannot skip to awaiting_splits');
  perform public.api_start_upload(v_rel, v_t1, 'master', 'tus', 'prov-again', 'flac', 2000, now() + interval '1 day');
  perform t.eq(t.state(v_rel), 'uploading', 'startUpload moves failed to uploading');
  perform t.ok((select failure_reason is null from public.api_releases where id = v_rel), 'leaving failed clears failureReason');
  perform t.eq((select count(*)::text from public.api_uploads where track_id = v_t1 and state = 'open'), '1',
               'one open upload per track');

  -- Publish with a date in the past gives live.
  perform t.ok(t.upload_master(v_rel, v_t1), 'confirmed again');
  perform public.api_apply_job_result(public.api_create_job(v_rel, 'process_release'), true, null);
  update public.api_releases set state = 'awaiting_review' where id = v_rel;
  perform public.api_record_review(v_rel, t.id('admin'), 'approve', null);
  select * into v_row from public.api_publish_release(v_rel);
  perform t.eq(v_row.release_state, 'live', 'publish with a past date gives live');

  -- Cover art.
  perform t.fails(format($q$select public.api_start_upload(%L, null, 'cover', 'tus', 'c1', 'png', 100, null)$q$, v_rel),
                  'MC409', 'no cover upload while live');

  -- Takedown while scheduled: the schedule must leave it taken down.
  v_rel := t.put('rel3', t.new_release(t.id('artist'), 'Third', t.today() + 60, 1));
  select id into v_t1 from public.api_tracks where release_id = v_rel;
  perform t.to_awaiting_splits(v_rel);
  select s.upload_id into v_job from public.api_start_upload(v_rel, null, 'cover', 's3_multipart', 'c1', 'jpeg', 5000, null) s;
  perform t.fails(format($q$select public.api_confirm_upload(%L, %L, 'crc', 800, 600)$q$, v_job, repeat('b', 64)),
                  'MC422', 'a cover must be square');
  perform public.api_confirm_upload(v_job, repeat('b', 64), 'crc', 800, 800);
  perform t.eq((select object_key from public.api_covers where release_id = v_rel),
               format('art/%s/%s/cover/original', t.id('artist_profile'), v_rel), 'cover key layout');
  perform t.eq(t.state(v_rel), 'awaiting_splits', 'a cover never changes the release state');
  update public.api_tracks
    set stream_key = public.api_stream_prefix(t.id('artist_profile'), v_rel, v_t1) || 'stream.m4a'
    where id = v_t1;
  perform t.full_rights(v_rel);
  update public.api_releases set state = 'awaiting_review' where id = v_rel;
  perform public.api_record_review(v_rel, t.id('internal'), 'approve', null);
  perform public.api_publish_release(v_rel);
  perform t.eq(t.state(v_rel), 'scheduled', 'third release is scheduled');

  perform t.fails(format($q$select public.api_takedown_release(%L, %L, 'x')$q$, v_rel, t.id('internal')),
                  'MC403', 'only an administrator takes down');
  select * into v_row from public.api_takedown_release(v_rel, t.id('admin'), 'Rights claim');
  perform t.put('rel3_audit', v_row.audit_id);
  perform t.eq(t.state(v_rel), 'taken_down', 'takedown from scheduled');
  perform t.eq(public.api_release_go_live(v_rel), 'taken_down', 'the schedule leaves a taken-down release alone');
  perform t.fails(format($q$select public.api_takedown_release(%L, %L, 'again')$q$, v_rel, t.id('admin')),
                  'MC409', 'a second takedown is refused');
  perform t.fails(format($q$update public.api_releases set state = 'live' where id = %L$q$, v_rel),
                  'MC409', 'a taken-down release cannot come back');
  perform t.fails(format($q$select public.api_start_upload(%L, %L, 'master', 'tus', 'p', 'wav', 1, null)$q$, v_rel, v_t1),
                  'MC409', 'no upload after takedown');

  select removed into v_removed from public.api_audit_log where id = t.id('rel3_audit');
  perform t.ok(v_removed -> 'prefixes' ? format('masters/%s/%s/', t.id('artist_profile'), v_rel)
               and v_removed -> 'prefixes' ? format('streams/%s/%s/', t.id('artist_profile'), v_rel)
               and v_removed -> 'prefixes' ? format('art/%s/%s/', t.id('artist_profile'), v_rel),
               'the audit row lists the masters/, streams/ and art/ prefixes');
  perform t.ok(v_removed -> 'keys' ? public.api_master_key(t.id('artist_profile'), v_rel, v_t1)
               and v_removed -> 'keys' ? public.api_cover_key(t.id('artist_profile'), v_rel)
               and v_removed -> 'keys' ? (public.api_stream_prefix(t.id('artist_profile'), v_rel, v_t1) || 'stream.m4a'),
               'the audit row lists the master, stream and cover keys');
  perform t.ok(not exists (select 1 from public.api_covers where release_id = v_rel)
               and (select stream_key is null from public.api_tracks where id = v_t1),
               'takedown clears the cover and streaming keys');
  perform t.ok(public.api_takedown_files_deleted(t.id('rel3_audit')), 'the audit row records the files deleted');
  perform t.fails(format($q$delete from public.api_releases where id = %L$q$, v_rel),
                  '23503', 'a release with an audit row cannot be deleted');
end
$$;

-- Plays ------------------------------------------------------------------------------
\echo '# play batches count once; qualified streams are worked out by the server'

do $$
declare
  v_live_track uuid := (select id from public.api_tracks where release_id = t.id('rel2'));
  v_draft_track uuid;
  v_play uuid := gen_random_uuid();
  v_events jsonb;
  v_row record;
  v_t0 timestamptz := '2026-01-01 12:00:00+00';
begin
  v_events := jsonb_build_array(
    jsonb_build_object('type', 'start', 'trackId', v_live_track, 'playId', v_play, 'positionMs', 0, 'occurredAt', v_t0),
    jsonb_build_object('type', 'progress', 'trackId', v_live_track, 'playId', v_play, 'positionMs', 31000,
                       'occurredAt', v_t0 + interval '31 seconds'));
  select * into v_row from public.api_record_play_batch(t.id('listener'), 'batch-0001', v_events);
  perform t.ok(v_row.status = 'ok' and not v_row.duplicate and v_row.qualified_new = 1, 'a 31-second play qualifies');
  select * into v_row from public.api_record_play_batch(t.id('listener'), 'batch-0001', v_events);
  perform t.ok(v_row.status = 'duplicate' and v_row.duplicate and v_row.qualified_new = 0, 'the same batch again is a duplicate');
  perform t.eq((select count(*)::text from public.api_play_events where idempotency_key = 'batch-0001'), '2',
               'a duplicate batch stores no more events');
  perform t.eq((select count(*)::text from public.api_qualified_streams where play_id = v_play), '1', 'it counts once');
  select * into v_row from public.api_record_play_batch(t.id('listener'), 'batch-0001', v_events - 1);
  perform t.eq(v_row.status, 'conflict', 'the same key with other events is a conflict');
  select * into v_row from public.api_record_play_batch(t.id('third'), 'batch-0001', v_events);
  perform t.eq(v_row.status, 'ok', 'keys are per listener');

  -- Three batches for one play: qualifies when it reaches 30 seconds, once.
  v_play := gen_random_uuid();
  select * into v_row from public.api_record_play_batch(t.id('listener'), 'batch-0002', jsonb_build_array(
    jsonb_build_object('type', 'start', 'trackId', v_live_track, 'playId', v_play, 'positionMs', 0, 'occurredAt', v_t0)));
  select * into v_row from public.api_record_play_batch(t.id('listener'), 'batch-0003', jsonb_build_array(
    jsonb_build_object('type', 'progress', 'trackId', v_live_track, 'playId', v_play, 'positionMs', 29999,
                       'occurredAt', v_t0 + interval '29.999 seconds')));
  perform t.eq(v_row.qualified_new::text, '0', 'under 30 seconds does not qualify');
  select * into v_row from public.api_record_play_batch(t.id('listener'), 'batch-0004', jsonb_build_array(
    jsonb_build_object('type', 'progress', 'trackId', v_live_track, 'playId', v_play, 'positionMs', 30000,
                       'occurredAt', v_t0 + interval '30 seconds')));
  perform t.eq(v_row.qualified_new::text, '1', 'exactly 30 seconds across batches qualifies');
  select * into v_row from public.api_record_play_batch(t.id('listener'), 'batch-0005', jsonb_build_array(
    jsonb_build_object('type', 'end', 'trackId', v_live_track, 'playId', v_play, 'positionMs', 90000,
                       'occurredAt', v_t0 + interval '90 seconds')));
  perform t.eq(v_row.qualified_new::text, '0', 'one play qualifies once');

  -- A seek is not listening: position jumps 60 seconds in 1 second of device time.
  v_play := gen_random_uuid();
  select * into v_row from public.api_record_play_batch(t.id('listener'), 'batch-0006', jsonb_build_array(
    jsonb_build_object('type', 'start', 'trackId', v_live_track, 'playId', v_play, 'positionMs', 0, 'occurredAt', v_t0),
    jsonb_build_object('type', 'end', 'trackId', v_live_track, 'playId', v_play, 'positionMs', 60000,
                       'occurredAt', v_t0 + interval '1 second')));
  perform t.eq(v_row.qualified_new::text, '0', 'a seek does not qualify');

  -- A release that is not live: events kept, no qualified stream.
  v_draft_track := (select id from public.api_tracks where release_id = t.id('rel3'));
  v_play := gen_random_uuid();
  select * into v_row from public.api_record_play_batch(t.id('listener'), 'batch-0007', jsonb_build_array(
    jsonb_build_object('type', 'start', 'trackId', v_draft_track, 'playId', v_play, 'positionMs', 0, 'occurredAt', v_t0),
    jsonb_build_object('type', 'end', 'trackId', v_draft_track, 'playId', v_play, 'positionMs', 60000,
                       'occurredAt', v_t0 + interval '60 seconds')));
  perform t.ok(v_row.status = 'ok' and v_row.qualified_new = 0, 'no qualified stream unless the release is live');

  perform t.fails(format($q$select public.api_record_play_batch(%L, 'batch-0008', %L)$q$, t.id('listener'),
                         jsonb_build_array(jsonb_build_object('type', 'start', 'trackId', gen_random_uuid(),
                           'playId', gen_random_uuid(), 'positionMs', 0, 'occurredAt', v_t0))),
                  'MC422', 'an unknown track is refused');
  perform t.fails(format($q$select public.api_record_play_batch(%L, 'batch-0009', %L)$q$, t.id('listener'),
                         jsonb_build_array(jsonb_build_object('type', 'start', 'trackId', v_live_track,
                           'playId', gen_random_uuid(), 'positionMs', 0, 'occurredAt', v_t0, 'count', 5)
                           - 'positionMs')),
                  'MC422', 'an event without positionMs is refused');
  perform t.ok(not exists (select 1 from public.api_play_batches where idempotency_key in ('batch-0008', 'batch-0009')),
               'a refused batch records nothing');
  perform t.eq((select count(*)::text from public.api_qualified_streams where user_id = t.id('listener')), '2',
               'the listener has two qualified streams in total');
end
$$;

-- Invitations ------------------------------------------------------------------------
\echo '# split invite codes: hash only, 14 days, single use'

do $$
declare
  v_rel uuid;
  v_p uuid;
  v_q uuid;
  v_row record;
begin
  v_rel := t.put('rel4', t.new_release(t.id('artist2'), 'Fourth', t.today() + 10, 2));
  perform t.to_awaiting_splits(v_rel);
  insert into public.api_parties (release_id, side, role, name, email, percent)
    values (v_rel, 'recording', 'artist', 'Artist B', null, 100) returning id into v_p;
  insert into public.api_parties (release_id, side, role, name, email, percent)
    values (v_rel, 'composition', 'songwriter', 'Writer', 'w@example.invalid', 100) returning id into v_q;
  perform t.put('party_p', v_p);
  perform t.put('party_q', v_q);

  perform t.fails(format($q$insert into public.api_parties (release_id, side, role, name, percent, state)
                           values (%L, 'recording', 'x', 'X', 0, 'accepted')$q$, v_rel),
                  'MC422', 'a new party starts invited');
  perform t.fails(format($q$select public.api_issue_invite(%L, 'not-a-hash', 3)$q$, v_p),
                  'MC422', 'only a hash is accepted, never a code');

  select * into v_row from public.api_issue_invite(v_p, t.hash('code-one-0000000001'), 3);
  perform t.ok(v_row.status = 'issued' and v_row.sends_today = 1, 'an invitation is issued');
  perform t.ok((select invite_expires_at = invite_sent_at + interval '14 days' and invite_code_hash = t.hash('code-one-0000000001')
                from public.api_parties where id = v_p), 'the hash is stored and expires 14 days after it was sent');

  select * into v_row from public.api_get_invitation(v_rel, v_p, t.hash('code-one-0000000001'));
  perform t.ok(v_row.status = 'ok' and v_row.release_title = 'Fourth' and v_row.artist_name = 'Artist B'
               and v_row.side = 'recording' and v_row.percent = 100 and v_row.party_state = 'invited'
               and v_row.track_titles = '["Fourth track 1", "Fourth track 2"]'::jsonb,
               'the invitation read returns the release basics and this party''s share');
  select * into v_row from public.api_get_invitation(v_rel, v_p, t.hash('code-one-0000000001'));
  perform t.eq(v_row.status, 'ok', 'reading the invitation does not use up the code');
  select * into v_row from public.api_get_invitation(v_rel, v_q, t.hash('code-one-0000000001'));
  perform t.eq(v_row.status, 'wrong_code', 'one party''s code does not open another party');
  select * into v_row from public.api_get_invitation(gen_random_uuid(), v_p, t.hash('code-one-0000000001'));
  perform t.eq(v_row.status, 'not_found', 'the party must belong to the release');
  select * into v_row from public.api_get_invitation(v_rel, v_p, t.hash('wrong-code-00000001'));
  perform t.eq(v_row.status, 'wrong_code', 'a wrong code is refused');
  perform t.eq(public.api_invite_wrong_count(v_p, 3600)::text, '1', 'wrong codes are counted per party');
  perform t.eq(public.api_invite_wrong_count(v_q, 3600)::text, '1', 'the other party has its own count');

  -- Resend: the old code stops working; sends are limited per day.
  select * into v_row from public.api_issue_invite(v_p, t.hash('code-two-0000000002'), 3);
  perform t.ok(v_row.status = 'issued' and v_row.sends_today = 2, 'a resend is issued and counted');
  select * into v_row from public.api_get_invitation(v_rel, v_p, t.hash('code-one-0000000001'));
  perform t.eq(v_row.status, 'wrong_code', 'after a resend the old code stops working');
  select * into v_row from public.api_issue_invite(v_p, t.hash('code-three-000000003'), 3);
  perform t.eq(v_row.sends_today::text, '3', 'third send today');
  select * into v_row from public.api_issue_invite(v_p, t.hash('code-four-0000000004'), 3);
  perform t.eq(v_row.status, 'rate_limited', 'the fourth send today is refused');
  perform t.ok((select invite_code_hash = t.hash('code-three-000000003') from public.api_parties where id = v_p),
               'a refused send keeps the current code');

  -- Single use.
  select * into v_row from public.api_respond_to_invite(v_rel, v_p, t.hash('code-two-0000000002'), t.id('listener'), 'accept');
  perform t.eq(v_row.status, 'wrong_code', 'a replaced code cannot reply');
  select * into v_row from public.api_respond_to_invite(v_rel, v_p, t.hash('code-three-000000003'), t.id('listener'), 'accept');
  perform t.ok(v_row.status = 'ok' and v_row.party_state = 'accepted', 'a valid code accepts');
  perform t.ok((select responder_user_id = t.id('listener') and invite_used_at is not null from public.api_parties where id = v_p),
               'the replying account is linked and the code is used');
  select * into v_row from public.api_respond_to_invite(v_rel, v_p, t.hash('code-three-000000003'), t.id('third'), 'decline');
  perform t.eq(v_row.status, 'replied', 'a code works once');
  select * into v_row from public.api_get_invitation(v_rel, v_p, t.hash('code-three-000000003'));
  perform t.eq(v_row.status, 'replied', 'the invitation read sees the reply');
  select * into v_row from public.api_issue_invite(v_p, t.hash('code-five-0000000005'), 10);
  perform t.eq(v_row.status, 'not_invited', 'no resend after a reply');
  perform t.fails(format($q$update public.api_parties set state = 'declined' where id = %L$q$, v_p),
                  'MC409', 'a reply cannot be changed');

  -- Expiry.
  perform public.api_issue_invite(v_q, t.hash('code-q-00000000001'), 3);
  update public.api_parties
    set invite_sent_at = now() - interval '15 days', invite_expires_at = now() - interval '1 day'
    where id = v_q;
  select * into v_row from public.api_get_invitation(v_rel, v_q, t.hash('code-q-00000000001'));
  perform t.eq(v_row.status, 'expired', 'an expired code is refused by the read');
  select * into v_row from public.api_respond_to_invite(v_rel, v_q, t.hash('code-q-00000000001'), t.id('third'), 'accept');
  perform t.eq(v_row.status, 'expired', 'an expired code cannot reply');
  perform t.eq(public.api_invite_wrong_count(v_q, 3600)::text, '1', 'an expired code is not a wrong code');

  -- A decline blocks submit; changing the party's details resets it and voids its code.
  perform public.api_issue_invite(v_q, t.hash('code-q-00000000002'), 3);
  select * into v_row from public.api_respond_to_invite(v_rel, v_q, t.hash('code-q-00000000002'), t.id('third'), 'decline');
  perform t.eq(v_row.party_state, 'declined', 'a valid code declines');
  perform t.fails(format($q$update public.api_releases set state = 'awaiting_review' where id = %L$q$, v_rel),
                  'MC422', 'submit refuses a declined party');
  update public.api_parties set name = 'Writer (new terms)' where id = v_q;
  perform t.ok((select state = 'invited' and invite_code_hash is null and responder_user_id is null
                from public.api_parties where id = v_q), 'changed details reset the party to invited with no code');
  select * into v_row from public.api_get_invitation(v_rel, v_q, t.hash('code-q-00000000002'));
  perform t.eq(v_row.status, 'wrong_code', 'the old code no longer works after a change');
  update public.api_releases set state = 'awaiting_review' where id = v_rel;
  perform t.eq(t.state(v_rel), 'awaiting_review', 'submit works with an invited party and no declines');

  -- Taken down.
  perform public.api_issue_invite(v_q, t.hash('code-q-00000000003'), 3);
  perform public.api_takedown_release(v_rel, t.id('admin'), 'test');
  select * into v_row from public.api_get_invitation(v_rel, v_q, t.hash('code-q-00000000003'));
  perform t.eq(v_row.status, 'taken_down', 'the read refuses a taken-down release');
  select * into v_row from public.api_respond_to_invite(v_rel, v_q, t.hash('code-q-00000000003'), t.id('third'), 'accept');
  perform t.eq(v_row.status, 'taken_down', 'no reply on a taken-down release');
  select * into v_row from public.api_issue_invite(v_q, t.hash('code-q-00000000004'), 3);
  perform t.eq(v_row.status, 'taken_down', 'no invitation on a taken-down release');
end
$$;

do $$
begin
  -- The invitation read returns exactly the Invitation fields, plus status.
  perform t.eq(
    (select string_agg(a.name, ',' order by a.ord)
     from pg_proc p,
          unnest(p.proargnames, p.proargmodes::text[]) with ordinality as a(name, mode, ord)
     where p.oid = 'public.api_get_invitation(uuid, uuid, text)'::regprocedure and a.mode = 't'),
    'status,release_title,artist_name,release_date,track_titles,side,role,percent,party_state',
    'the invitation read has no email, owner_id or other parties');
  perform t.ok((select prosecdef from pg_proc where oid = 'public.api_get_invitation(uuid, uuid, text)'::regprocedure),
               'the invitation read runs with its owner''s rights (the invitee has no table access)');
end
$$;

-- Listing ----------------------------------------------------------------------------
\echo '# list releases: newest first, state filter, keyset paging'

do $$
declare
  v_ids uuid[];
  v_page record;
  v_seen integer := 0;
  v_after_at timestamptz;
  v_after_id uuid;
  v_total integer;
begin
  perform t.eq((select count(*)::text from public.api_list_releases(t.id('artist'), null, 100, null, null)), '3',
               'an artist sees only their own releases');
  perform t.eq((select count(*)::text from public.api_list_releases(t.id('artist2'), null, 100, null, null)), '1',
               'the other artist sees only theirs');
  perform t.eq((select count(*)::text from public.api_list_releases(t.id('admin'), null, 100, null, null)), '4',
               'an administrator sees every release');
  perform t.eq((select count(*)::text from public.api_list_releases(t.id('internal'), null, 100, null, null)), '4',
               'internal sees every release');
  perform t.eq((select count(*)::text from public.api_list_releases(t.id('listener'), null, 100, null, null)), '0',
               'a listener sees none');
  perform t.eq((select count(*)::text from public.api_list_releases(t.id('third'), null, 100, null, null)), '0',
               'third_party sees none');
  perform t.eq((select string_agg(state, ',') from public.api_list_releases(t.id('admin'), 'live', 100, null, null)),
               'live,live', 'the state filter works');

  select array_agg(id order by created_at desc, id desc) into v_ids from public.api_releases;
  v_total := array_length(v_ids, 1);
  loop
    select * into v_page from public.api_list_releases(t.id('admin'), null, 1, v_after_at, v_after_id);
    exit when not found;
    v_seen := v_seen + 1;
    if v_page.id <> v_ids[v_seen] then
      raise exception 'FAIL - paging order: row % is %, wanted %', v_seen, v_page.id, v_ids[v_seen];
    end if;
    v_after_at := v_page.created_at;
    v_after_id := v_page.id;
  end loop;
  perform t.eq(v_seen::text, v_total::text, 'keyset paging one by one visits every release once, newest first');
  perform t.eq((select count(*)::text from public.api_list_releases(t.id('admin'), null, 1000, null, null)), '4',
               'a limit over 101 is accepted and capped');
end
$$;

set client_min_messages = warning;
drop schema t cascade;

-- 0011: submitting a release closes its open uploads (session J1, finding H2 of
-- docs/security/review-phase0.md; decided by K Marcus, 21 November 2026).
--
-- On Supabase an upload token writes straight to the final key, so an upload left open could
-- replace a reviewed cover or master. When a release moves to awaiting_review (submitRelease),
-- every open upload of it is cancelled, in the same transaction. A trigger, so it holds
-- whoever moves the state. Cancelled now means: the release was submitted or taken down.
--
-- Existing rows: none change when this runs. An upload already open on a release that is past
-- submit stays open in the table, but getUpload refuses it (the release's state no longer
-- allows that kind of upload) and confirm refuses it as before.

create or replace function public.api_releases_close_uploads()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.api_uploads u set state = 'cancelled'
    where u.release_id = new.id and u.state = 'open';
  return null;
end
$$;

drop trigger if exists api_releases_close_uploads on public.api_releases;
create trigger api_releases_close_uploads
  after update of state on public.api_releases
  for each row
  when (new.state = 'awaiting_review' and old.state is distinct from 'awaiting_review')
  execute function public.api_releases_close_uploads();

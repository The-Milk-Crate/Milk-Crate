-- 0013: at most one owner share per release and side (session J1, finding L2 of
-- docs/security/review-phase0.md; decided by K Marcus, 21 November 2026).
--
-- The owner's own share (is_owner, a party with no email) is accepted at once, with no
-- invitation, so a release may have only one per side. putRights also names it from the
-- artist profile.
--
-- Existing rows: if a release already has two or more owner shares on one side, this
-- migration stops with an error naming those releases, and changes nothing. Merge their
-- shares by hand (keep one owner party per side), then run it again. Nothing is guessed.
do $$
declare
  v_bad text;
begin
  select string_agg(d.release_id::text || ' ' || d.side, ', ' order by d.release_id, d.side) into v_bad
    from (select p.release_id, p.side from public.api_parties p
           where p.is_owner group by p.release_id, p.side having count(*) > 1) d;
  if v_bad is not null then
    raise exception using errcode = 'MC409',
      message = format('two_owner_shares: merge these releases'' owner shares by hand first (release side): %s', v_bad);
  end if;
end
$$;

create unique index if not exists api_parties_one_owner
  on public.api_parties (release_id, side) where is_owner;

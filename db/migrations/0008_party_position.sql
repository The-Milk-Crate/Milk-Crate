-- 0008: the order of rights parties (session G3).
-- putRights writes every party in one transaction, so they share created_at, and ordering by
-- created_at, id followed random ids. Each party now keeps its place in the putRights request
-- (0, 1, 2, ...). getRelease orders by position, then created_at, id.
--
-- Rows written without a position get 0, so older inserts still work and fall back to the old
-- order. Existing rows are numbered per release by created_at, id: the order getRelease gave
-- them before. Safe to run twice: the column is added and filled only once.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'api_parties' and column_name = 'position'
  ) then
    alter table public.api_parties
      add column position integer not null default 0 constraint api_parties_position check (position >= 0);
    update public.api_parties p set position = n.place
      from (select q.id, (row_number() over (partition by q.release_id order by q.created_at, q.id) - 1)::integer as place
              from public.api_parties q) n
     where n.id = p.id;
  end if;
end
$$;

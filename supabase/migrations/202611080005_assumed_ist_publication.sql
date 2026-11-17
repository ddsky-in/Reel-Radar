-- User-approved publication policy: naive provider upload timestamps mean IST.
-- Raw source is retained and explicitly marked assumed, never provider-verified.
alter table public.reels drop constraint reels_publish_timestamp_basis_check;
alter table public.reels add constraint reels_publish_timestamp_basis_check check (
 case published_at_basis
 when 'explicit_offset' then published_at is not null and (published_at_raw is null or published_at_raw ~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$')
 when 'timezone_unverified' then published_at is null and published_at_raw is not null and published_at_raw ~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?$'
 when 'assumed_Asia/Kolkata' then published_at is not null and published_at_raw is not null and
  case when published_at_raw ~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?$'
   then published_at = (published_at_raw::timestamp at time zone 'Asia/Kolkata') else false end
 else false end
);

create function public.apply_publication_ist_policy() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if new.published_at_basis in ('timezone_unverified','assumed_Asia/Kolkata') then
  if new.published_at_raw is null or new.published_at_raw !~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?$' then raise exception 'invalid_naive_publication_timestamp' using errcode='22023'; end if;
  new.published_at := new.published_at_raw::timestamp at time zone 'Asia/Kolkata';
  new.published_at_basis := 'assumed_Asia/Kolkata';
 end if;
 return new;
end; $$;
revoke execute on function public.apply_publication_ist_policy() from public,anon,authenticated,service_role;
create trigger reels_apply_publication_ist before insert or update of published_at,published_at_raw,published_at_basis on public.reels
 for each row execute function public.apply_publication_ist_policy();

update public.reels set published_at=published_at_raw::timestamp at time zone 'Asia/Kolkata',published_at_basis='assumed_Asia/Kolkata'
 where published_at is null and published_at_basis='timezone_unverified';

-- Upgrade assumed dates if a subsequent provider record contains an explicit offset.
-- Keep explicit dates intact when receiving another naive source observation.
do $$
declare definition text; replacement text;
begin
 definition := pg_get_functiondef('public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb)'::regprocedure);
 replacement := $new$published_at=case when public.reels.published_at is null or public.reels.published_at_basis<>'explicit_offset' and excluded.published_at_basis='explicit_offset' then excluded.published_at else public.reels.published_at end,
   published_at_raw=case when public.reels.published_at is null or public.reels.published_at_basis<>'explicit_offset' and excluded.published_at_basis='explicit_offset' then excluded.published_at_raw else public.reels.published_at_raw end,
   published_at_basis=case when public.reels.published_at is null or public.reels.published_at_basis<>'explicit_offset' and excluded.published_at_basis='explicit_offset' then excluded.published_at_basis else public.reels.published_at_basis end,$new$;
 -- Whitespace may differ in hosted chunk application; normalize only these three assignments.
 definition := regexp_replace(definition,
  'published_at=coalesce\(public\.reels\.published_at,excluded\.published_at\),\s*published_at_raw=case when public\.reels\.published_at is null then excluded\.published_at_raw else public\.reels\.published_at_raw end,\s*published_at_basis=case when public\.reels\.published_at is null then excluded\.published_at_basis else public\.reels\.published_at_basis end,',
  replacement);
 if position(replacement in definition)=0 then raise exception 'unexpected_worker_ingest_publication_contract'; end if;
 execute definition;
end $$;
revoke execute on function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) to service_role;

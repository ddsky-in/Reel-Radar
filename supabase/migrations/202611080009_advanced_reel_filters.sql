-- Advanced criteria are opt-in: legacy queries keep their existing defaults and result shape.
-- Do not rebuild reels_summary or ingestion functions: later transcription/date fields survive.
alter table public.reels add column platform text not null default 'instagram'
 constraint reels_platform_check check (platform = 'instagram');

-- Internal-only validator shared by direct queries and saved presets. It returns resolved
-- IST calendar bounds but never injects UI metric defaults. Presets retain the original
-- criteria so a saved rolling window remains rolling when used on another day.
create function public.validate_reel_query(q jsonb) returns jsonb
language plpgsql stable set search_path = pg_catalog, public as $$
declare
 k text; v jsonb; n numeric; upper_bound numeric; amount integer;
 day_ist date := (now() at time zone 'Asia/Kolkata')::date;
 from_date date; to_date date; normalized jsonb := q;
begin
 if q is null or jsonb_typeof(q) <> 'object' then
  raise exception 'invalid_query' using errcode = '22023';
 end if;
 if exists(select 1 from jsonb_object_keys(q) x where x not in (
  'search','creator_id','creator_ids','min_views','max_views','min_engagement','max_engagement',
  'min_outlier','max_outlier','keywords','from','to','posted_amount','posted_unit',
  'platform','saved','status','freshness','sort','page','limit')) then
  raise exception 'invalid_query' using errcode = '22023';
 end if;
 foreach k in array array['search','keywords','creator_id','from','to','posted_unit','platform','status','freshness','sort'] loop
  if q ? k and jsonb_typeof(q->k) <> 'string' then
   raise exception 'invalid_query' using errcode = '22023';
  end if;
 end loop;
 foreach k in array array['search','keywords'] loop
  if q ? k and char_length(q->>k) > 200 then raise exception 'invalid_query' using errcode = '22023'; end if;
 end loop;
 if q ? 'saved' and jsonb_typeof(q->'saved') <> 'boolean' then raise exception 'invalid_query' using errcode = '22023'; end if;
 if q ? 'sort' and q->>'sort' not in ('published_at','views','likes','comments','engagement','outlier') then raise exception 'invalid_query' using errcode = '22023'; end if;
 if q ? 'freshness' and q->>'freshness' not in ('all','fresh','stale') then raise exception 'invalid_query' using errcode = '22023'; end if;
 if q ? 'status' and q->>'status' not in ('active','pending','unavailable','private','failed','paused') then raise exception 'invalid_status' using errcode = '22023'; end if;
 if q ? 'platform' and q->>'platform' <> 'instagram' then raise exception 'invalid_query' using errcode = '22023'; end if;
 foreach k in array array['page','limit'] loop
  if q ? k then
   if jsonb_typeof(q->k) <> 'number' then raise exception 'invalid_pagination' using errcode = '22023'; end if;
   n := (q->>k)::numeric;
   if n <> trunc(n) or n < 1 or n > (case when k = 'page' then 10000 else 50 end) then
    raise exception 'invalid_pagination' using errcode = '22023';
   end if;
  end if;
 end loop;
 if q ? 'creator_id' and q->>'creator_id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
  raise exception 'invalid_creator_id' using errcode = '22023';
 end if;
 if q ? 'creator_ids' then
  if jsonb_typeof(q->'creator_ids') <> 'array' then raise exception 'invalid_creator_ids' using errcode = '22023'; end if;
  if jsonb_array_length(q->'creator_ids') > 120 then raise exception 'invalid_creator_ids' using errcode = '22023'; end if;
  for v in select value from jsonb_array_elements(q->'creator_ids') loop
   if jsonb_typeof(v) <> 'string' or v#>>'{}' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception 'invalid_creator_ids' using errcode = '22023';
   end if;
  end loop;
 end if;
 foreach k in array array['min_views','max_views','min_engagement','max_engagement','min_outlier','max_outlier'] loop
  if q ? k then
   if jsonb_typeof(q->k) <> 'number' then raise exception 'invalid_threshold' using errcode = '22023'; end if;
   n := (q->>k)::numeric; upper_bound := case when k in ('min_views','max_views') then 10000000 else 100 end;
   if n < 0 or n > upper_bound or (k in ('min_views','max_views') and n <> trunc(n)) then
    raise exception 'invalid_threshold' using errcode = '22023';
   end if;
  end if;
 end loop;
 foreach k in array array['views','engagement','outlier'] loop
  if q ? ('min_'||k) and q ? ('max_'||k) and (q->>('min_'||k))::numeric > (q->>('max_'||k))::numeric then
   raise exception 'invalid_threshold' using errcode = '22023';
  end if;
 end loop;
 if (q ? 'posted_amount') <> (q ? 'posted_unit') then raise exception 'invalid_posted_range' using errcode = '22023'; end if;
 if q ? 'posted_amount' then
  if q ? 'from' or q ? 'to' or jsonb_typeof(q->'posted_amount') <> 'number' or q->>'posted_unit' not in ('days','weeks','months') then
   raise exception 'invalid_posted_range' using errcode = '22023';
  end if;
  n := (q->>'posted_amount')::numeric;
  -- This bound prevents overflow before calendar subtraction; the actual span is checked below.
  if n <> trunc(n) or n < 1 or n > 366 then raise exception 'invalid_posted_range' using errcode = '22023'; end if;
  amount := n::integer;
  from_date := case q->>'posted_unit'
   when 'days' then day_ist - amount
   when 'weeks' then day_ist - amount * 7
   when 'months' then (day_ist - make_interval(months => amount))::date end;
  to_date := day_ist;
  if to_date - from_date > 366 then raise exception 'invalid_posted_range' using errcode = '22023'; end if;
  normalized := (q - 'posted_amount' - 'posted_unit') || jsonb_build_object('from',from_date::text,'to',to_date::text);
 else
  foreach k in array array['from','to'] loop
   if q ? k then
    if q->>k !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'invalid_date' using errcode = '22023'; end if;
    begin
     if k = 'from' then from_date := (q->>k)::date; else to_date := (q->>k)::date; end if;
    exception when datetime_field_overflow or invalid_datetime_format then
     raise exception 'invalid_date' using errcode = '22023';
    end;
   end if;
  end loop;
  if from_date is not null or to_date is not null then
   -- Preserve the API's bounded interpretation of legacy single-ended dates.
   from_date := coalesce(from_date,to_date - 366); to_date := coalesce(to_date,from_date + 366);
   if to_date < from_date or to_date - from_date > 366 then raise exception 'invalid_date_range' using errcode = '22023'; end if;
   normalized := q || jsonb_build_object('from',from_date::text,'to',to_date::text);
  end if;
 end if;
 return normalized;
end;
$$;
revoke all on function public.validate_reel_query(jsonb) from public, anon, authenticated, service_role;

-- Preserve named PostgREST arguments, pagination defaults and every summary item field.
create or replace function public.query_reels(p_workspace_id uuid,p_query jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare q jsonb; pg integer; lim integer; result jsonb; sort_key text; freshness text; creator_ids uuid[];
begin
 perform public.require_workspace(p_workspace_id);
 q := public.validate_reel_query(p_query);
 pg := coalesce((q->>'page')::numeric::integer,1); lim := coalesce((q->>'limit')::numeric::integer,30);
 sort_key := coalesce(q->>'sort','published_at'); freshness := coalesce(q->>'freshness','all');
 if q ? 'creator_ids' then
  select coalesce(array_agg(value::uuid),'{}'::uuid[]) into creator_ids from jsonb_array_elements_text(q->'creator_ids');
 end if;
 with scoped as (
  select r.*,s.reel_id is not null as saved,coalesce(s.note,'') as note,
   coalesce((select array_agg(t.tag order by t.tag) from public.reel_tags t where t.workspace_id=p_workspace_id and t.reel_id=r.id),'{}'::text[]) as tags
  from public.reels_summary r join public.workspace_creators wc on wc.creator_id=r.creator_id and wc.workspace_id=p_workspace_id and wc.active
  join public.reels base on base.id=r.id
  left join public.saved_reels s on s.workspace_id=p_workspace_id and s.reel_id=r.id
  where (not(q ? 'search') or r.username ilike '%'||(q->>'search')||'%' or r.caption_preview ilike '%'||(q->>'search')||'%')
   -- strpos is literal (%, _, backslashes and regex metacharacters are ordinary text).
   and (not(q ? 'keywords') or strpos(lower(r.caption_preview),lower(q->>'keywords')) > 0)
   and (not(q ? 'creator_id') or r.creator_id=(q->>'creator_id')::uuid)
   and (not(q ? 'creator_ids') or r.creator_id=any(creator_ids))
   and (not(q ? 'min_views') or r.latest_views >= (q->>'min_views')::numeric)
   and (not(q ? 'max_views') or r.latest_views <= (q->>'max_views')::numeric)
   and (not(q ? 'min_engagement') or r.engagement_rate_pct >= (q->>'min_engagement')::numeric)
   and (not(q ? 'max_engagement') or r.engagement_rate_pct <= (q->>'max_engagement')::numeric)
   and (not(q ? 'min_outlier') or r.follower_outlier_score >= (q->>'min_outlier')::numeric)
   and (not(q ? 'max_outlier') or r.follower_outlier_score <= (q->>'max_outlier')::numeric)
   and (not(q ? 'from') or r.published_at >= ((q->>'from')::date::timestamp at time zone 'Asia/Kolkata'))
   and (not(q ? 'to') or r.published_at < (((q->>'to')::date+1)::timestamp at time zone 'Asia/Kolkata'))
   and (not(q ? 'platform') or base.platform=q->>'platform')
   and (not(q ? 'saved') or (s.reel_id is not null)=(q->>'saved')::boolean)
   and (not(q ? 'status') or r.creator_status=q->>'status')
   and (freshness='all' or freshness='fresh' and r.latest_fetched_at>=now()-interval '48 hours' or freshness='stale' and r.latest_fetched_at<now()-interval '48 hours')
 ), ordered as (
  select *,row_number() over(order by
   case when sort_key='published_at' then published_at end desc nulls last,
   case when sort_key='views' then latest_views end desc nulls last,
   case when sort_key='likes' then latest_likes end desc nulls last,
   case when sort_key='comments' then latest_comments end desc nulls last,
   case when sort_key='engagement' then engagement_rate_pct end desc nulls last,
   case when sort_key='outlier' then follower_outlier_score end desc nulls last,id) as rn from scoped
 ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(o)-'rn' order by rn) from ordered o where rn>(pg-1)*lim and rn<=pg*lim),'[]'::jsonb),
  'total',(select count(*) from scoped),'page',pg,'limit',lim) into result;
 return result;
end;
$$;
revoke all on function public.query_reels(uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.query_reels(uuid,jsonb) to authenticated;

create table public.saved_reel_filters (
 id uuid primary key default gen_random_uuid(),
 owner_user_id uuid not null references public.app_settings(owner_user_id) on delete restrict,
 name text not null check (name = btrim(name) and char_length(name) between 1 and 80),
 config jsonb not null check (
  jsonb_typeof(config) = 'object' and config ?& array['version','query']
  and config - 'version' - 'query' = '{}'::jsonb
  and config->'version' = '1'::jsonb and jsonb_typeof(config->'query') = 'object'
  and not (config->'query' ?| array['page','limit','view'])),
 created_at timestamptz not null default now()
);
create unique index saved_reel_filters_owner_name_idx on public.saved_reel_filters(owner_user_id,lower(name));
alter table public.saved_reel_filters enable row level security;
revoke all on public.saved_reel_filters from public, anon, authenticated, service_role;
grant select on public.saved_reel_filters to authenticated;
create policy saved_reel_filter_owner_read on public.saved_reel_filters for select to authenticated
 using (owner_user_id = auth.uid() and public.is_allowed_owner());
-- Only the already-published owner_revisions signal is emitted; configs are not published.
create trigger owner_revision_changed after insert or update or delete on public.saved_reel_filters
 for each row execute function public.signal_owner_revision();

create function public.list_reel_filters() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
 if not public.is_allowed_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'name',f.name,'config',f.config,'created_at',f.created_at)
  order by f.created_at desc,f.id) from public.saved_reel_filters f where f.owner_user_id=auth.uid()),'[]'::jsonb);
end;
$$;
create function public.create_reel_filter(p_name text,p_query jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare f public.saved_reel_filters; normalized_name text := btrim(p_name);
begin
 if not public.is_allowed_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
 if normalized_name is null or char_length(normalized_name) not between 1 and 80 then raise exception 'invalid_reel_filter_name' using errcode = '22023'; end if;
 if p_query is null or jsonb_typeof(p_query) <> 'object' then raise exception 'invalid_reel_filter_config' using errcode = '22023'; end if;
 if p_query ?| array['page','limit','view'] then raise exception 'invalid_reel_filter_config' using errcode = '22023'; end if;
 perform public.validate_reel_query(p_query);
 -- Serialize owner creates/deletes: concurrent requests cannot bypass the 50-preset cap.
 perform pg_advisory_xact_lock(hashtextextended('reel_filters:'||auth.uid()::text,0));
 if exists(select 1 from public.saved_reel_filters where owner_user_id=auth.uid() and lower(name)=lower(normalized_name)) then
  raise exception 'reel_filter_name_exists' using errcode = '23505';
 end if;
 if (select count(*) from public.saved_reel_filters where owner_user_id=auth.uid()) >= 50 then
  raise exception 'reel_filter_limit_reached' using errcode = '22023';
 end if;
 insert into public.saved_reel_filters(owner_user_id,name,config)
  values(auth.uid(),normalized_name,jsonb_build_object('version',1,'query',p_query)) returning * into f;
 return jsonb_build_object('id',f.id,'name',f.name,'config',f.config,'created_at',f.created_at);
end;
$$;
create function public.delete_reel_filter(p_filter_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
 if not public.is_allowed_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('reel_filters:'||auth.uid()::text,0));
 delete from public.saved_reel_filters where id=p_filter_id and owner_user_id=auth.uid();
 if not found then raise exception 'reel_filter_not_found' using errcode = '42501'; end if;
end;
$$;
revoke all on function public.list_reel_filters(),public.create_reel_filter(text,jsonb),public.delete_reel_filter(uuid)
 from public, anon, authenticated, service_role;
grant execute on function public.list_reel_filters(),public.create_reel_filter(text,jsonb),public.delete_reel_filter(uuid) to authenticated;

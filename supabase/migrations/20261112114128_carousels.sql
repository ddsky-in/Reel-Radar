-- Carousels are separate from Reels: public views and per-slide performance are unknown.
create table public.carousel_posts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creators(id),
  shortcode text not null unique check(shortcode ~ '^[A-Za-z0-9_-]{1,64}$'),
  post_url text, thumbnail_url text, caption text not null default '' check(length(caption)<=10000),
  published_at timestamptz, published_at_raw text,
  published_at_basis text not null default 'explicit_offset' check(published_at_basis in ('explicit_offset','timezone_unverified','assumed_Asia/Kolkata')),
  slides jsonb not null default '[]' check(jsonb_typeof(slides)='array' and jsonb_array_length(slides)<=20),
  latest_likes bigint check(latest_likes>=0), latest_comments bigint check(latest_comments>=0),
  likes_state text not null check(likes_state in ('known','hidden','not_fetched','unavailable')),
  comments_state text not null check(comments_state in ('known','hidden','not_fetched','unavailable')),
  latest_fetched_at timestamptz not null, provider text not null,
  check((likes_state='known')=(latest_likes is not null)),
  check((comments_state='known')=(latest_comments is not null))
);
create index carousel_creator_publication on public.carousel_posts(creator_id,published_at desc,id);
create table public.carousel_metric_snapshots (
  carousel_id uuid not null references public.carousel_posts(id),
  snapshot_date date not null, fetched_at timestamptz not null,
  likes bigint check(likes>=0), comments bigint check(comments>=0),
  likes_state text not null check(likes_state in ('known','hidden','not_fetched','unavailable')),
  comments_state text not null check(comments_state in ('known','hidden','not_fetched','unavailable')),
  followers_at_snapshot bigint check(followers_at_snapshot>=0), follower_captured_at timestamptz,
  primary key(carousel_id,snapshot_date),
  check((likes_state='known')=(likes is not null)), check((comments_state='known')=(comments is not null))
);
create table public.saved_carousels (
  workspace_id uuid not null references public.workspaces(id),
  carousel_id uuid not null references public.carousel_posts(id),
  saved_by_user_id uuid not null references auth.users(id),
  note text not null default '' check(length(note)<=4000),
  tags text[] not null default '{}' check(cardinality(tags)<=20),
  primary key(workspace_id,carousel_id)
);
alter table public.carousel_posts enable row level security;
alter table public.carousel_metric_snapshots enable row level security;
alter table public.saved_carousels enable row level security;
revoke all on public.carousel_posts,public.carousel_metric_snapshots,public.saved_carousels from public,anon,authenticated,service_role;
grant select on public.carousel_posts,public.carousel_metric_snapshots,public.saved_carousels to authenticated;
grant all on public.carousel_posts,public.carousel_metric_snapshots,public.saved_carousels to service_role;
create policy carousel_read on public.carousel_posts for select to authenticated using(public.can_read_creator(creator_id));
create policy carousel_snapshot_read on public.carousel_metric_snapshots for select to authenticated using(exists(
  select 1 from public.carousel_posts c where c.id=carousel_id and public.can_read_creator(c.creator_id)));
create policy carousel_saved_read on public.saved_carousels for select to authenticated using(
  saved_by_user_id=(select auth.uid()) and public.is_workspace_member(workspace_id) and exists(
  select 1 from public.carousel_posts c join public.workspace_creators wc on wc.creator_id=c.creator_id
  where c.id=carousel_id and wc.workspace_id=saved_carousels.workspace_id and wc.active));
create trigger owner_revision_changed after insert or update or delete on public.carousel_posts for each row execute function public.signal_owner_revision();
create trigger owner_revision_changed after insert or update or delete on public.saved_carousels for each row execute function public.signal_owner_revision();

-- Internal view uses the same complete, strictly earlier, 30-post median as metrics.ts.
create view public.carousel_metrics with(security_invoker=true) as
select c.*, cr.username,cr.display_name,cr.avatar_url,
  fs.followers_count,fs.captured_at follower_captured_at,
  case when c.likes_state='known' and c.comments_state='known' then c.latest_likes::numeric+c.latest_comments::numeric end interactions,
  case when c.likes_state='known' and c.comments_state='known' and fs.followers_count>0
    then 100*(c.latest_likes::numeric+c.latest_comments::numeric)/fs.followers_count end follower_engagement_pct,
  case when c.likes_state='known' and c.comments_state='known' and fs.followers_count>0
    then (c.latest_likes::numeric+c.latest_comments::numeric)/fs.followers_count end follower_outlier_score,
  case when c.likes_state='known' and c.comments_state='known' and baseline.sample>=10 and baseline.median>0
    then (c.latest_likes::numeric+c.latest_comments::numeric)/baseline.median end profile_outlier_score,
  case when baseline.sample>=10 then baseline.median end profile_baseline_interactions,
  baseline.sample profile_baseline_sample
from public.carousel_posts c join public.creators cr on cr.id=c.creator_id
left join lateral(select followers_count,captured_at from public.creator_follower_snapshots f
  where f.creator_id=c.creator_id and f.captured_at<=c.latest_fetched_at order by captured_at desc limit 1) fs on true
left join lateral(select count(*)::integer sample,percentile_cont(.5) within group(order by interactions)::numeric median from (
  select p.latest_likes::numeric+p.latest_comments::numeric interactions from public.carousel_posts p
  where p.creator_id=c.creator_id and p.published_at<c.published_at and p.likes_state='known' and p.comments_state='known'
  order by p.published_at desc,p.id limit 30) prior) baseline on true;
revoke all on public.carousel_metrics from public,anon,authenticated,service_role;

-- Pure internal validation shared by reads and saved combinations. No UI defaults.
create function public.validate_carousel_query(p_query jsonb) returns jsonb
language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare q jsonb:=p_query; k text; n numeric; low numeric; high numeric;
begin
  if q is null or jsonb_typeof(q)<>'object' then raise exception 'invalid_query' using errcode='22023'; end if;
  for k in select jsonb_object_keys(q) loop
    if k not in ('search','keywords','creator','creator_ids','saved','min_interactions','min_outlier','max_outlier',
      'min_profile_outlier','max_profile_outlier','min_engagement','max_engagement','posted_amount','posted_unit','sort','page','limit')
      then raise exception 'invalid_query' using errcode='22023'; end if;
    if k in ('search','keywords') then
      if jsonb_typeof(q->k)<>'string' or length(btrim(q->>k))>200 then raise exception 'invalid_query' using errcode='22023'; end if;
      q:=jsonb_set(q,array[k],to_jsonb(btrim(q->>k)));
    elsif k='creator' then
      if jsonb_typeof(q->k)<>'string' or (q->>k)!~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then raise exception 'invalid_query' using errcode='22023'; end if;
    elsif k='creator_ids' then
      if jsonb_typeof(q->k)<>'array' then raise exception 'invalid_query' using errcode='22023'; end if;
      if jsonb_array_length(q->k)>120 or exists(select 1 from jsonb_array_elements(q->k) v
        where jsonb_typeof(v)<>'string' or (v#>>'{}')!~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
        or (select count(distinct lower(v)) from jsonb_array_elements_text(q->k) v)<>jsonb_array_length(q->k)
        then raise exception 'invalid_query' using errcode='22023'; end if;
    elsif k='saved' then
      if jsonb_typeof(q->k)<>'boolean' then raise exception 'invalid_query' using errcode='22023'; end if;
    elsif k='sort' then
      if jsonb_typeof(q->k)<>'string' or q->>k not in ('latest','likes','comments','profile_outlier','follower_engagement')
        then raise exception 'invalid_query' using errcode='22023'; end if;
    elsif k='posted_unit' then
      if jsonb_typeof(q->k)<>'string' or q->>k not in ('days','weeks','months') then raise exception 'invalid_query' using errcode='22023'; end if;
    else
      if jsonb_typeof(q->k)<>'number' then raise exception 'invalid_query' using errcode='22023'; end if;
      n:=(q->>k)::numeric;
      low:=case when k in ('page','limit','posted_amount') then 1 else 0 end;
      high:=case when k='page' then 10000 when k='limit' then 50 when k='posted_amount' then 366
        when k='min_interactions' then 9007199254740991 when k in ('min_profile_outlier','max_profile_outlier') then 1000000 else 100 end;
      if n<low or n>high or k in ('page','limit','posted_amount','min_interactions') and n<>trunc(n)
        then raise exception 'invalid_query' using errcode='22023'; end if;
    end if;
  end loop;
  if q ? 'creator' and q ? 'creator_ids' then raise exception 'invalid_query' using errcode='22023'; end if;
  for k in select unnest(array['outlier','profile_outlier','engagement']) loop
    if q ? ('min_'||k) and q ? ('max_'||k) and (q->>('min_'||k))::numeric>(q->>('max_'||k))::numeric
      then raise exception 'invalid_query' using errcode='22023'; end if;
  end loop;
  if (q ? 'posted_amount')<>(q ? 'posted_unit') then raise exception 'invalid_query' using errcode='22023'; end if;
  if q ? 'posted_amount' and (q->>'posted_amount')::integer>(case q->>'posted_unit' when 'months' then 12 when 'weeks' then 52 else 366 end)
    then raise exception 'invalid_query' using errcode='22023'; end if;
  return q;
end $$;
revoke all on function public.validate_carousel_query(jsonb) from public,anon,authenticated,service_role;

create function public.query_carousels(p_workspace_id uuid,p_query jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare q jsonb; pg integer; lim integer; ordering text; result jsonb;
  today date:=(current_timestamp at time zone 'Asia/Kolkata')::date; start_date date;
  period_from timestamptz; period_until timestamptz;
begin
  perform public.require_workspace(p_workspace_id);
  q:=public.validate_carousel_query(p_query);
  pg:=coalesce((q->>'page')::integer,1); lim:=coalesce((q->>'limit')::integer,30); ordering:=coalesce(q->>'sort','latest');
  if q ? 'posted_amount' then
    start_date:=case when q->>'posted_unit'='months' then (today::timestamp-make_interval(months=>(q->>'posted_amount')::integer))::date
      else today-(q->>'posted_amount')::integer*case when q->>'posted_unit'='weeks' then 7 else 1 end end;
    period_from:=start_date::timestamp at time zone 'Asia/Kolkata';
    period_until:=(today+1)::timestamp at time zone 'Asia/Kolkata';
  end if;
  with scoped as (
    select m.*,s.carousel_id is not null saved,coalesce(s.note,'') note,coalesce(s.tags,'{}') tags
    from public.carousel_metrics m join public.workspace_creators wc on wc.creator_id=m.creator_id and wc.workspace_id=p_workspace_id and wc.active
    left join public.saved_carousels s on s.carousel_id=m.id and s.workspace_id=p_workspace_id
    where (not q ? 'creator' or m.creator_id=(q->>'creator')::uuid)
      and (not q ? 'creator_ids' or m.creator_id in (select v::uuid from jsonb_array_elements_text(q->'creator_ids') v))
      and (not coalesce((q->>'saved')::boolean,false) or s.carousel_id is not null)
      and (not q ? 'min_interactions' or m.interactions>=(q->>'min_interactions')::numeric)
      and (not q ? 'min_outlier' or m.follower_outlier_score>=(q->>'min_outlier')::numeric)
      and (not q ? 'max_outlier' or m.follower_outlier_score<=(q->>'max_outlier')::numeric)
      and (not q ? 'min_profile_outlier' or m.profile_outlier_score>=(q->>'min_profile_outlier')::numeric)
      and (not q ? 'max_profile_outlier' or m.profile_outlier_score<=(q->>'max_profile_outlier')::numeric)
      and (not q ? 'min_engagement' or m.follower_engagement_pct>=(q->>'min_engagement')::numeric)
      and (not q ? 'max_engagement' or m.follower_engagement_pct<=(q->>'max_engagement')::numeric)
      and (period_from is null or m.published_at>=period_from and m.published_at<period_until)
      and (coalesce(q->>'search','')='' or position(lower(q->>'search') in lower(m.caption||' '||m.username))>0)
      and (coalesce(q->>'keywords','')='' or position(lower(q->>'keywords') in lower(m.caption||' '||m.username))>0)
  ), ordered as (
    select * from scoped order by
      case when ordering='likes' then latest_likes end desc nulls last,
      case when ordering='comments' then latest_comments end desc nulls last,
      case when ordering='profile_outlier' then profile_outlier_score end desc nulls last,
      case when ordering='follower_engagement' then follower_engagement_pct end desc nulls last,
      published_at desc nulls last,id limit lim offset (pg-1)*lim
  ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(o)) from ordered o),'[]'),
    'total',(select count(*) from scoped),'page',pg,'limit',lim) into result;
  return result;
end $$;
-- Carousel presets are owner-specific, separate from Reel filter combinations.
create table public.saved_carousel_filters (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.app_settings(owner_user_id) on delete restrict,
  name text not null check(name=btrim(name) and char_length(name) between 1 and 80),
  config jsonb not null check(jsonb_typeof(config)='object' and config ?& array['version','query']
    and config-'version'-'query'='{}'::jsonb and config->'version'='1'::jsonb and jsonb_typeof(config->'query')='object'
    and not(config->'query' ?| array['page','limit','view'])),
  created_at timestamptz not null default now()
);
create unique index saved_carousel_filters_owner_name_idx on public.saved_carousel_filters(owner_user_id,lower(name));
alter table public.saved_carousel_filters enable row level security;
revoke all on public.saved_carousel_filters from public,anon,authenticated,service_role;
grant select on public.saved_carousel_filters to authenticated;
create policy saved_carousel_filter_owner_read on public.saved_carousel_filters for select to authenticated
  using(owner_user_id=(select auth.uid()) and (select public.is_allowed_owner()));
create trigger owner_revision_changed after insert or update or delete on public.saved_carousel_filters
  for each row execute function public.signal_owner_revision();

create function public.list_carousel_filters() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  if not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'name',f.name,'config',f.config,'created_at',f.created_at)
    order by f.created_at desc,f.id) from public.saved_carousel_filters f where f.owner_user_id=auth.uid()),'[]'::jsonb);
end $$;
create function public.create_carousel_filter(p_name text,p_query jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare f public.saved_carousel_filters; normalized_name text:=btrim(p_name); q jsonb;
begin
  if not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  if normalized_name is null or char_length(normalized_name) not between 1 and 80 then raise exception 'invalid_carousel_filter_name' using errcode='22023'; end if;
  q:=public.validate_carousel_query(p_query);
  if q ?| array['page','limit','view'] then raise exception 'invalid_carousel_filter_config' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('carousel_filters:'||auth.uid()::text,0));
  if exists(select 1 from public.saved_carousel_filters where owner_user_id=auth.uid() and lower(name)=lower(normalized_name))
    then raise exception 'carousel_filter_name_exists' using errcode='23505'; end if;
  if (select count(*) from public.saved_carousel_filters where owner_user_id=auth.uid())>=50
    then raise exception 'carousel_filter_limit_reached' using errcode='22023'; end if;
  insert into public.saved_carousel_filters(owner_user_id,name,config)
    values(auth.uid(),normalized_name,jsonb_build_object('version',1,'query',q)) returning * into f;
  return jsonb_build_object('id',f.id,'name',f.name,'config',f.config,'created_at',f.created_at);
end $$;
create function public.delete_carousel_filter(p_filter_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('carousel_filters:'||auth.uid()::text,0));
  delete from public.saved_carousel_filters where id=p_filter_id and owner_user_id=auth.uid();
  if not found then raise exception 'carousel_filter_not_found' using errcode='42501'; end if;
end $$;
revoke all on function public.list_carousel_filters(),public.create_carousel_filter(text,jsonb),public.delete_carousel_filter(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.list_carousel_filters(),public.create_carousel_filter(text,jsonb),public.delete_carousel_filter(uuid) to authenticated;

create function public.get_carousel_detail(p_workspace_id uuid,p_carousel_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
  perform public.require_workspace(p_workspace_id);
  select to_jsonb(m)||jsonb_build_object('saved',s.carousel_id is not null,'note',coalesce(s.note,''),'tags',coalesce(s.tags,'{}')) into result
  from public.carousel_metrics m join public.workspace_creators wc on wc.creator_id=m.creator_id and wc.workspace_id=p_workspace_id and wc.active
  left join public.saved_carousels s on s.carousel_id=m.id and s.workspace_id=p_workspace_id where m.id=p_carousel_id;
  if result is null then raise exception 'carousel_not_found' using errcode='P0002'; end if;
  return jsonb_build_object('carousel',result,'snapshots',coalesce((select jsonb_agg(to_jsonb(x)) from (
    select fetched_at,likes,comments,likes_state,comments_state,followers_at_snapshot,follower_captured_at
    from public.carousel_metric_snapshots where carousel_id=p_carousel_id order by fetched_at desc limit 90) x),'[]'));
end $$;
create function public.set_carousel_bookmark(p_workspace_id uuid,p_carousel_id uuid,p_saved boolean,p_note text default '',p_tags text[] default '{}') returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_workspace(p_workspace_id);
  perform pg_advisory_xact_lock(hashtextextended('capacity:'||auth.uid()::text,0));
  if exists(select 1 from public.workspaces where id=p_workspace_id and archived_at is not null) then raise exception 'workspace_archived' using errcode='22023'; end if;
  if not exists(select 1 from public.carousel_posts c join public.workspace_creators wc on wc.creator_id=c.creator_id
    where c.id=p_carousel_id and wc.workspace_id=p_workspace_id and wc.active) then raise exception 'carousel_not_in_workspace' using errcode='42501'; end if;
  if p_saved is null or p_note is null or length(p_note)>4000 or p_tags is null or cardinality(p_tags)>20 or
    exists(select 1 from unnest(p_tags) t where t is null or length(trim(t)) not between 1 and 40) then raise exception 'invalid_bookmark' using errcode='22023'; end if;
  if p_saved then
    insert into public.saved_carousels(workspace_id,carousel_id,saved_by_user_id,note,tags)
    values(p_workspace_id,p_carousel_id,auth.uid(),p_note,array(select distinct trim(t) from unnest(p_tags) t))
    on conflict(workspace_id,carousel_id) do update set note=excluded.note,tags=excluded.tags;
  else delete from public.saved_carousels where workspace_id=p_workspace_id and carousel_id=p_carousel_id; end if;
end $$;

alter table public.scrape_jobs drop constraint scrape_jobs_kind_check;
alter table public.scrape_jobs add constraint scrape_jobs_kind_check check(kind in ('daily','weekly','backfill','profile','manual','retry','discovery','metrics','carousel'));
create function public.enqueue_carousel_refresh(p_workspace_id uuid,p_creator_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare cid uuid; jid uuid; jobs uuid[]:='{}'; s public.app_settings;
begin
  perform public.require_workspace(p_workspace_id);
  perform pg_advisory_xact_lock(hashtextextended('capacity:'||auth.uid()::text,0));
  perform pg_advisory_xact_lock(hashtextextended('budget:'||auth.uid()::text,0));
  select * into s from public.app_settings where owner_user_id=auth.uid() for update;
  if not s.scraping_enabled or s.paused or exists(select 1 from public.workspaces where id=p_workspace_id and archived_at is not null) then
    raise exception 'collection_disabled' using errcode='22023'; end if;
  if p_creator_ids is not null and (cardinality(p_creator_ids) not between 1 and 120 or exists(
    select 1 from unnest(p_creator_ids) x where x is null or not exists(
      select 1 from public.workspace_creators wc where wc.workspace_id=p_workspace_id and wc.creator_id=x and wc.active))) then
    raise exception 'creator_not_in_workspace' using errcode='42501'; end if;
  for cid in select c.id from public.creators c join public.workspace_creators wc on wc.creator_id=c.id
    where wc.workspace_id=p_workspace_id and wc.active and c.status not in ('private','unavailable','paused')
    and (p_creator_ids is null or c.id=any(p_creator_ids)) order by c.id limit 120 loop
    -- Reuse active canonical collection across workspaces; unresolved starts remain busy.
    select j.id into jid from public.scrape_jobs j join public.scrape_job_creators jc on jc.job_id=j.id
      where j.owner_user_id=auth.uid() and j.kind='carousel' and jc.creator_id=cid
      and j.status in ('pending','budget_paused','dispatching','running','processing','uncertain') order by j.created_at limit 1;
    if jid is null then
      insert into public.scrape_jobs(owner_user_id,kind,status,results_limit,requested_profiles_count,estimated_cost_usd,manual_authorized_by)
        values(auth.uid(),'carousel','pending',30,1,0,auth.uid()) returning id into jid;
      insert into public.scrape_job_creators(job_id,creator_id) values(jid,cid);
    end if;
    jobs:=array_append(jobs,jid);
  end loop;
  return jsonb_build_object('job_ids',jobs);
end $$;
-- Expand only the kind/authorization lists in the existing transactional spending gate.
do $$
declare def text; f text;
begin
  foreach f in array array['public.transcription_claim_dispatch_core(uuid,boolean,text,text)','public.worker_claim_dispatch(uuid,boolean,text,text)'] loop
    select pg_get_functiondef(f::regprocedure) into def;
    def:=replace(def,'''daily'',''weekly'',''backfill'',''profile'',''manual'',''retry''','''daily'',''weekly'',''backfill'',''profile'',''manual'',''retry'',''carousel''');
    def:=replace(def,'''profile'',''manual''','''profile'',''manual'',''carousel''');
    def:=replace(def,'if s.paused and p_kind in (''daily'',''weekly'',''retry'')','if s.paused and p_kind in (''daily'',''weekly'',''retry'',''carousel'')');
    execute def;
  end loop;
end $$;

-- Delegate cursor/lease/count/error checks to the established ingest path in the same transaction.
alter function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) rename to worker_ingest_page_pre_carousels;
revoke all on function public.worker_ingest_page_pre_carousels(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) from public,anon,authenticated,service_role;
create function public.worker_ingest_page(p_job_id uuid,p_lease_token uuid,p_expected_cursor integer,p_records jsonb,p_errors jsonb,
  p_next_cursor integer,p_finished boolean,p_received_counts jsonb default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; result jsonb; rec jsonb; cid uuid; post_id uuid; fetched timestamptz; fs public.creator_follower_snapshots; n integer:=0;
begin
  perform public.require_service();
  select * into j from public.scrape_jobs where id=p_job_id for update;
  if j.kind is distinct from 'carousel' then
    return public.worker_ingest_page_pre_carousels(p_job_id,p_lease_token,p_expected_cursor,p_records,p_errors,p_next_cursor,p_finished,p_received_counts);
  end if;
  if p_records is null or jsonb_typeof(p_records)<>'array' or jsonb_array_length(p_records)>100 then raise exception 'invalid_page' using errcode='22023'; end if;
  result:=public.worker_ingest_page_pre_carousels(p_job_id,p_lease_token,p_expected_cursor,'[]',p_errors,p_next_cursor,p_finished,p_received_counts);
  if coalesce((result->>'duplicate')::boolean,false) then return result; end if;
  if jsonb_array_length(p_records)>p_next_cursor-p_expected_cursor then raise exception 'invalid_page_count' using errcode='22023'; end if;
  for rec in select value from jsonb_array_elements(p_records) loop
    cid:=(rec->>'creator_id')::uuid; fetched:=(rec->>'fetched_at')::timestamptz;
    if not exists(select 1 from public.scrape_job_creators jc join public.creators c on c.id=jc.creator_id
      where jc.job_id=j.id and c.id=cid and c.username=rec->>'username') then raise exception 'creator_identity_mismatch' using errcode='42501'; end if;
    if fetched is null or fetched>now()+interval '5 minutes' or rec->>'content_type' is distinct from 'carousel'
      or rec->>'shortcode' is null or jsonb_typeof(rec->'slides') is distinct from 'array' or jsonb_array_length(rec->'slides')>20
      or length(coalesce(rec->>'caption_full',''))>10000 then raise exception 'invalid_carousel' using errcode='22023'; end if;
    if rec->>'published_at' is not null and rec->>'published_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$' then raise exception 'invalid_publish_timestamp' using errcode='22023'; end if;
    if exists(select 1 from jsonb_array_elements(rec->'slides') with ordinality s(value,ord)
      where (value->>'position')::integer is distinct from ord::integer or value->>'media_type' is null or value->>'media_type' not in ('image','video','unknown')) then raise exception 'invalid_slides' using errcode='22023'; end if;
    if exists(select 1 from public.carousel_posts where shortcode=rec->>'shortcode' and creator_id<>cid) then raise exception 'shortcode_creator_mismatch' using errcode='42501'; end if;
    insert into public.carousel_posts(creator_id,shortcode,post_url,thumbnail_url,caption,published_at,published_at_raw,published_at_basis,
      slides,latest_likes,latest_comments,likes_state,comments_state,latest_fetched_at,provider)
    values(cid,rec->>'shortcode',rec->>'reel_url',rec->>'thumbnail_url',coalesce(rec->>'caption_full',''),(rec->>'published_at')::timestamptz,
      rec->>'published_at_raw',coalesce(rec->>'published_at_basis','explicit_offset'),rec->'slides',(rec->>'likes')::bigint,(rec->>'comments')::bigint,
      rec->>'likes_state',rec->>'comments_state',fetched,rec->>'provider')
    on conflict(shortcode) do update set post_url=coalesce(excluded.post_url,public.carousel_posts.post_url),
      thumbnail_url=coalesce(excluded.thumbnail_url,public.carousel_posts.thumbnail_url),caption=coalesce(rec->>'caption_full',public.carousel_posts.caption),
      published_at=coalesce(public.carousel_posts.published_at,excluded.published_at),
      published_at_raw=case when public.carousel_posts.published_at is null then excluded.published_at_raw else public.carousel_posts.published_at_raw end,
      published_at_basis=case when public.carousel_posts.published_at is null then excluded.published_at_basis else public.carousel_posts.published_at_basis end,
      slides=case when jsonb_array_length(excluded.slides)>0 then excluded.slides else public.carousel_posts.slides end,
      latest_likes=excluded.latest_likes,latest_comments=excluded.latest_comments,likes_state=excluded.likes_state,comments_state=excluded.comments_state,
      latest_fetched_at=excluded.latest_fetched_at,provider=excluded.provider
      where public.carousel_posts.latest_fetched_at<=excluded.latest_fetched_at returning id into post_id;
    if post_id is null then select id into post_id from public.carousel_posts where shortcode=rec->>'shortcode'; end if;
    select * into fs from public.creator_follower_snapshots where creator_id=cid and captured_at<=fetched order by captured_at desc limit 1;
    insert into public.carousel_metric_snapshots(carousel_id,snapshot_date,fetched_at,likes,comments,likes_state,comments_state,followers_at_snapshot,follower_captured_at)
    values(post_id,(fetched at time zone 'UTC')::date,fetched,(rec->>'likes')::bigint,(rec->>'comments')::bigint,rec->>'likes_state',rec->>'comments_state',fs.followers_count,fs.captured_at)
    on conflict(carousel_id,snapshot_date) do update set fetched_at=excluded.fetched_at,likes=excluded.likes,comments=excluded.comments,
      likes_state=excluded.likes_state,comments_state=excluded.comments_state,followers_at_snapshot=excluded.followers_at_snapshot,follower_captured_at=excluded.follower_captured_at
      where public.carousel_metric_snapshots.fetched_at<=excluded.fetched_at;
    update public.scrape_job_creators set result_count=result_count+1,status='active' where job_id=j.id and creator_id=cid;
    n:=n+1;
  end loop;
  update public.scrape_jobs set returned_records_count=returned_records_count+n where id=j.id;
  return result||jsonb_build_object('accepted',n);
end $$;

alter function public.worker_record_output_summary(uuid,uuid,jsonb) rename to worker_record_output_summary_pre_carousels;
revoke all on function public.worker_record_output_summary_pre_carousels(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.worker_record_output_summary(p_job_id uuid,p_lease_token uuid,p_summary jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_service();
  perform public.worker_record_output_summary_pre_carousels(p_job_id,p_lease_token,p_summary);
  -- Photo rows are intentionally filtered out; accepted carousel count need not equal photo count.
  update public.scrape_job_creators jc set completion_status='completed',status='active'
    from public.scrape_jobs j where j.id=p_job_id and j.kind='carousel' and jc.job_id=j.id and j.output_summary_verified
    and jc.summary_authoritative and jc.error_message is null;
end $$;
alter function public.worker_finish_processing(uuid,uuid) rename to worker_finish_processing_pre_carousels;
revoke all on function public.worker_finish_processing_pre_carousels(uuid,uuid) from public,anon,authenticated,service_role;
create function public.worker_finish_processing(p_job_id uuid,p_lease_token uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j public.scrape_jobs; errors integer;
begin
  perform public.require_service(); select * into j from public.scrape_jobs where id=p_job_id for update;
  if j.kind is distinct from 'carousel' then return public.worker_finish_processing_pre_carousels(p_job_id,p_lease_token); end if;
  if j.status in ('succeeded','partial','failed') then return to_jsonb(j); end if;
  if j.status<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() or not j.dataset_finished then
    raise exception 'not_finished_or_lease_expired' using errcode='40001'; end if;
  select count(*) into errors from public.scrape_job_creators where job_id=j.id and (error_message is not null or completion_status<>'completed');
  update public.scrape_jobs set status=case when errors>0 or not output_summary_verified or provider_terminal_status<>'SUCCEEDED'
    then case when returned_records_count=0 then 'failed' else 'partial' end else 'succeeded' end,
    completed_at=now(),lease_token=null,lease_expires_at=null,
    error_message=case when errors>0 or not output_summary_verified or provider_terminal_status<>'SUCCEEDED' then 'Carousel collection incomplete; existing records preserved' end
    where id=j.id returning * into j;
  -- Do not change creator status, Reel freshness, or transcription queues.
  return to_jsonb(j);
end $$;
revoke all on function public.query_carousels(uuid,jsonb),public.get_carousel_detail(uuid,uuid),public.set_carousel_bookmark(uuid,uuid,boolean,text,text[]),
  public.enqueue_carousel_refresh(uuid,uuid[]),public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb),
  public.worker_record_output_summary(uuid,uuid,jsonb),public.worker_finish_processing(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.query_carousels(uuid,jsonb),public.get_carousel_detail(uuid,uuid),public.set_carousel_bookmark(uuid,uuid,boolean,text,text[]),
  public.enqueue_carousel_refresh(uuid,uuid[]) to authenticated;
grant execute on function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb),
  public.worker_record_output_summary(uuid,uuid,jsonb),public.worker_finish_processing(uuid,uuid) to service_role;

-- Bounded read DTOs only. No queue, budget, provider, Cron, or mutation changes.
create schema research_reads_private;
revoke all on schema research_reads_private from public,anon,authenticated,service_role;

-- Existing workspace/creator, reel publication, and job/creator indexes are reused.
-- Snapshot PK is date-based, not captured_at; this supports as-of follower reads.
create index follower_snapshots_capture_idx on public.creator_follower_snapshots(creator_id,captured_at desc) include(followers_count);
-- Terminal profile jobs must remain queryable, unlike the pending-only dispatch index.
create index jobs_owner_profile_latest_idx on public.scrape_jobs(owner_user_id,created_at desc,id desc) include(status) where kind='profile';

create function research_reads_private.creator_rows(p_workspace_id uuid,p_ids uuid[])
returns table(item jsonb,username text,id uuid) language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('id',c.id,'username',c.username,'display_name',c.display_name,'avatar_url',c.avatar_url,
    'followers_count',c.followers_count,'last_profile_fetch_at',c.last_profile_fetch_at,'status',c.status,
    'last_reels_fetch_at',c.last_reels_fetch_at,'last_error',case when c.last_error is not null then 'The last provider update failed. Existing data has been preserved.' end,
    'tracked_reels',(select count(*) from public.reels r where r.creator_id=c.id),
    'latest_reel_date',(select r.published_at from public.reels r where r.creator_id=c.id and r.published_at is not null order by r.published_at desc,r.id limit 1),
    'initial_backfill_job_id',initial.id,'initial_backfill_status',initial.status)
    ||case when profile.status is not null then jsonb_build_object('profile_job_status',profile.status) else '{}'::jsonb end,
    c.username,c.id
  from public.creators c join public.workspace_creators wc on wc.creator_id=c.id and wc.workspace_id=p_workspace_id and wc.active
  left join public.creator_initializations ci on ci.creator_id=c.id
  left join public.scrape_jobs initial on initial.id=ci.job_id and initial.owner_user_id=auth.uid()
  left join lateral(select j.status from public.scrape_jobs j join public.scrape_job_creators jc on jc.job_id=j.id
    where jc.creator_id=c.id and j.owner_user_id=auth.uid() and j.kind='profile' order by j.created_at desc,j.id desc limit 1) profile on true
  where c.id=any(p_ids);
$$;

create function public.query_creators(p_workspace_id uuid,p_query jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare q jsonb:=p_query; k text; n numeric; pg integer; lim integer; result jsonb;
begin
  perform public.require_workspace(p_workspace_id);
  if q is null or jsonb_typeof(q)<>'object' then raise exception 'invalid_query' using errcode='22023'; end if;
  for k in select jsonb_object_keys(q) loop
    if k='search' then
      if jsonb_typeof(q->k)<>'string' or length(btrim(q->>k))>200 then raise exception 'invalid_query' using errcode='22023'; end if;
      q:=jsonb_set(q,array[k],to_jsonb(btrim(q->>k)));
    elsif k in ('page','limit') then
      if jsonb_typeof(q->k)<>'number' then raise exception 'invalid_query' using errcode='22023'; end if;
      n:=(q->>k)::numeric;
      if n<>trunc(n) or n<1 or n>(case when k='page' then 10000 else 50 end) then raise exception 'invalid_query' using errcode='22023'; end if;
    else raise exception 'invalid_query' using errcode='22023'; end if;
  end loop;
  pg:=coalesce((q->>'page')::integer,1); lim:=coalesce((q->>'limit')::integer,50);
  -- Count and select the page before any per-creator reel/profile enrichment.
  -- POSITION is case-insensitive literal substring search: %, _, and \ are not wildcards.
  with scoped as materialized(
    select c.id,c.username from public.creators c join public.workspace_creators wc on wc.creator_id=c.id
    where wc.workspace_id=p_workspace_id and wc.active
      and (coalesce(q->>'search','')='' or position(lower(q->>'search') in lower(c.username||' '||coalesce(c.display_name,'')))>0)
  ), page_ids as materialized(select id from scoped order by username collate "C",id limit lim offset (pg-1)*lim)
  select jsonb_build_object('items',coalesce((select jsonb_agg(e.item order by e.username collate "C",e.id)
    from research_reads_private.creator_rows(p_workspace_id,array(select id from page_ids)) e),'[]'::jsonb),
    'total',(select count(*) from scoped),'page',pg,'limit',lim) into result;
  return result;
end $$;

create function public.list_creator_directory(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  perform public.require_workspace(p_workspace_id);
  return coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'username',c.username,'display_name',c.display_name,
    'avatar_url',c.avatar_url,'status',c.status) order by c.username collate "C",c.id)
    from public.creators c join public.workspace_creators wc on wc.creator_id=c.id
    where wc.workspace_id=p_workspace_id and wc.active),'[]'::jsonb);
end $$;

create function public.get_creator(p_workspace_id uuid,p_creator_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
  perform public.require_workspace(p_workspace_id);
  select item into result from research_reads_private.creator_rows(p_workspace_id,array[p_creator_id]);
  if result is null then raise exception 'creator_not_found' using errcode='P0002'; end if;
  return result;
end $$;

create function public.get_creator_collection_summary(p_workspace_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare owner_id uuid:=auth.uid(); s public.app_settings; reason text; blocking_id uuid;
  month_start date:=date_trunc('month',now() at time zone 'UTC')::date;
  committed numeric; reserved numeric; active_count bigint; pending_count bigint; scoped_active_count bigint; accounts jsonb;
begin
  perform public.require_workspace(p_workspace_id);
  select * into s from public.app_settings where owner_user_id=owner_id;
  -- Full owner ledger: unknown charges in other workspaces/months/kinds still block.
  select j.id into blocking_id from public.scrape_jobs j where j.owner_user_id=owner_id and j.live and
    (j.status='uncertain' or j.status in ('succeeded','partial','failed') and j.actual_cost_usd is null
      or j.provider_terminal_status is not null and j.actual_cost_usd is null)
    order by j.created_at,j.id limit 1;
  select coalesce(sum(j.actual_cost_usd) filter(where j.live and j.billing_month=month_start),0),
    coalesce(sum(j.reserved_usd) filter(where j.live),0),
    count(*) filter(where j.status in ('dispatching','running','processing','uncertain'))
    into committed,reserved,active_count from public.scrape_jobs j where j.owner_user_id=owner_id;
  -- Same reason precedence as the command-internal multiaccount collection state.
  accounts:=apify_accounts_private.status(owner_id);
  if blocking_id is not null and (accounts->>'ready_accounts')::integer=0 then reason:='unreconciled_charges';
  elsif not s.scraping_enabled then reason:='scraping_disabled';
  elsif not s.initial_backfill_enabled then reason:='initial_import_disabled';
  elsif s.monthly_budget_usd-committed-reserved<=0 then reason:='budget_paused';
  elsif active_count>=coalesce((select max_active from public.collection_worker_settings where owner_user_id=owner_id),2) then reason:='concurrency_limit';
  elsif (accounts->>'ready_accounts')::integer=0 then
    if blocking_id is not null then reason:='unreconciled_charges';
    elsif exists(select 1 from jsonb_array_elements(accounts->'accounts') a where a->>'reason'='account_capacity_full') then reason:='concurrency_limit';
    elsif exists(select 1 from jsonb_array_elements(accounts->'accounts') a where a->>'reason'='allowance_exhausted') then reason:='budget_paused';
    else reason:='usage_unverified'; end if;
  end if;
  -- EXISTS counts a shared/batched job exactly once. No IDs/profile map is built.
  select count(*) filter(where j.status in ('pending','budget_paused')),
    count(*) filter(where j.status in ('dispatching','running','processing','uncertain'))
    into pending_count,scoped_active_count from public.scrape_jobs j
    where j.owner_user_id=owner_id and j.kind<>'carousel' and j.status in ('pending','budget_paused','dispatching','running','processing','uncertain')
      and exists(select 1 from public.scrape_job_creators jc join public.workspace_creators wc on wc.creator_id=jc.creator_id
        where jc.job_id=j.id and wc.workspace_id=p_workspace_id and wc.active);
  return jsonb_build_object('reason',reason,'blocking_job_id',blocking_id,'pending_jobs',pending_count,'active_jobs',scoped_active_count);
end $$;

-- The legacy full Carousel and lightweight gallery DTO share this query, not a
-- wrapper around an already enriched JSON full-history result. Baselines are
-- required for every candidate only when they affect filtering/order; otherwise
-- calculate the exact earlier-30 median once for each visible post.
create function research_reads_private.query_carousels(p_workspace_id uuid,p_query jsonb,p_summary boolean) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare q jsonb; pg integer; lim integer; ordering text; result jsonb; needs_profile boolean;
  today date:=(current_timestamp at time zone 'Asia/Kolkata')::date; start_date date;
  period_from timestamptz; period_until timestamptz;
begin
  perform public.require_workspace(p_workspace_id);
  q:=public.validate_carousel_query(p_query);
  pg:=coalesce((q->>'page')::integer,1); lim:=coalesce((q->>'limit')::integer,30); ordering:=coalesce(q->>'sort','latest');
  needs_profile:=ordering='profile_outlier' or q ?| array['min_profile_outlier','max_profile_outlier'];
  if q ? 'posted_amount' then
    start_date:=case when q->>'posted_unit'='months' then (today::timestamp-make_interval(months=>(q->>'posted_amount')::integer))::date
      else today-(q->>'posted_amount')::integer*case when q->>'posted_unit'='weeks' then 7 else 1 end end;
    period_from:=start_date::timestamp at time zone 'Asia/Kolkata'; period_until:=(today+1)::timestamp at time zone 'Asia/Kolkata';
  end if;
  with candidates as materialized(
    select c.id,c.creator_id,c.published_at,c.latest_likes,c.latest_comments,c.likes_state,c.comments_state,
      fs.followers_count,fs.captured_at follower_captured_at,s.carousel_id is not null saved,coalesce(s.note,'') note,coalesce(s.tags,'{}') tags,
      case when c.likes_state='known' and c.comments_state='known' then c.latest_likes::numeric+c.latest_comments::numeric end interactions,
      case when c.likes_state='known' and c.comments_state='known' and fs.followers_count>0 then 100*(c.latest_likes::numeric+c.latest_comments::numeric)/fs.followers_count end follower_engagement_pct,
      case when c.likes_state='known' and c.comments_state='known' and fs.followers_count>0 then (c.latest_likes::numeric+c.latest_comments::numeric)/fs.followers_count end follower_outlier_score
    from public.carousel_posts c join public.creators cr on cr.id=c.creator_id
    join public.workspace_creators wc on wc.creator_id=c.creator_id and wc.workspace_id=p_workspace_id and wc.active
    left join public.saved_carousels s on s.carousel_id=c.id and s.workspace_id=p_workspace_id
    left join lateral(select followers_count,captured_at from public.creator_follower_snapshots f where f.creator_id=c.creator_id and f.captured_at<=c.latest_fetched_at order by captured_at desc limit 1) fs on true
    where (not q ? 'creator' or c.creator_id=(q->>'creator')::uuid)
      and (not q ? 'creator_ids' or c.creator_id in (select v::uuid from jsonb_array_elements_text(q->'creator_ids') v))
      and (not coalesce((q->>'saved')::boolean,false) or s.carousel_id is not null)
      and (period_from is null or c.published_at>=period_from and c.published_at<period_until)
      and (coalesce(q->>'search','')='' or position(lower(q->>'search') in lower(c.caption||' '||cr.username))>0)
      and (coalesce(q->>'keywords','')='' or position(lower(q->>'keywords') in lower(c.caption||' '||cr.username))>0)
  ), filtered as materialized(
    select c.*,baseline.sample,baseline.median,
      case when baseline.sample>=10 and baseline.median>0 then c.interactions/nullif(baseline.median,0) end profile_outlier_score
    from candidates c left join lateral(select count(*)::integer sample,percentile_cont(.5) within group(order by interactions)::numeric median from (
      select p.latest_likes::numeric+p.latest_comments::numeric interactions from public.carousel_posts p
      where needs_profile and p.creator_id=c.creator_id and p.published_at<c.published_at and p.likes_state='known' and p.comments_state='known'
      order by p.published_at desc,p.id limit 30) prior) baseline on needs_profile
    where (not q ? 'min_interactions' or c.interactions>=(q->>'min_interactions')::numeric)
      and (not q ? 'min_outlier' or c.follower_outlier_score>=(q->>'min_outlier')::numeric)
      and (not q ? 'max_outlier' or c.follower_outlier_score<=(q->>'max_outlier')::numeric)
      and (not q ? 'min_engagement' or c.follower_engagement_pct>=(q->>'min_engagement')::numeric)
      and (not q ? 'max_engagement' or c.follower_engagement_pct<=(q->>'max_engagement')::numeric)
      and (not q ? 'min_profile_outlier' or baseline.sample>=10 and baseline.median>0 and c.interactions/nullif(baseline.median,0)>=(q->>'min_profile_outlier')::numeric)
      and (not q ? 'max_profile_outlier' or baseline.sample>=10 and baseline.median>0 and c.interactions/nullif(baseline.median,0)<=(q->>'max_profile_outlier')::numeric)
  ), page_rows as materialized(
    select * from filtered order by
      case when ordering='likes' then latest_likes end desc nulls last,
      case when ordering='comments' then latest_comments end desc nulls last,
      case when ordering='profile_outlier' then profile_outlier_score end desc nulls last,
      case when ordering='follower_engagement' then follower_engagement_pct end desc nulls last,
      published_at desc nulls last,id limit lim offset (pg-1)*lim
  ), enriched as (
    select p.*,
      case when needs_profile then p.sample else visible.sample end baseline_sample,
      case when needs_profile then p.median else visible.median end baseline_median,
      c.shortcode,c.post_url,c.thumbnail_url,c.caption,c.slides,c.published_at_raw,c.published_at_basis,c.latest_fetched_at,c.provider,
      cr.username,cr.display_name,cr.avatar_url
    from page_rows p join public.carousel_posts c on c.id=p.id join public.creators cr on cr.id=c.creator_id
    left join lateral(select count(*)::integer sample,percentile_cont(.5) within group(order by interactions)::numeric median from (
      select prior.latest_likes::numeric+prior.latest_comments::numeric interactions from public.carousel_posts prior
      where not needs_profile and prior.creator_id=p.creator_id and prior.published_at<p.published_at and prior.likes_state='known' and prior.comments_state='known'
      order by prior.published_at desc,prior.id limit 30) history) visible on not needs_profile
  ), output as (
    select e.*,jsonb_build_object('id',id,'creator_id',creator_id,'shortcode',shortcode,'post_url',post_url,
      'thumbnail_url',case when p_summary then coalesce(thumbnail_url,slides->0->>'image_url') else thumbnail_url end,
      'published_at',published_at,'published_at_raw',published_at_raw,'published_at_basis',published_at_basis,
      'latest_likes',latest_likes,'latest_comments',latest_comments,'likes_state',likes_state,'comments_state',comments_state,
      'latest_fetched_at',latest_fetched_at,'provider',provider,'username',username,'display_name',display_name,'avatar_url',avatar_url,
      'followers_count',followers_count,'follower_captured_at',follower_captured_at,'saved',saved,'note',note,'tags',tags,
      'interactions',interactions,'follower_engagement_pct',follower_engagement_pct,'follower_outlier_score',follower_outlier_score,
      'profile_baseline_sample',baseline_sample,'profile_baseline_interactions',case when baseline_sample>=10 then baseline_median end,
      'profile_outlier_score',case when baseline_sample>=10 and baseline_median>0 then interactions/baseline_median end)
      ||case when p_summary then jsonb_build_object('caption_preview',left(caption,500),'slide_count',jsonb_array_length(slides))
        else jsonb_build_object('caption',caption,'slides',slides) end item from enriched e
  ) select jsonb_build_object('items',coalesce((select jsonb_agg(item order by
      case when ordering='likes' then latest_likes end desc nulls last,
      case when ordering='comments' then latest_comments end desc nulls last,
      case when ordering='profile_outlier' then profile_outlier_score end desc nulls last,
      case when ordering='follower_engagement' then follower_engagement_pct end desc nulls last,
      published_at desc nulls last,id) from output),'[]'::jsonb),
    'total',(select count(*) from filtered),'page',pg,'limit',lim) into result;
  return result;
end $$;
create or replace function public.query_carousels(p_workspace_id uuid,p_query jsonb default '{}') returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
  select research_reads_private.query_carousels(p_workspace_id,p_query,false);
$$;
create function public.query_carousel_summaries(p_workspace_id uuid,p_query jsonb default '{}') returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
  select research_reads_private.query_carousels(p_workspace_id,p_query,true);
$$;

-- Keep navigation's established ordered helper untouched. For profile criteria
-- the same helper is still required. Other sorts/filters count/order base rows
-- first, then build public JSON, tags, and expensive profile baselines only for
-- the visible page. This does not call the all-history JSON helper on that path.
create or replace function public.query_reels(p_workspace_id uuid,p_query jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare q jsonb; pg integer; lim integer; sort_key text; freshness text; creator_ids uuid[]; result jsonb;
begin
  perform public.require_workspace(p_workspace_id);
  q:=public.validate_reel_query(p_query);
  pg:=coalesce((q->>'page')::integer,1); lim:=coalesce((q->>'limit')::integer,30);
  sort_key:=coalesce(q->>'sort','published_at'); freshness:=coalesce(q->>'freshness','all');
  if sort_key='profile_outlier' or q ?| array['min_profile_outlier','max_profile_outlier'] then
    with ordered as materialized(select * from reel_detail_private.ordered_reels(p_workspace_id,q))
    select jsonb_build_object('items',coalesce((select jsonb_agg(item order by ordinal) from ordered where ordinal>(pg-1)*lim and ordinal<=pg*lim),'[]'::jsonb),
      'total',(select count(*) from ordered),'page',pg,'limit',lim) into result;
    return result;
  end if;
  if q ? 'creator_ids' then select coalesce(array_agg(value::uuid),'{}'::uuid[]) into creator_ids from jsonb_array_elements_text(q->'creator_ids'); end if;
  with scoped as materialized(
    select r.id,r.published_at,r.latest_views,r.latest_likes,r.latest_comments,
      case when r.views_state='known' and r.likes_state='known' and r.comments_state='known' and c.followers_count>0
        then (r.latest_views::numeric+r.latest_likes+r.latest_comments)/c.followers_count end follower_outlier_score,
      case when r.views_state='known' and r.likes_state='known' and r.comments_state='known' and r.latest_views>0
        then 100.0*(r.latest_likes::numeric+r.latest_comments)/r.latest_views end engagement_rate_pct
    from public.reels r join public.creators c on c.id=r.creator_id
    join public.workspace_creators wc on wc.creator_id=r.creator_id and wc.workspace_id=p_workspace_id and wc.active
    left join public.saved_reels s on s.workspace_id=p_workspace_id and s.reel_id=r.id
    where (not(q ? 'search') or c.username ilike '%'||(q->>'search')||'%' or r.caption_preview ilike '%'||(q->>'search')||'%')
      and (not(q ? 'keywords') or strpos(lower(r.caption_preview),lower(q->>'keywords'))>0)
      and (not(q ? 'creator_id') or r.creator_id=(q->>'creator_id')::uuid)
      and (not(q ? 'creator_ids') or r.creator_id=any(creator_ids))
      and (not(q ? 'min_views') or r.latest_views>=(q->>'min_views')::numeric)
      and (not(q ? 'max_views') or r.latest_views<=(q->>'max_views')::numeric)
      and (not(q ? 'from') or r.published_at>=((q->>'from')::date::timestamp at time zone 'Asia/Kolkata'))
      and (not(q ? 'to') or r.published_at<(((q->>'to')::date+1)::timestamp at time zone 'Asia/Kolkata'))
      and (not(q ? 'platform') or r.platform=q->>'platform')
      and (not(q ? 'saved') or (s.reel_id is not null)=(q->>'saved')::boolean)
      and (not(q ? 'status') or c.status=q->>'status')
      and (freshness='all' or freshness='fresh' and r.latest_fetched_at>=now()-interval '48 hours' or freshness='stale' and r.latest_fetched_at<now()-interval '48 hours')
  ), filtered as materialized(
    select * from scoped r where
      (not(q ? 'min_engagement') or r.engagement_rate_pct>=(q->>'min_engagement')::numeric)
      and (not(q ? 'max_engagement') or r.engagement_rate_pct<=(q->>'max_engagement')::numeric)
      and (not(q ? 'min_outlier') or r.follower_outlier_score>=(q->>'min_outlier')::numeric)
      and (not(q ? 'max_outlier') or r.follower_outlier_score<=(q->>'max_outlier')::numeric)
  ), page_rows as materialized(
    select *,row_number() over(order by
      case when sort_key='published_at' then published_at end desc nulls last,
      case when sort_key='views' then latest_views end desc nulls last,
      case when sort_key='likes' then latest_likes end desc nulls last,
      case when sort_key='comments' then latest_comments end desc nulls last,
      case when sort_key='engagement' then engagement_rate_pct end desc nulls last,
      case when sort_key='outlier' then follower_outlier_score end desc nulls last,id) rn from filtered
    order by rn limit lim offset (pg-1)*lim
  ), enriched as (
    select r.*,s.reel_id is not null saved,coalesce(s.note,'') note,coalesce(s.completion_status,'pending') completion_status,
      coalesce((select array_agg(t.tag order by t.tag) from public.reel_tags t where t.workspace_id=p_workspace_id and t.reel_id=r.id),'{}'::text[]) tags,p.rn
    from page_rows p join lateral(select rs.* from public.reels_summary rs where rs.id=p.id offset 0) r on true
    left join public.saved_reels s on s.workspace_id=p_workspace_id and s.reel_id=r.id
  ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(e)-'rn' order by rn) from enriched e),'[]'::jsonb),
    'total',(select count(*) from filtered),'page',pg,'limit',lim) into result;
  return result;
end $$;

revoke all on all functions in schema research_reads_private from public,anon,authenticated,service_role;
revoke all on function public.query_creators(uuid,jsonb),public.list_creator_directory(uuid),public.get_creator(uuid,uuid),
  public.get_creator_collection_summary(uuid),public.query_carousels(uuid,jsonb),public.query_carousel_summaries(uuid,jsonb),public.query_reels(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.query_creators(uuid,jsonb),public.list_creator_directory(uuid),public.get_creator(uuid,uuid),
  public.get_creator_collection_summary(uuid),public.query_carousels(uuid,jsonb),public.query_carousel_summaries(uuid,jsonb),public.query_reels(uuid,jsonb) to authenticated;

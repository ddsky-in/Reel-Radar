-- Profile Outlier = views / median of up to 30 strictly earlier known-view Reels.
-- Minimum 10 comparisons; zero views are valid data, zero median gives no score.
-- Mirrors src/lib/metrics.ts. Baselines ignore user filters, saved state and pages.
-- Latest stored snapshots only; this is not adjusted for Reel age.
-- Append to the security-invoker view so list, detail and overview share one formula.
-- Existing follower and engagement formulas and public RPC signatures are unchanged.
create index reels_profile_baseline_idx on public.reels(creator_id,published_at desc,id) include(latest_views)
 where views_state='known' and latest_views>=0;

create or replace view public.reels_summary with (security_invoker=true) as
select r.id,r.creator_id,r.instagram_media_id,r.shortcode,r.reel_url,r.thumbnail_url,r.caption_preview,
 r.published_at,r.duration_seconds,r.latest_views,r.latest_likes,r.latest_comments,r.views_state,r.likes_state,r.comments_state,
 r.latest_fetched_at,r.first_seen_at,r.provider,
 c.username,c.display_name,c.avatar_url,c.followers_count,c.last_profile_fetch_at as follower_captured_at,c.status as creator_status,
 case when r.views_state='known' and r.likes_state='known' and r.comments_state='known' and c.followers_count>0
 then (r.latest_views::numeric+r.latest_likes+r.latest_comments)/c.followers_count end as follower_outlier_score,
 case when r.views_state='known' and r.likes_state='known' and r.comments_state='known' and r.latest_views>0
 then 100.0*(r.latest_likes::numeric+r.latest_comments)/r.latest_views end as engagement_rate_pct,
 r.published_at_raw,r.published_at_basis,
 case when r.views_state='known' and baseline.median>0 then r.latest_views::numeric/baseline.median end as profile_outlier_score,
 baseline.median as profile_baseline_views, history.sample as profile_baseline_sample
from public.reels r join public.creators c on c.id=r.creator_id
cross join lateral (
 select count(*)::integer as sample, array_agg(p.latest_views order by p.latest_views) as views from (
  select previous.latest_views from public.reels previous
  where previous.creator_id=r.creator_id and previous.published_at<r.published_at
    and previous.id<>r.id and previous.views_state='known' and previous.latest_views>=0
  order by previous.published_at desc,previous.id limit 30
 ) p
) history
cross join lateral (
 select case when history.sample>=10 then
  (history.views[(history.sample+1)/2]::numeric+history.views[(history.sample+2)/2]::numeric)/2 end as median
) baseline;
revoke all on public.reels_summary from public,anon,authenticated,service_role;
grant select on public.reels_summary to authenticated,service_role;


create or replace function public.validate_reel_query(q jsonb) returns jsonb
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
  'min_outlier','max_outlier','min_profile_outlier','max_profile_outlier','keywords','from','to','posted_amount','posted_unit',
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
 if q ? 'sort' and q->>'sort' not in ('published_at','views','likes','comments','engagement','outlier','profile_outlier') then raise exception 'invalid_query' using errcode = '22023'; end if;
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
 foreach k in array array['min_views','max_views','min_engagement','max_engagement','min_outlier','max_outlier','min_profile_outlier','max_profile_outlier'] loop
  if q ? k then
   if jsonb_typeof(q->k) <> 'number' then raise exception 'invalid_threshold' using errcode = '22023'; end if;
   n := (q->>k)::numeric; upper_bound := case when k in ('min_views','max_views') then 10000000 when k in ('min_profile_outlier','max_profile_outlier') then 1000000 else 100 end;
   if n < 0 or n > upper_bound or (k in ('min_views','max_views') and n <> trunc(n)) then
    raise exception 'invalid_threshold' using errcode = '22023';
   end if;
  end if;
 end loop;
 foreach k in array array['views','engagement','outlier','profile_outlier'] loop
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


create or replace function reel_detail_private.ordered_reels(p_workspace_id uuid,p_query jsonb) returns table(item jsonb,ordinal bigint)
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare q jsonb; sort_key text; freshness text; creator_ids uuid[];
begin
  if auth.uid() is null or not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  perform public.require_workspace(p_workspace_id);
  q:=public.validate_reel_query(p_query);
  sort_key:=coalesce(q->>'sort','published_at'); freshness:=coalesce(q->>'freshness','all');
  if q ? 'creator_ids' then select coalesce(array_agg(value::uuid),'{}'::uuid[]) into creator_ids from jsonb_array_elements_text(q->'creator_ids'); end if;
  return query with scoped as (
    select r.*,s.reel_id is not null as saved,coalesce(s.note,'') as note,coalesce(s.completion_status,'pending') as completion_status,
      coalesce((select array_agg(t.tag order by t.tag) from public.reel_tags t where t.workspace_id=p_workspace_id and t.reel_id=r.id),'{}'::text[]) as tags
    from public.reels_summary r join public.workspace_creators wc on wc.creator_id=r.creator_id and wc.workspace_id=p_workspace_id and wc.active
    join public.reels base on base.id=r.id left join public.saved_reels s on s.workspace_id=p_workspace_id and s.reel_id=r.id
    where (not(q ? 'search') or r.username ilike '%'||(q->>'search')||'%' or r.caption_preview ilike '%'||(q->>'search')||'%')
      and (not(q ? 'keywords') or strpos(lower(r.caption_preview),lower(q->>'keywords'))>0)
      and (not(q ? 'creator_id') or r.creator_id=(q->>'creator_id')::uuid)
      and (not(q ? 'creator_ids') or r.creator_id=any(creator_ids))
      and (not(q ? 'min_views') or r.latest_views>=(q->>'min_views')::numeric)
      and (not(q ? 'max_views') or r.latest_views<=(q->>'max_views')::numeric)
      and (not(q ? 'min_engagement') or r.engagement_rate_pct>=(q->>'min_engagement')::numeric)
      and (not(q ? 'max_engagement') or r.engagement_rate_pct<=(q->>'max_engagement')::numeric)
      and (not(q ? 'min_outlier') or r.follower_outlier_score>=(q->>'min_outlier')::numeric)
      and (not(q ? 'max_outlier') or r.follower_outlier_score<=(q->>'max_outlier')::numeric)
      and (not(q ? 'min_profile_outlier') or r.profile_outlier_score>=(q->>'min_profile_outlier')::numeric)
      and (not(q ? 'max_profile_outlier') or r.profile_outlier_score<=(q->>'max_profile_outlier')::numeric)
      and (not(q ? 'from') or r.published_at>=((q->>'from')::date::timestamp at time zone 'Asia/Kolkata'))
      and (not(q ? 'to') or r.published_at<(((q->>'to')::date+1)::timestamp at time zone 'Asia/Kolkata'))
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
      case when sort_key='outlier' then follower_outlier_score end desc nulls last,
      case when sort_key='profile_outlier' then profile_outlier_score end desc nulls last,id) as rn from scoped
  ) select to_jsonb(o)-'rn',o.rn from ordered o;
end $$;
revoke all on function reel_detail_private.ordered_reels(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function reel_detail_private.ordered_reels(uuid,jsonb) to authenticated;


-- Forward-only creator read enrichment. Counts are full stored posts, not a
-- filtered/paginated gallery, snapshots, slides, or provider-reported totals.
-- Reuse carousel_creator_publication's leading creator_id for indexed count(*).
-- CREATE OR REPLACE preserves function identities/ACLs and the private schema.
-- No mutation, trigger, queue, budget, provider, Cron, or network changes.
create or replace function research_reads_private.creator_rows(p_workspace_id uuid,p_ids uuid[])
returns table(item jsonb,username text,id uuid) language sql stable security definer set search_path=pg_catalog,public as $$
  select jsonb_build_object('id',c.id,'username',c.username,'display_name',c.display_name,'avatar_url',c.avatar_url,
    'followers_count',c.followers_count,'last_profile_fetch_at',c.last_profile_fetch_at,'status',c.status,
    'last_reels_fetch_at',c.last_reels_fetch_at,'last_error',case when c.last_error is not null then 'The last provider update failed. Existing data has been preserved.' end,
    'tracked_reels',(select count(*) from public.reels r where r.creator_id=c.id),
    'tracked_carousels',(select count(*) from public.carousel_posts p where p.creator_id=c.id),
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

create or replace function public.list_creators(p_workspace_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
 perform public.require_workspace(p_workspace_id);
 return coalesce((select jsonb_agg(to_jsonb(x) order by x.username) from (
 select c.id,c.username,c.display_name,c.avatar_url,c.followers_count,c.last_profile_fetch_at,c.status,c.last_reels_fetch_at,c.last_error,
 (select count(*) from public.reels r where r.creator_id=c.id) tracked_reels,
 (select count(*) from public.carousel_posts p where p.creator_id=c.id) tracked_carousels,
 (select max(r.published_at) from public.reels r where r.creator_id=c.id) latest_reel_date,
 ci.job_id initial_backfill_job_id,j.status initial_backfill_status
 from public.creators c join public.workspace_creators wc on wc.creator_id=c.id left join public.creator_initializations ci on ci.creator_id=c.id left join public.scrape_jobs j on j.id=ci.job_id
 where wc.workspace_id=p_workspace_id and wc.active) x),'[]'::jsonb);
end; $$;

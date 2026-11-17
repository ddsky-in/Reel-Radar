-- Preserve provider wall-clock text without inventing a timezone or changing existing dates.
alter table public.reels alter column published_at drop not null;
alter table public.reels add column published_at_raw text;
alter table public.reels add column published_at_basis text not null default 'explicit_offset';
alter table public.reels add constraint reels_publish_timestamp_basis_check check (
 case published_at_basis
 when 'explicit_offset' then published_at is not null and (
  published_at_raw is null or case when published_at_raw ~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$'
   then substring(published_at_raw from 1 for 19)::timestamp is not null else false end)
 when 'timezone_unverified' then published_at is null and published_at_raw is not null and
  case when published_at_raw ~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?$'
   then published_at_raw::timestamp is not null else false end
 else false end
);

-- CREATE OR REPLACE must retain every existing view column position. Append only.
create or replace view public.reels_summary with (security_invoker=true) as
select r.id,r.creator_id,r.instagram_media_id,r.shortcode,r.reel_url,r.thumbnail_url,r.caption_preview,
 r.published_at,r.duration_seconds,r.latest_views,r.latest_likes,r.latest_comments,r.views_state,r.likes_state,r.comments_state,
 r.latest_fetched_at,r.first_seen_at,r.provider,
 c.username,c.display_name,c.avatar_url,c.followers_count,c.last_profile_fetch_at as follower_captured_at,c.status as creator_status,
 case when r.views_state='known' and r.likes_state='known' and r.comments_state='known' and c.followers_count>0
 then (r.latest_views::numeric+r.latest_likes+r.latest_comments)/c.followers_count end as follower_outlier_score,
 case when r.views_state='known' and r.likes_state='known' and r.comments_state='known' and r.latest_views>0
 then 100.0*(r.latest_likes::numeric+r.latest_comments)/r.latest_views end as engagement_rate_pct,
 r.published_at_raw,r.published_at_basis
from public.reels r join public.creators c on c.id=r.creator_id;
revoke all on public.reels_summary from public,anon,authenticated,service_role;
grant select on public.reels_summary to authenticated,service_role;

-- Same eight-argument RPC, lease checks, received counts and snapshots as migration 003.
create or replace function public.worker_ingest_page(p_job_id uuid,p_lease_token uuid,p_expected_cursor integer,p_records jsonb,p_errors jsonb,p_next_cursor integer,p_finished boolean,p_received_counts jsonb default null) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.scrape_jobs; rec jsonb; er jsonb; cid uuid; rid uuid; old_creator uuid; fetched timestamptz; fs public.creator_follower_snapshots; accepted integer:=0; counts jsonb; kv record; received integer:=0;
begin
 perform public.require_service(); select * into j from public.scrape_jobs where id=p_job_id for update;
 if not found or j.status<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'lease_expired' using errcode='40001'; end if;
 if j.dataset_cursor<>p_expected_cursor or j.dataset_finished then return jsonb_build_object('cursor',j.dataset_cursor,'duplicate',true); end if;
 if p_records is null or p_errors is null or p_expected_cursor is null or p_next_cursor is null or jsonb_typeof(p_records)<>'array' or jsonb_typeof(p_errors)<>'array' or jsonb_array_length(p_records)>100 or jsonb_array_length(p_errors)>100 or p_next_cursor<p_expected_cursor or p_next_cursor>p_expected_cursor+100 or p_finished is null or p_next_cursor=p_expected_cursor and (not p_finished or jsonb_array_length(p_records)>0 or jsonb_array_length(p_errors)>0) then raise exception 'invalid_page' using errcode='22023'; end if;
 if p_received_counts is not null and jsonb_typeof(p_received_counts)<>'object' then raise exception 'invalid_received_counts' using errcode='22023'; end if;
 counts:=coalesce(p_received_counts,'{}'::jsonb);
 -- Legacy calls infer normalized rows; live workers pass explicit raw per-creator counts.
 if p_received_counts is null then
  select coalesce(jsonb_object_agg(x.creator_id,x.n),'{}'::jsonb) into counts from (
   select value->>'creator_id' creator_id,count(*) n from (
    select value from jsonb_array_elements(p_records) union all select value from jsonb_array_elements(p_errors)
   ) raw_rows group by value->>'creator_id'
  ) x;
 end if;
 for kv in select key,value from jsonb_each(counts) loop
  if kv.key !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   or jsonb_typeof(kv.value)<>'number' or kv.value::text !~ '^\d+$' or (kv.value::text)::numeric>100 then raise exception 'invalid_received_counts' using errcode='22023'; end if;
  if not exists(select 1 from public.scrape_job_creators where job_id=j.id and creator_id=kv.key::uuid) then raise exception 'creator_identity_mismatch' using errcode='42501'; end if;
  received:=received+(kv.value::text)::integer;
 end loop;
 if received>p_next_cursor-p_expected_cursor then raise exception 'invalid_received_counts' using errcode='22023'; end if;
 for rec in select value from jsonb_array_elements(p_records) loop
  cid:=(rec->>'creator_id')::uuid;
  if not exists(select 1 from public.scrape_job_creators jc join public.creators c on c.id=jc.creator_id where jc.job_id=j.id and jc.creator_id=cid and c.username=rec->>'username') then raise exception 'creator_identity_mismatch' using errcode='42501'; end if;
  fetched:=(rec->>'fetched_at')::timestamptz;
  if fetched is null or fetched>now()+interval '5 minutes' then raise exception 'invalid_fetch_timestamp' using errcode='22023'; end if;
  if j.kind='profile' then
   if rec->>'followers_count' is null then
    update public.scrape_job_creators set status='failed',error_message='Follower metric unavailable' where job_id=j.id and creator_id=cid; continue;
   end if;
   insert into public.creator_follower_snapshots(creator_id,captured_date,followers_count,source,captured_at) values(cid,(fetched at time zone 'UTC')::date,(rec->>'followers_count')::bigint,rec->>'provider',fetched)
   on conflict(creator_id,captured_date) do update set followers_count=excluded.followers_count,source=excluded.source,captured_at=excluded.captured_at where public.creator_follower_snapshots.captured_at<=excluded.captured_at;
   update public.creators set followers_count=(rec->>'followers_count')::bigint,last_profile_fetch_at=fetched,display_name=coalesce(rec->>'display_name',display_name),avatar_url=coalesce(rec->>'avatar_url',avatar_url)
   where id=cid and (last_profile_fetch_at is null or last_profile_fetch_at<=fetched);
  else
   -- Never cast a naive provider publication value to timestamptz/session timezone.
   if rec->>'published_at' is not null and rec->>'published_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$' then raise exception 'invalid_publish_timestamp' using errcode='22023'; end if;
   if rec->>'instagram_media_id' is not null and rec->>'instagram_media_id' !~ '^\d{1,40}(_\d{1,40})?$' then raise exception 'invalid_media_id' using errcode='22023'; end if;
   select creator_id into old_creator from public.reels where shortcode=rec->>'shortcode';
   if old_creator is not null and old_creator<>cid then raise exception 'shortcode_creator_mismatch' using errcode='42501'; end if;
   select * into fs from public.creator_follower_snapshots where creator_id=cid and captured_at<=fetched and followers_count>0 order by captured_at desc limit 1;
   insert into public.reels(creator_id,instagram_media_id,shortcode,reel_url,thumbnail_url,caption_preview,published_at,duration_seconds,latest_views,latest_likes,latest_comments,views_state,likes_state,comments_state,latest_fetched_at,provider,published_at_raw,published_at_basis)
   values(cid,rec->>'instagram_media_id',rec->>'shortcode',rec->>'reel_url',rec->>'thumbnail_url',coalesce(rec->>'caption_preview',''),(rec->>'published_at')::timestamptz,(rec->>'duration_seconds')::numeric,(rec->>'views')::bigint,(rec->>'likes')::bigint,(rec->>'comments')::bigint,rec->>'views_state',rec->>'likes_state',rec->>'comments_state',fetched,rec->>'provider',rec->>'published_at_raw',coalesce(rec->>'published_at_basis','explicit_offset'))
   on conflict(shortcode) do update set instagram_media_id=coalesce(public.reels.instagram_media_id,excluded.instagram_media_id),reel_url=excluded.reel_url,thumbnail_url=excluded.thumbnail_url,caption_preview=excluded.caption_preview,duration_seconds=excluded.duration_seconds,
   published_at=coalesce(public.reels.published_at,excluded.published_at),
   published_at_raw=case when public.reels.published_at is null then excluded.published_at_raw else public.reels.published_at_raw end,
   published_at_basis=case when public.reels.published_at is null then excluded.published_at_basis else public.reels.published_at_basis end,
   latest_views=excluded.latest_views,latest_likes=excluded.latest_likes,latest_comments=excluded.latest_comments,views_state=excluded.views_state,likes_state=excluded.likes_state,comments_state=excluded.comments_state,latest_fetched_at=excluded.latest_fetched_at,provider=excluded.provider
   where public.reels.creator_id=excluded.creator_id and public.reels.latest_fetched_at<=excluded.latest_fetched_at returning id into rid;
   if rid is null then select id into rid from public.reels where shortcode=rec->>'shortcode' and creator_id=cid; end if;
   insert into public.reel_metric_snapshots(reel_id,snapshot_date,views,likes,comments,views_state,likes_state,comments_state,followers_at_snapshot,follower_captured_at,fetched_at,provider)
   values(rid,(fetched at time zone 'UTC')::date,(rec->>'views')::bigint,(rec->>'likes')::bigint,(rec->>'comments')::bigint,rec->>'views_state',rec->>'likes_state',rec->>'comments_state',fs.followers_count,fs.captured_at,fetched,rec->>'provider')
   on conflict(reel_id,snapshot_date) do update set views=excluded.views,likes=excluded.likes,comments=excluded.comments,views_state=excluded.views_state,likes_state=excluded.likes_state,comments_state=excluded.comments_state,followers_at_snapshot=excluded.followers_at_snapshot,follower_captured_at=excluded.follower_captured_at,fetched_at=excluded.fetched_at,provider=excluded.provider
   where public.reel_metric_snapshots.fetched_at<=excluded.fetched_at;
  end if;
  update public.scrape_job_creators set status='active',result_count=result_count+1 where job_id=j.id and creator_id=cid;
  accepted:=accepted+1;
 end loop;
 for er in select value from jsonb_array_elements(p_errors) loop
  cid:=(er->>'creator_id')::uuid;
  if not exists(select 1 from public.scrape_job_creators where job_id=j.id and creator_id=cid) then raise exception 'creator_identity_mismatch' using errcode='42501'; end if;
  update public.scrape_job_creators set status=case when result_count>0 then 'active' else coalesce(er->>'status','failed') end,error_message=left(coalesce(er->>'message','Invalid provider result'),500) where job_id=j.id and creator_id=cid;
 end loop;
 for kv in select key,value from jsonb_each(counts) loop
  update public.scrape_job_creators set received_count=received_count+(kv.value::text)::integer where job_id=j.id and creator_id=kv.key::uuid;
 end loop;
 update public.scrape_jobs set dataset_cursor=p_next_cursor,dataset_finished=p_finished,returned_records_count=returned_records_count+accepted,lease_expires_at=now()+interval '3 minutes' where id=j.id;
 return jsonb_build_object('cursor',p_next_cursor,'accepted',accepted,'duplicate',false);
end; $$;
revoke execute on function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) to service_role;

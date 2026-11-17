-- Preserve source captions separately from provider titles. No provider work or activation.
alter table public.reels add column caption_full text,
  add column caption_observed_at timestamptz,
  add constraint reels_full_caption_bound check (caption_full is null or char_length(caption_full)<=20000),
  add constraint reels_full_caption_observation check ((caption_full is null)=(caption_observed_at is null));

-- The existing implementation remains the authority for leases, counts, ownership,
-- snapshots and frozen media targets. Caption validation is in the same transaction.
alter function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb)
  rename to worker_ingest_page_pre_caption;
revoke all on function public.worker_ingest_page_pre_caption(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb)
  from public,anon,authenticated,service_role;
create function public.worker_ingest_page(p_job_id uuid,p_lease_token uuid,p_expected_cursor integer,p_records jsonb,
  p_errors jsonb,p_next_cursor integer,p_finished boolean,p_received_counts jsonb default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb; rec jsonb; j public.scrape_jobs; caption_refresh_id uuid; rid uuid; fetched timestamptz;
begin
  perform public.require_service();
  result:=public.worker_ingest_page_pre_caption(p_job_id,p_lease_token,p_expected_cursor,p_records,p_errors,p_next_cursor,p_finished,p_received_counts);
  if (result->>'duplicate')::boolean then return result; end if;
  select * into j from public.scrape_jobs where id=p_job_id;
  if j.kind='profile' then return result; end if;
  select id into caption_refresh_id from public.transcription_media_refreshes where job_id=p_job_id;
  for rec in select value from jsonb_array_elements(p_records) loop
    select r.id into rid from public.reels r join public.creators c on c.id=r.creator_id
    where r.creator_id=(rec->>'creator_id')::uuid and r.shortcode=rec->>'shortcode' and c.username=rec->>'username'
      and exists(select 1 from public.scrape_job_creators jc where jc.job_id=j.id and jc.creator_id=r.creator_id)
      and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
        where wc.creator_id=r.creator_id and wc.active and w.archived_at is null and w.owner_user_id=j.owner_user_id)
      and (caption_refresh_id is null or exists(select 1 from public.transcription_media_targets mt
        where mt.refresh_id=caption_refresh_id and mt.reel_id=r.id and mt.creator_id=r.creator_id and mt.shortcode=r.shortcode));
    if rid is null or not rec ? 'caption_full' or rec->'caption_full'='null'::jsonb then continue; end if;
    if jsonb_typeof(rec->'caption_full')<>'string' or char_length(rec->>'caption_full')>20000 then
      raise exception 'invalid_full_caption' using errcode='22023';
    end if;
    fetched:=(rec->>'fetched_at')::timestamptz;
    if fetched is null or fetched>now()+interval '5 minutes' then raise exception 'invalid_fetch_timestamp' using errcode='22023'; end if;
    update public.reels set caption_full=rec->>'caption_full',caption_observed_at=fetched
      where id=rid and (caption_observed_at is null or caption_observed_at<=fetched);
  end loop;
  return result;
end $$;
revoke all on function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb) to service_role;

alter function reel_detail_private.read_detail(uuid,uuid) rename to read_detail_pre_caption;
revoke all on function reel_detail_private.read_detail_pre_caption(uuid,uuid) from public,anon,authenticated,service_role;
create function reel_detail_private.read_detail(p_workspace_id uuid,p_reel_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare detail jsonb; caption text;
begin
  -- The prior helper verifies the owner and active workspace before any caption lookup.
  detail:=reel_detail_private.read_detail_pre_caption(p_workspace_id,p_reel_id);
  select caption_full into caption from public.reels where id=p_reel_id;
  return detail||jsonb_build_object('caption_full',caption);
end $$;
revoke all on function reel_detail_private.read_detail(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function reel_detail_private.read_detail(uuid,uuid) to authenticated;

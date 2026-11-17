-- Durable queue and worker-only transactional state transitions.
create function public.queue_creator_jobs(p_owner_user_id uuid,p_creator_ids uuid[],p_kind text) returns uuid[] language plpgsql security definer set search_path = pg_catalog, public as $$
declare ids uuid[]; batch uuid[]; job uuid; jobs uuid[]:='{}'; lim integer; i integer; cid uuid; day_ist date:=(now() at time zone 'Asia/Kolkata')::date;
begin
 if p_kind not in ('daily','weekly','backfill','profile','manual','retry') then raise exception 'invalid_job_kind' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('queue:'||p_owner_user_id::text,0));
 select case when p_kind in ('backfill','weekly') then weekly_limit when p_kind='profile' then 1 else daily_limit end into lim from public.app_settings where owner_user_id=p_owner_user_id;
 if lim is null then raise exception 'owner_not_provisioned' using errcode='42501'; end if;
 select array_agg(c.id order by case when p_kind='profile' then c.last_profile_fetch_at else c.last_reels_fetch_at end nulls first,c.username) into ids
 from public.creators c where c.id=any(p_creator_ids)
 and exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.creator_id=c.id and wc.active and w.archived_at is null and w.owner_user_id=p_owner_user_id)
 and (p_kind in ('manual','backfill') or c.status not in ('private','unavailable','paused'))
 and not exists(select 1 from public.scrape_job_creators jc join public.scrape_jobs j on j.id=jc.job_id
 where jc.creator_id=c.id and j.owner_user_id=p_owner_user_id and (j.status in ('pending','dispatching','running','processing','uncertain','budget_paused')
 or p_kind in ('daily','weekly','profile') and j.kind=p_kind and (j.scheduled_for at time zone 'Asia/Kolkata')::date=day_ist));
 if p_kind='retry' then
  select array_agg(cid2) into ids from unnest(ids) cid2 where
   not exists(select 1 from public.creator_retry_days d where d.owner_user_id=p_owner_user_id and d.creator_id=cid2 and d.retry_date=day_ist)
   and exists(select 1 from public.scrape_job_creators jc join public.scrape_jobs j on j.id=jc.job_id where jc.creator_id=cid2 and j.owner_user_id=p_owner_user_id and j.kind='daily' and jc.status='failed' and (j.scheduled_for at time zone 'Asia/Kolkata')::date=day_ist);
 end if;
 if ids is null then return jobs; end if;
 for i in 1..cardinality(ids) by 20 loop
  batch:=ids[i:least(i+19,cardinality(ids))];
  insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,estimated_cost_usd)
  values(p_owner_user_id,p_kind,cardinality(batch),lim,case when p_kind='profile' then cardinality(batch)*0.00115 else cardinality(batch)*lim*0.00005 end) returning id into job;
  insert into public.scrape_job_creators(job_id,creator_id) select job,unnest(batch);
  if p_kind='retry' then insert into public.creator_retry_days(owner_user_id,creator_id,retry_date,job_id) select p_owner_user_id,unnest(batch),day_ist,job; end if;
  jobs:=array_append(jobs,job);
 end loop;
 return jobs;
end; $$;
create function public.enqueue_refresh(p_workspace_id uuid,p_creator_ids uuid[] default null,p_kind text default 'manual') returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare ids uuid[];
begin
 perform public.require_workspace(p_workspace_id);
 if p_kind not in ('manual','backfill','profile') then raise exception 'invalid_manual_kind' using errcode='22023'; end if;
 if p_creator_ids is not null and (cardinality(p_creator_ids)>120 or array_position(p_creator_ids,null) is not null or exists(select 1 from unnest(p_creator_ids) x where not exists(select 1 from public.workspace_creators wc where wc.workspace_id=p_workspace_id and wc.creator_id=x and wc.active))) then raise exception 'creator_not_in_workspace' using errcode='42501'; end if;
 if exists(select 1 from public.workspaces where id=p_workspace_id and archived_at is not null) then raise exception 'workspace_archived' using errcode='22023'; end if;
 select array_agg(creator_id) into ids from public.workspace_creators where workspace_id=p_workspace_id and active and (p_creator_ids is null or creator_id=any(p_creator_ids));
 return jsonb_build_object('job_ids',public.queue_creator_jobs(auth.uid(),coalesce(ids,'{}'),p_kind));
end; $$;
create function public.worker_schedule(p_owner_user_id uuid,p_kind text) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare ids uuid[];
begin
 perform public.require_service();
 if p_kind not in ('daily','weekly','profile','retry') then raise exception 'invalid_schedule_kind' using errcode='22023'; end if;
 if not exists(select 1 from public.app_settings where owner_user_id=p_owner_user_id and not paused) then return jsonb_build_object('job_ids','[]'::jsonb,'reason','paused'); end if;
 select array_agg(distinct wc.creator_id) into ids from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.active and w.archived_at is null and w.owner_user_id=p_owner_user_id;
 return jsonb_build_object('job_ids',public.queue_creator_jobs(p_owner_user_id,coalesce(ids,'{}'),p_kind));
end; $$;
create function public.worker_record_balance(p_owner_user_id uuid,p_provider_user_id text,p_balance_usd numeric,p_month_spend_usd numeric,p_billing_month date) returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
 perform public.require_service();
 perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
 if p_balance_usd<0 or p_month_spend_usd<0 or p_balance_usd is null or p_month_spend_usd is null or p_billing_month<>date_trunc('month',now() at time zone 'UTC')::date then raise exception 'invalid_balance' using errcode='22023'; end if;
 update public.app_settings set provider_balance_usd=p_balance_usd,provider_balance_checked_at=now(),provider_month_spend_usd=p_month_spend_usd,provider_billing_month=p_billing_month
 where owner_user_id=p_owner_user_id and provider_account_id=p_provider_user_id;
 if not found then raise exception 'provider_account_mismatch' using errcode='42501'; end if;
end; $$;
create function public.worker_claim_dispatch(p_owner_user_id uuid,p_live boolean,p_actor_id text,p_kind text) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare s public.app_settings; j public.scrape_jobs; month_start date:=date_trunc('month',now() at time zone 'UTC')::date; committed numeric; reserved numeric; cap numeric;
begin
 perform public.require_service();
 if p_live is null or nullif(p_actor_id,'') is null then raise exception 'invalid_claim' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('budget:'||p_owner_user_id::text,0));
 select * into s from public.app_settings where owner_user_id=p_owner_user_id for update;
 if not found or s.paused then return jsonb_build_object('reason','paused'); end if;
 if p_live and (not s.scraping_enabled or s.provider_account_id is null or s.provider_balance_checked_at is null or s.provider_balance_checked_at<now()-interval '15 minutes' or s.provider_balance_usd is null or s.provider_month_spend_usd is null or s.provider_billing_month<>month_start) then return jsonb_build_object('reason','live_setup_or_balance_unverified'); end if;
 -- An uncertain start might have been accepted by Apify. Never recycle or release its reservation automatically.
 if exists(select 1 from public.scrape_jobs where owner_user_id=p_owner_user_id and live and (status='uncertain' or status in ('succeeded','partial','failed') and actual_cost_usd is null or provider_terminal_status is not null and actual_cost_usd is null)) then return jsonb_build_object('reason','unreconciled_charges'); end if;
 if (select count(*) from public.scrape_jobs where owner_user_id=p_owner_user_id and status in ('dispatching','running','processing','uncertain'))>=2 then return jsonb_build_object('reason','concurrency_limit'); end if;
 select * into j from public.scrape_jobs where owner_user_id=p_owner_user_id and status in ('pending','budget_paused') and kind=p_kind and scheduled_for<=now()
 order by scheduled_for,created_at,id for update skip locked limit 1;
 if not found then return jsonb_build_object('reason','no_pending_jobs'); end if;
 -- Remove detached/private/paused accounts just before dispatch; no browser-supplied provider identities.
 delete from public.scrape_job_creators jc where jc.job_id=j.id and not exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id join public.creators c on c.id=wc.creator_id where wc.creator_id=jc.creator_id and wc.active and w.archived_at is null and w.owner_user_id=p_owner_user_id and c.status not in ('private','unavailable','paused'));
 if not exists(select 1 from public.scrape_job_creators where job_id=j.id) then
  update public.scrape_jobs set status='failed',completed_at=now(),actual_cost_usd=0,billing_reconciled_at=now(),error_message='No eligible associated public creators' where id=j.id;
  return jsonb_build_object('reason','empty_job');
 end if;
 select greatest(coalesce(sum(actual_cost_usd) filter(where billing_month=month_start),0),case when p_live then s.provider_month_spend_usd else 0 end),coalesce(sum(reserved_usd),0) into committed,reserved from public.scrape_jobs where owner_user_id=p_owner_user_id;
 cap:=case when p_live then s.max_run_charge_usd else 0 end;
 if p_live and (committed+reserved+cap>s.monthly_budget_usd or reserved+cap>s.provider_balance_usd) then
  update public.scrape_jobs set status='budget_paused',error_message='Monthly budget or authoritative provider balance insufficient' where id=j.id;
  return jsonb_build_object('reason','budget_paused');
 end if;
 update public.scrape_jobs set status='dispatching',live=p_live,reserved_usd=cap,billing_month=month_start,dispatch_nonce=gen_random_uuid(),
 expected_actor_id=p_actor_id,expected_provider_user_id=case when p_live then s.provider_account_id else 'mock' end,
 lease_token=gen_random_uuid(),lease_expires_at=now()+interval '3 minutes',started_at=now(),attempt_count=attempt_count+1,
 requested_profiles_count=(select count(*) from public.scrape_job_creators where job_id=j.id),error_message=null where id=j.id returning * into j;
 return jsonb_build_object('job',to_jsonb(j),'creators',(select jsonb_agg(jsonb_build_object('id',c.id,'username',c.username) order by c.username) from public.scrape_job_creators jc join public.creators c on c.id=jc.creator_id where jc.job_id=j.id),'max_total_charge_usd',cap);
end; $$;
create function public.worker_attach_run(p_job_id uuid,p_dispatch_nonce uuid,p_run_id text,p_actor_id text,p_provider_user_id text,p_dataset_id text) returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.scrape_jobs;
begin
 perform public.require_service(); select * into j from public.scrape_jobs where id=p_job_id for update;
 if j.dispatch_nonce is distinct from p_dispatch_nonce or j.expected_actor_id is distinct from p_actor_id or j.expected_provider_user_id is distinct from p_provider_user_id or nullif(p_run_id,'') is null then raise exception 'run_identity_mismatch' using errcode='42501'; end if;
 if j.actor_run_id=p_run_id then return; end if;
 if j.status not in ('dispatching','uncertain') or j.actor_run_id is not null then raise exception 'invalid_transition' using errcode='22023'; end if;
 update public.scrape_jobs set actor_run_id=p_run_id,dataset_id=p_dataset_id,status='running',lease_token=null,lease_expires_at=null where id=p_job_id;
end; $$;
create function public.worker_start_uncertain(p_job_id uuid,p_dispatch_nonce uuid) returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
 perform public.require_service(); update public.scrape_jobs set status='uncertain',error_message='Start acceptance unknown; operator must locate/verify run. No automatic relaunch.',lease_token=null,lease_expires_at=null
 where id=p_job_id and dispatch_nonce=p_dispatch_nonce and status='dispatching';
end; $$;
create function public.worker_reconcile_run(p_job_id uuid,p_run_id text,p_actor_id text,p_provider_user_id text,p_status text,p_dataset_id text,p_usage_total_usd numeric) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.scrape_jobs;
begin
 perform public.require_service(); select * into j from public.scrape_jobs where id=p_job_id;
 if not found then raise exception 'unknown_job' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('budget:'||j.owner_user_id::text,0));
 select * into j from public.scrape_jobs where id=p_job_id for update;
 if j.actor_run_id is distinct from p_run_id or j.expected_actor_id is distinct from p_actor_id or j.expected_provider_user_id is distinct from p_provider_user_id then raise exception 'run_identity_mismatch' using errcode='42501'; end if;
 if p_status not in ('READY','RUNNING','SUCCEEDED','FAILED','ABORTED','TIMED-OUT') or p_usage_total_usd<0 then raise exception 'invalid_run_metadata' using errcode='22023'; end if;
 if p_status in ('SUCCEEDED','FAILED','ABORTED','TIMED-OUT') then
  update public.scrape_jobs set provider_terminal_status=p_status,dataset_id=coalesce(p_dataset_id,dataset_id),
   actual_cost_usd=coalesce(p_usage_total_usd,actual_cost_usd),result_fetched_at=coalesce(result_fetched_at,now()),billing_reconciled_at=case when p_usage_total_usd is not null then now() else billing_reconciled_at end,
   reserved_usd=case when p_usage_total_usd is not null then 0 else reserved_usd end,
   status=case when status in ('succeeded','partial','failed','processing') then status else 'processing' end where id=j.id returning * into j;
 end if;
 return to_jsonb(j);
end; $$;
create function public.worker_claim_processing(p_job_id uuid) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.scrape_jobs;
begin
 perform public.require_service();
 select * into j from public.scrape_jobs where id=p_job_id for update;
 if not found or j.status<>'processing' or j.provider_terminal_status is null or j.processing_attempts>=10 or (j.lease_expires_at>now() and j.lease_token is not null) then return jsonb_build_object('reason','not_claimable'); end if;
 update public.scrape_jobs set lease_token=gen_random_uuid(),lease_expires_at=now()+interval '3 minutes' where id=p_job_id returning * into j;
 return jsonb_build_object('job',to_jsonb(j),'creators',(select jsonb_agg(jsonb_build_object('id',c.id,'username',c.username) order by c.username) from public.scrape_job_creators jc join public.creators c on c.id=jc.creator_id where jc.job_id=j.id));
end; $$;
create function public.worker_ingest_page(p_job_id uuid,p_lease_token uuid,p_expected_cursor integer,p_records jsonb,p_errors jsonb,p_next_cursor integer,p_finished boolean) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.scrape_jobs; rec jsonb; er jsonb; cid uuid; rid uuid; old_creator uuid; fetched timestamptz; fs public.creator_follower_snapshots; accepted integer:=0;
begin
 perform public.require_service(); select * into j from public.scrape_jobs where id=p_job_id for update;
 if not found or j.status<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() then raise exception 'lease_expired' using errcode='40001'; end if;
 if j.dataset_cursor<>p_expected_cursor then return jsonb_build_object('cursor',j.dataset_cursor,'duplicate',true); end if;
 if jsonb_typeof(p_records)<>'array' or jsonb_typeof(p_errors)<>'array' or jsonb_array_length(p_records)>100 or jsonb_array_length(p_errors)>100 or p_next_cursor<p_expected_cursor or p_next_cursor>p_expected_cursor+100 or p_finished is null or p_next_cursor=p_expected_cursor and not p_finished then raise exception 'invalid_page' using errcode='22023'; end if;
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
   select creator_id into old_creator from public.reels where shortcode=rec->>'shortcode';
   if old_creator is not null and old_creator<>cid then raise exception 'shortcode_creator_mismatch' using errcode='42501'; end if;
   select * into fs from public.creator_follower_snapshots where creator_id=cid and captured_at<=fetched and followers_count>0 order by captured_at desc limit 1;
   insert into public.reels(creator_id,instagram_media_id,shortcode,reel_url,thumbnail_url,caption_preview,published_at,duration_seconds,latest_views,latest_likes,latest_comments,views_state,likes_state,comments_state,latest_fetched_at,provider)
   values(cid,rec->>'instagram_media_id',rec->>'shortcode',rec->>'reel_url',rec->>'thumbnail_url',coalesce(rec->>'caption_preview',''),(rec->>'published_at')::timestamptz,(rec->>'duration_seconds')::numeric,(rec->>'views')::bigint,(rec->>'likes')::bigint,(rec->>'comments')::bigint,rec->>'views_state',rec->>'likes_state',rec->>'comments_state',fetched,rec->>'provider')
   on conflict(shortcode) do update set reel_url=excluded.reel_url,thumbnail_url=excluded.thumbnail_url,caption_preview=excluded.caption_preview,duration_seconds=excluded.duration_seconds,
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
 update public.scrape_jobs set dataset_cursor=p_next_cursor,dataset_finished=p_finished,returned_records_count=returned_records_count+accepted,lease_expires_at=now()+interval '3 minutes' where id=j.id;
 return jsonb_build_object('cursor',p_next_cursor,'accepted',accepted,'duplicate',false);
end; $$;
create function public.worker_finish_processing(p_job_id uuid,p_lease_token uuid) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare j public.scrape_jobs; ok integer; errors integer;
begin
 perform public.require_service(); select * into j from public.scrape_jobs where id=p_job_id for update;
 if j.status in ('succeeded','partial','failed') then return to_jsonb(j); end if;
 if j.status<>'processing' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<now() or not j.dataset_finished then raise exception 'not_finished_or_lease_expired' using errcode='40001'; end if;
 update public.scrape_job_creators set status='failed',error_message=coalesce(error_message,'No valid records returned; profile privacy cannot be inferred') where job_id=j.id and result_count=0 and status in ('pending','active');
 select count(*) filter(where result_count>0),count(*) filter(where status<>'active' or error_message is not null) into ok,errors from public.scrape_job_creators where job_id=j.id;
 update public.creators c set status=case when jc.result_count>0 then 'active' else jc.status end,last_error=jc.error_message,
 last_reels_fetch_at=case when j.kind<>'profile' and jc.result_count>0 then greatest(c.last_reels_fetch_at,j.result_fetched_at) else c.last_reels_fetch_at end
 from public.scrape_job_creators jc where jc.job_id=j.id and jc.creator_id=c.id;
 update public.scrape_jobs set status=case when ok=0 then 'failed' when errors>0 or provider_terminal_status<>'SUCCEEDED' then 'partial' else 'succeeded' end,completed_at=now(),lease_token=null,lease_expires_at=null,
 error_message=case when ok=0 then 'No valid profile results' when errors>0 then 'Some profiles or records failed' when provider_terminal_status<>'SUCCEEDED' then 'Provider run ended unsuccessfully; partial records preserved' else null end
 where id=j.id returning * into j;
 return to_jsonb(j);
end; $$;
create function public.worker_release_processing(p_job_id uuid,p_lease_token uuid,p_error text default null) returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
 perform public.require_service(); update public.scrape_jobs set lease_token=null,lease_expires_at=null,error_message=case when p_error is null then error_message else left(p_error,500) end,
 processing_attempts=processing_attempts+case when p_error is null then 0 else 1 end,
 status=case when p_error is not null and processing_attempts>=9 then 'failed' else status end,
 completed_at=case when p_error is not null and processing_attempts>=9 then now() else completed_at end
 where id=p_job_id and status='processing' and lease_token=p_lease_token;
end; $$;
create function public.worker_expire_dispatches(p_owner_user_id uuid) returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare n integer;
begin
 perform public.require_service();
 update public.scrape_jobs set status='uncertain',lease_token=null,lease_expires_at=null,error_message='Dispatch lease expired; start acceptance unknown. Manual reconciliation required.' where owner_user_id=p_owner_user_id and status='dispatching' and lease_expires_at<now();
 get diagnostics n=row_count; return n;
end; $$;

-- Internal queue cannot be invoked by browser users (it accepts an owner argument).
revoke execute on function public.queue_creator_jobs(uuid,uuid[],text),public.worker_schedule(uuid,text),public.worker_record_balance(uuid,text,numeric,numeric,date),
 public.worker_claim_dispatch(uuid,boolean,text,text),public.worker_attach_run(uuid,uuid,text,text,text,text),public.worker_start_uncertain(uuid,uuid),
 public.worker_reconcile_run(uuid,text,text,text,text,text,numeric),public.worker_claim_processing(uuid),public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean),
 public.worker_finish_processing(uuid,uuid),public.worker_release_processing(uuid,uuid,text),public.worker_expire_dispatches(uuid) from public,anon,authenticated,service_role;
revoke execute on function public.enqueue_refresh(uuid,uuid[],text) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_refresh(uuid,uuid[],text) to authenticated;
grant execute on function public.queue_creator_jobs(uuid,uuid[],text),public.worker_schedule(uuid,text),public.worker_record_balance(uuid,text,numeric,numeric,date),
 public.worker_claim_dispatch(uuid,boolean,text,text),public.worker_attach_run(uuid,uuid,text,text,text,text),public.worker_start_uncertain(uuid,uuid),
 public.worker_reconcile_run(uuid,text,text,text,text,text,numeric),public.worker_claim_processing(uuid),public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean),
 public.worker_finish_processing(uuid,uuid),public.worker_release_processing(uuid,uuid,text),public.worker_expire_dispatches(uuid) to service_role;

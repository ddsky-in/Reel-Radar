-- Adding a creator authorizes one initial metadata fetch as well as its Reels
-- import. Profile jobs use the existing account, envelope and transactional caps.
create schema creator_profile_private;
revoke all on schema creator_profile_private from public,anon,authenticated,service_role;
grant usage on schema creator_profile_private to authenticated;

create function creator_profile_private.queue_missing_profiles(p_creator_ids uuid[],p_initial_only boolean)
returns uuid[] language plpgsql security definer set search_path=pg_catalog,public as $$
declare ids uuid[]; owner_id uuid:=auth.uid();
begin
  if owner_id is null or not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  if p_creator_ids is null or cardinality(p_creator_ids)=0 then return '{}'::uuid[]; end if;
  if cardinality(p_creator_ids)>1000 or array_position(p_creator_ids,null) is not null then
    raise exception 'invalid_creator_ids' using errcode='22023';
  end if;
  -- Match the import/dispatch lock order, and serialize the initial-fetch check.
  perform pg_advisory_xact_lock(hashtextextended('queue:'||owner_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('budget:'||owner_id::text,0));
  if exists(select 1 from unnest(p_creator_ids) x where not exists(
    select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id
    where wc.creator_id=x and wc.active and w.archived_at is null and w.owner_user_id=owner_id)) then
    raise exception 'creator_not_authorized' using errcode='42501';
  end if;
  select array_agg(c.id order by c.username) into ids from public.creators c
    where c.id=any(p_creator_ids)
      and (nullif(trim(c.avatar_url),'') is null or c.followers_count is null or nullif(trim(c.display_name),'') is null)
      and (not p_initial_only or not exists(select 1 from public.scrape_jobs j
        join public.scrape_job_creators jc on jc.job_id=j.id
        where jc.creator_id=c.id and j.owner_user_id=owner_id and j.kind='profile'));
  -- queue_creator_jobs deduplicates active/uncertain and same-day profile jobs,
  -- batches up to 20 profiles, and records auth.uid() as manual_authorized_by.
  return public.queue_creator_jobs(owner_id,coalesce(ids,'{}'),'profile');
end $$;
revoke all on function creator_profile_private.queue_missing_profiles(uuid[],boolean) from public,anon,authenticated,service_role;

create function creator_profile_private.add_creator(p_workspace_id uuid,p_username text,p_queue_profile boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.creators; n integer; cap integer; inserted boolean; un text; jobs uuid[]; init_job uuid; init_status text; profile_jobs uuid[]:='{}';
begin
  perform public.require_workspace(p_workspace_id);
  if auth.uid() is null or not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('capacity:'||auth.uid()::text,0));
  if exists(select 1 from public.workspaces where id=p_workspace_id and archived_at is not null) then raise exception 'workspace_archived' using errcode='22023'; end if;
  un:=public.normalize_username(p_username);
  insert into public.creators(username) values(un) on conflict(username) do nothing returning * into c;
  inserted:=found;
  if not inserted then select * into c from public.creators where username=un; end if;
  if not exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.creator_id=c.id and wc.active and w.owner_user_id=auth.uid() and w.archived_at is null) then
    select count(distinct wc.creator_id) into n from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.active and w.archived_at is null and w.owner_user_id=auth.uid();
    select capacity into cap from public.app_settings where owner_user_id=auth.uid();
    if n>=cap then raise exception 'capacity_exceeded' using errcode='P0001'; end if;
  end if;
  insert into public.workspace_creators(workspace_id,creator_id) values(p_workspace_id,c.id) on conflict(workspace_id,creator_id) do update set active=true;
  if inserted then jobs:=public.queue_creator_jobs(auth.uid(),array[c.id],'backfill'); end if;
  if p_queue_profile then profile_jobs:=creator_profile_private.queue_missing_profiles(array[c.id],true); end if;
  select ci.job_id,j.status into init_job,init_status from public.creator_initializations ci join public.scrape_jobs j on j.id=ci.job_id where ci.creator_id=c.id;
  return (to_jsonb(c)-'instagram_user_id'-'created_at')||jsonb_build_object(
    'initial_backfill_job_id',case when inserted then init_job else null end,'initial_backfill_status',init_status,'profile_job_ids',to_jsonb(profile_jobs));
end $$;
revoke all on function creator_profile_private.add_creator(uuid,text,boolean) from public,anon,authenticated,service_role;
grant execute on function creator_profile_private.add_creator(uuid,text,boolean) to authenticated;

create or replace function public.add_creator(p_workspace_id uuid,p_username text) returns jsonb
language sql security invoker set search_path=pg_catalog,public as $$
  select creator_profile_private.add_creator(p_workspace_id,p_username,true);
$$;
revoke all on function public.add_creator(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.add_creator(uuid,text) to authenticated;

create or replace function public.import_creators(p_workspace_id uuid,p_rows jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare row_data jsonb; wid uuid; un text; wn text; added integer:=0; duplicates integer:=0; created integer:=0;
  cjson jsonb; seen text[]:='{}'; key text; job_ids uuid[]:='{}'; jid uuid; profile_ids uuid[]:='{}'; profile_jobs uuid[]:='{}';
begin
  perform public.require_workspace(p_workspace_id);
  if auth.uid() is null or not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  if exists(select 1 from public.workspaces where id=p_workspace_id and archived_at is not null) then raise exception 'workspace_archived' using errcode='22023'; end if;
  if p_rows is null or jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>1000 then raise exception 'invalid_import' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('capacity:'||auth.uid()::text,0));
  for row_data in select value from jsonb_array_elements(p_rows) loop
    un:=public.normalize_username(row_data->>'username'); wn:=trim(coalesce(row_data->>'workspace','')); wid:=p_workspace_id;
    if wn<>'' then
      select id into wid from public.workspaces where owner_user_id=auth.uid() and lower(name)=lower(wn) and archived_at is null order by created_at limit 1;
      if wid is null then cjson:=public.create_workspace(wn,null); wid:=(cjson->>'id')::uuid; created:=created+1; end if;
    end if;
    key:=wid::text||':'||un;
    if key=any(seen) or exists(select 1 from public.workspace_creators wc join public.creators c on c.id=wc.creator_id where wc.workspace_id=wid and wc.active and c.username=un) then duplicates:=duplicates+1;
    else
      -- Defer metadata until every link is committed to this transaction so a
      -- bulk import creates batches, not one separate Actor run per creator.
      cjson:=creator_profile_private.add_creator(wid,un,false); added:=added+1;
      profile_ids:=array_append(profile_ids,(cjson->>'id')::uuid);
      jid:=(cjson->>'initial_backfill_job_id')::uuid;
      if jid is not null and not jid=any(job_ids) then job_ids:=array_append(job_ids,jid); end if;
    end if;
    seen:=array_append(seen,key);
  end loop;
  profile_jobs:=creator_profile_private.queue_missing_profiles(profile_ids,true);
  return jsonb_build_object('added',added,'duplicates',duplicates,'workspaces_created',created,
    'job_ids',to_jsonb(job_ids||profile_jobs),'profile_job_ids',to_jsonb(profile_jobs));
end $$;
revoke all on function public.import_creators(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.import_creators(uuid,jsonb) to authenticated;

-- An explicit creator/workspace refresh also repairs missing profile metadata.
-- Scheduled Reels refreshes and read requests do not launch profile collection.
create or replace function public.enqueue_refresh(p_workspace_id uuid,p_creator_ids uuid[] default null,p_kind text default 'manual') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare ids uuid[]; jobs uuid[]; profiles uuid[]:='{}';
begin
  perform public.require_workspace(p_workspace_id);
  if auth.uid() is null or not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  if p_kind is null or p_kind not in ('manual','backfill','profile') then raise exception 'invalid_manual_kind' using errcode='22023'; end if;
  if p_creator_ids is not null and (cardinality(p_creator_ids)>120 or array_position(p_creator_ids,null) is not null or exists(select 1 from unnest(p_creator_ids) x where not exists(select 1 from public.workspace_creators wc where wc.workspace_id=p_workspace_id and wc.creator_id=x and wc.active))) then raise exception 'creator_not_in_workspace' using errcode='42501'; end if;
  if exists(select 1 from public.workspaces where id=p_workspace_id and archived_at is not null) then raise exception 'workspace_archived' using errcode='22023'; end if;
  select array_agg(creator_id) into ids from public.workspace_creators where workspace_id=p_workspace_id and active and (p_creator_ids is null or creator_id=any(p_creator_ids));
  jobs:=public.queue_creator_jobs(auth.uid(),coalesce(ids,'{}'),p_kind);
  if p_kind='manual' then profiles:=creator_profile_private.queue_missing_profiles(coalesce(ids,'{}'),false); end if;
  return jsonb_build_object('job_ids',jobs||profiles,'profile_job_ids',profiles);
end $$;
revoke all on function public.enqueue_refresh(uuid,uuid[],text) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_refresh(uuid,uuid[],text) to authenticated;

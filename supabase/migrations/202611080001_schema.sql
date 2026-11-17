-- ReelRadar: owner-only MVP. No schedules or external requests are installed here.
-- gen_random_uuid() is built into PostgreSQL 15; no pgcrypto extension dependency.

create table public.app_settings (
  owner_user_id uuid primary key references auth.users(id) on delete restrict,
  singleton boolean not null default true unique check (singleton),
  daily_limit integer not null default 10 check (daily_limit between 1 and 30),
  weekly_limit integer not null default 30 check (weekly_limit between 1 and 30),
  monthly_budget_usd numeric(12,6) not null default 4 check (monthly_budget_usd between 0 and 10000),
  budget_warning_pct integer not null default 80 check (budget_warning_pct between 1 and 100),
  paused boolean not null default true,
  timezone text not null default 'Asia/Kolkata' check (timezone = 'Asia/Kolkata'),
  capacity integer not null default 120 check (capacity between 1 and 1000),
  scraping_enabled boolean not null default false,
  max_run_charge_usd numeric(12,6) not null default 0.25 check (max_run_charge_usd > 0),
  provider_balance_usd numeric(12,6) check (provider_balance_usd >= 0),
  provider_balance_checked_at timestamptz,
  provider_account_id text,
  provider_month_spend_usd numeric(12,6) check (provider_month_spend_usd >= 0),
  provider_billing_month date,
  snapshot_retention_days integer not null default 90 check (snapshot_retention_days between 30 and 365),
  created_at timestamptz not null default now()
);
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.app_settings(owner_user_id),
  name text not null check (char_length(name) between 1 and 100),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 120),
  created_at timestamptz not null default now(), archived_at timestamptz,
  unique(owner_user_id,slug)
);
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null default 'owner' check (role in ('owner','member')),
  primary key(workspace_id,user_id)
);
create table public.creators (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username = lower(username) and username ~ '^[a-z0-9_][a-z0-9_.]{0,29}$' and username !~ '\.\.' and right(username,1) <> '.'),
  instagram_user_id text unique, display_name text, avatar_url text,
  followers_count bigint check (followers_count >= 0), last_profile_fetch_at timestamptz,
  status text not null default 'pending' check (status in ('active','pending','unavailable','private','failed','paused')),
  last_reels_fetch_at timestamptz, last_error text, created_at timestamptz not null default now()
);
create table public.workspace_creators (
  workspace_id uuid not null references public.workspaces on delete cascade,
  creator_id uuid not null references public.creators on delete restrict,
  added_at timestamptz not null default now(), active boolean not null default true,
  primary key(workspace_id,creator_id)
);
create index workspace_creators_creator_idx on public.workspace_creators(creator_id,workspace_id);
create table public.creator_follower_snapshots (
  creator_id uuid not null references public.creators on delete cascade,
  captured_date date not null, followers_count bigint check (followers_count >= 0),
  source text not null, captured_at timestamptz not null,
  primary key(creator_id,captured_date),
  check(captured_date = (captured_at at time zone 'UTC')::date)
);
create table public.reels (
  id uuid primary key default gen_random_uuid(), creator_id uuid not null references public.creators on delete restrict,
  instagram_media_id text unique, shortcode text not null unique check (shortcode ~ '^[A-Za-z0-9_-]{1,64}$'),
  reel_url text, thumbnail_url text, caption_preview text not null default '' check(char_length(caption_preview) <= 500),
  published_at timestamptz not null, duration_seconds numeric check(duration_seconds >= 0),
  latest_views bigint check(latest_views >= 0), latest_likes bigint check(latest_likes >= 0), latest_comments bigint check(latest_comments >= 0),
  views_state text not null default 'not_fetched' check(views_state in ('known','hidden','not_fetched','unavailable')),
  likes_state text not null default 'not_fetched' check(likes_state in ('known','hidden','not_fetched','unavailable')),
  comments_state text not null default 'not_fetched' check(comments_state in ('known','hidden','not_fetched','unavailable')),
  latest_fetched_at timestamptz not null, first_seen_at timestamptz not null default now(), provider text not null,
  check ((views_state = 'known') = (latest_views is not null)),
  check ((likes_state = 'known') = (latest_likes is not null)),
  check ((comments_state = 'known') = (latest_comments is not null))
);
create index reels_creator_published_idx on public.reels(creator_id,published_at desc,id);
create index reels_views_idx on public.reels(latest_views desc nulls last);
create index reels_fetched_idx on public.reels(latest_fetched_at);
create table public.reel_metric_snapshots (
  id uuid primary key default gen_random_uuid(), reel_id uuid not null references public.reels on delete cascade,
  snapshot_date date not null, views bigint check(views >= 0), likes bigint check(likes >= 0), comments bigint check(comments >= 0),
  views_state text not null check(views_state in ('known','hidden','not_fetched','unavailable')),
  likes_state text not null check(likes_state in ('known','hidden','not_fetched','unavailable')),
  comments_state text not null check(comments_state in ('known','hidden','not_fetched','unavailable')),
  followers_at_snapshot bigint check(followers_at_snapshot >= 0), follower_captured_at timestamptz,
  follower_basis text not null default 'latest_valid_snapshot', fetched_at timestamptz not null, provider text not null,
  unique(reel_id,snapshot_date), check(snapshot_date = (fetched_at at time zone 'UTC')::date),
  check ((views_state = 'known') = (views is not null)), check ((likes_state = 'known') = (likes is not null)),
  check ((comments_state = 'known') = (comments is not null))
);
create index reel_snapshots_date_idx on public.reel_metric_snapshots(reel_id,snapshot_date desc);
create table public.saved_reels (
  workspace_id uuid not null references public.workspaces on delete cascade,
  reel_id uuid not null references public.reels on delete cascade,
  saved_by_user_id uuid not null references auth.users on delete restrict,
  note text not null default '' check(char_length(note) <= 5000), created_at timestamptz not null default now(),
  primary key(workspace_id,reel_id)
);
create table public.reel_tags (
  workspace_id uuid not null, reel_id uuid not null, tag text not null check(char_length(tag) between 1 and 50),
  primary key(workspace_id,reel_id,tag),
  foreign key(workspace_id,reel_id) references public.saved_reels(workspace_id,reel_id) on delete cascade
);
create table public.scrape_jobs (
  id uuid primary key default gen_random_uuid(), owner_user_id uuid not null references public.app_settings(owner_user_id),
  kind text not null check(kind in ('daily','weekly','backfill','profile','manual','retry')),
  status text not null default 'pending' check(status in ('pending','dispatching','running','processing','succeeded','partial','failed','budget_paused','uncertain')),
  scheduled_for timestamptz not null default now(), started_at timestamptz, completed_at timestamptz,
  actor_run_id text unique, expected_actor_id text, expected_provider_user_id text, dataset_id text,
  requested_profiles_count integer not null check(requested_profiles_count between 1 and 20),
  results_limit integer not null check(results_limit between 1 and 30),
  returned_records_count integer not null default 0 check(returned_records_count >= 0),
  estimated_cost_usd numeric(12,6) not null default 0 check(estimated_cost_usd >= 0),
  actual_cost_usd numeric(12,6) check(actual_cost_usd >= 0),
  reserved_usd numeric(12,6) not null default 0 check(reserved_usd >= 0), billing_month date,
  billing_reconciled_at timestamptz, live boolean not null default false,
  error_message text, attempt_count integer not null default 0 check(attempt_count between 0 and 2),
  dispatch_nonce uuid, lease_token uuid, lease_expires_at timestamptz,
  dataset_cursor integer not null default 0 check(dataset_cursor >= 0),
  dataset_finished boolean not null default false, provider_terminal_status text,
  processing_attempts integer not null default 0 check(processing_attempts between 0 and 10),
  result_fetched_at timestamptz,
  created_at timestamptz not null default now()
);
create index jobs_owner_scheduled_idx on public.scrape_jobs(owner_user_id,scheduled_for desc);
create index jobs_status_idx on public.scrape_jobs(status,scheduled_for);
create table public.scrape_job_creators (
  job_id uuid not null references public.scrape_jobs on delete cascade,
  creator_id uuid not null references public.creators on delete restrict,
  status text not null default 'pending' check(status in ('pending','active','unavailable','private','failed')),
  result_count integer not null default 0 check(result_count >= 0), error_message text,
  primary key(job_id,creator_id)
);
create index job_creators_creator_idx on public.scrape_job_creators(creator_id,job_id);
create table public.creator_retry_days (
  owner_user_id uuid not null references public.app_settings(owner_user_id), creator_id uuid not null references public.creators,
  retry_date date not null, job_id uuid not null references public.scrape_jobs, primary key(owner_user_id,creator_id,retry_date)
);

-- These helpers intentionally hide the allowlist and membership graph. No user-id argument is accepted.
create function public.is_allowed_owner() returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
 select auth.uid() is not null and exists(select 1 from public.app_settings s where s.owner_user_id = auth.uid());
$$;
create function public.is_workspace_member(p_workspace_id uuid) returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
 select public.is_allowed_owner() and exists(select 1 from public.workspace_members m join public.workspaces w on w.id=m.workspace_id
 where m.workspace_id=p_workspace_id and m.user_id=auth.uid() and w.owner_user_id=auth.uid());
$$;
create function public.can_read_creator(p_creator_id uuid) returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
 select exists(select 1 from public.workspace_creators wc where wc.creator_id=p_creator_id and public.is_workspace_member(wc.workspace_id));
$$;
create function public.require_workspace(p_workspace_id uuid) returns void language plpgsql stable security definer set search_path = pg_catalog, public as $$
 begin if not public.is_workspace_member(p_workspace_id) then raise exception 'forbidden' using errcode='42501'; end if; end;
$$;
create function public.require_service() returns void language plpgsql stable set search_path = pg_catalog, public as $$
 begin if coalesce(auth.role(),'') <> 'service_role' then raise exception 'service_role_required' using errcode='42501'; end if; end;
$$;

alter table public.app_settings enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.creators enable row level security;
alter table public.workspace_creators enable row level security;
alter table public.creator_follower_snapshots enable row level security;
alter table public.reels enable row level security;
alter table public.reel_metric_snapshots enable row level security;
alter table public.saved_reels enable row level security;
alter table public.reel_tags enable row level security;
alter table public.scrape_jobs enable row level security;
alter table public.scrape_job_creators enable row level security;
alter table public.creator_retry_days enable row level security;
create policy owner_settings_read on public.app_settings for select to authenticated using(owner_user_id=auth.uid());
create policy workspace_read on public.workspaces for select to authenticated using(public.is_workspace_member(id));
create policy members_private_read on public.workspace_members for select to authenticated using(user_id=auth.uid() and public.is_workspace_member(workspace_id));
create policy creator_read on public.creators for select to authenticated using(public.can_read_creator(id));
create policy workspace_creator_read on public.workspace_creators for select to authenticated using(public.is_workspace_member(workspace_id));
create policy follower_read on public.creator_follower_snapshots for select to authenticated using(public.can_read_creator(creator_id));
create policy reel_read on public.reels for select to authenticated using(public.can_read_creator(creator_id));
create policy snapshot_read on public.reel_metric_snapshots for select to authenticated using(exists(select 1 from public.reels r where r.id=reel_id));
create policy saved_read on public.saved_reels for select to authenticated using(public.is_workspace_member(workspace_id));
create policy tag_read on public.reel_tags for select to authenticated using(public.is_workspace_member(workspace_id));
create policy jobs_read on public.scrape_jobs for select to authenticated using(owner_user_id=auth.uid() and public.is_allowed_owner());
create policy job_creators_read on public.scrape_job_creators for select to authenticated using(exists(select 1 from public.scrape_jobs j where j.id=job_id));
-- No INSERT/UPDATE/DELETE policies; private canonical writes are worker-only or constrained RPCs.
-- Supabase hosted defaults grant these roles directly; revoke every role before scoped grants.
-- Limit privilege changes to ReelRadar objects, never unrelated public-schema tables.
revoke all on public.app_settings,public.workspaces,public.workspace_members,public.creators,public.workspace_creators,
 public.creator_follower_snapshots,public.reels,public.reel_metric_snapshots,public.saved_reels,public.reel_tags,
 public.scrape_jobs,public.scrape_job_creators,public.creator_retry_days from public,anon,authenticated,service_role;
grant select on public.app_settings,public.workspaces,public.workspace_members,public.creators,public.workspace_creators,
 public.creator_follower_snapshots,public.reels,public.reel_metric_snapshots,public.saved_reels,public.reel_tags,
 public.scrape_jobs,public.scrape_job_creators to authenticated;
grant all on public.app_settings,public.workspaces,public.workspace_members,public.creators,public.workspace_creators,
 public.creator_follower_snapshots,public.reels,public.reel_metric_snapshots,public.saved_reels,public.reel_tags,
 public.scrape_jobs,public.scrape_job_creators,public.creator_retry_days to service_role;

create view public.reels_summary with (security_invoker=true) as
select r.*, c.username,c.display_name,c.avatar_url,c.followers_count,c.last_profile_fetch_at as follower_captured_at,c.status as creator_status,
 case when r.views_state='known' and r.likes_state='known' and r.comments_state='known' and c.followers_count>0
 then (r.latest_views::numeric+r.latest_likes+r.latest_comments)/c.followers_count end as follower_outlier_score,
 case when r.views_state='known' and r.likes_state='known' and r.comments_state='known' and r.latest_views>0
 then 100.0*(r.latest_likes::numeric+r.latest_comments)/r.latest_views end as engagement_rate_pct
from public.reels r join public.creators c on c.id=r.creator_id;
revoke all on public.reels_summary from public,anon,authenticated,service_role;
grant select on public.reels_summary to authenticated,service_role;

create function public.provision_owner(p_owner_user_id uuid) returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
 perform public.require_service();
 insert into public.app_settings(owner_user_id) values(p_owner_user_id) on conflict(owner_user_id) do nothing;
end; $$;

create function public.normalize_username(p_input text) returns text language plpgsql immutable set search_path = pg_catalog, public as $$
declare u text; path text;
begin
 u:=lower(trim(p_input));
 if u ~ '^https?://' or u ~ '^(www\.)?instagram\.com/' then
  u:=regexp_replace(u,'^https?://','','i'); u:=regexp_replace(u,'^www\.','','i');
  if u !~ '^instagram\.com/' then raise exception 'invalid_username' using errcode='22023'; end if;
  path:=split_part(split_part(substr(u,char_length('instagram.com')+1),'?',1),'#',1);
  if path !~ '^/[a-z0-9_.]+(/reels)?/?$' then raise exception 'invalid_username' using errcode='22023'; end if;
  u:=split_part(path,'/',2);
 else u:=regexp_replace(u,'^@',''); end if;
 if u is null or u !~ '^[a-z0-9_][a-z0-9_.]{0,29}$' or u ~ '\.\.' or right(u,1)='.' or u in ('reel','reels','p','stories','explore','accounts','about','developer','directory','legal','privacy','terms','web','challenge','direct') then
  raise exception 'invalid_username' using errcode='22023';
 end if; return u;
end; $$;
create function public.create_workspace(p_name text,p_slug text default null) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare w public.workspaces; s text;
begin
 if not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
 s:=coalesce(nullif(p_slug,''),trim(both '-' from regexp_replace(lower(trim(p_name)),'[^a-z0-9]+','-','g')));
 if s='' then s:='workspace-'||substr(gen_random_uuid()::text,1,8); end if;
 insert into public.workspaces(owner_user_id,name,slug) values(auth.uid(),trim(p_name),s) returning * into w;
 insert into public.workspace_members(workspace_id,user_id,role) values(w.id,auth.uid(),'owner');
 return to_jsonb(w)-'owner_user_id';
end; $$;
create function public.update_workspace(p_workspace_id uuid,p_name text default null,p_archived boolean default null) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare w public.workspaces; n integer; cap integer;
begin
 perform public.require_workspace(p_workspace_id);
 perform pg_advisory_xact_lock(hashtextextended('capacity:'||auth.uid()::text,0));
 if p_archived=false then
  select count(distinct wc.creator_id) into n from public.workspace_creators wc join public.workspaces ws on ws.id=wc.workspace_id
  where wc.active and ws.owner_user_id=auth.uid() and (ws.archived_at is null or ws.id=p_workspace_id);
  select capacity into cap from public.app_settings where owner_user_id=auth.uid();
  if n>cap then raise exception 'capacity_exceeded' using errcode='P0001'; end if;
 end if;
 update public.workspaces set name=coalesce(trim(p_name),name),archived_at=case when p_archived is null then archived_at when p_archived then now() else null end
 where id=p_workspace_id returning * into w; return to_jsonb(w)-'owner_user_id';
end; $$;
create function public.add_creator(p_workspace_id uuid,p_username text) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare c public.creators; n integer; cap integer;
begin
 perform public.require_workspace(p_workspace_id);
 perform pg_advisory_xact_lock(hashtextextended('capacity:'||auth.uid()::text,0));
 if exists(select 1 from public.workspaces where id=p_workspace_id and archived_at is not null) then raise exception 'workspace_archived' using errcode='22023'; end if;
 insert into public.creators(username) values(public.normalize_username(p_username)) on conflict(username) do update set username=excluded.username returning * into c;
 if not exists(select 1 from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.creator_id=c.id and wc.active and w.owner_user_id=auth.uid() and w.archived_at is null) then
  select count(distinct wc.creator_id) into n from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.active and w.archived_at is null and w.owner_user_id=auth.uid();
  select capacity into cap from public.app_settings where owner_user_id=auth.uid();
  if n>=cap then raise exception 'capacity_exceeded' using errcode='P0001'; end if;
 end if;
 insert into public.workspace_creators(workspace_id,creator_id) values(p_workspace_id,c.id) on conflict(workspace_id,creator_id) do update set active=true;
 return to_jsonb(c)-'instagram_user_id'-'created_at';
end; $$;
create function public.remove_creator(p_workspace_id uuid,p_creator_id uuid) returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
 perform public.require_workspace(p_workspace_id);
 perform pg_advisory_xact_lock(hashtextextended('capacity:'||auth.uid()::text,0));
 delete from public.saved_reels s using public.reels r where s.workspace_id=p_workspace_id and s.reel_id=r.id and r.creator_id=p_creator_id;
 delete from public.workspace_creators where workspace_id=p_workspace_id and creator_id=p_creator_id;
end; $$;
create function public.import_creators(p_workspace_id uuid,p_rows jsonb) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare row_data jsonb; wid uuid; un text; wn text; added integer:=0; duplicates integer:=0; created integer:=0; cjson jsonb; seen text[]:='{}'; key text;
begin
 perform public.require_workspace(p_workspace_id);
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>1000 then raise exception 'invalid_import' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('capacity:'||auth.uid()::text,0));
 -- One transaction: invalid rows, ownership failures and capacity overflow roll back the entire CSV.
 for row_data in select value from jsonb_array_elements(p_rows) loop
  un:=public.normalize_username(row_data->>'username'); wn:=trim(coalesce(row_data->>'workspace','')); wid:=p_workspace_id;
  if wn<>'' then
   select id into wid from public.workspaces where owner_user_id=auth.uid() and lower(name)=lower(wn) and archived_at is null order by created_at limit 1;
   if wid is null then cjson:=public.create_workspace(wn,null); wid:=(cjson->>'id')::uuid; created:=created+1; end if;
  end if;
  key:=wid::text||':'||un;
  if key=any(seen) or exists(select 1 from public.workspace_creators wc join public.creators c on c.id=wc.creator_id where wc.workspace_id=wid and wc.active and c.username=un) then duplicates:=duplicates+1;
  else perform public.add_creator(wid,un); added:=added+1; end if;
  seen:=array_append(seen,key);
 end loop;
 return jsonb_build_object('added',added,'duplicates',duplicates,'workspaces_created',created);
end; $$;

create function public.list_creators(p_workspace_id uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
 perform public.require_workspace(p_workspace_id);
 return coalesce((select jsonb_agg(to_jsonb(x) order by x.username) from (
 select c.id,c.username,c.display_name,c.avatar_url,c.followers_count,c.last_profile_fetch_at,c.status,c.last_reels_fetch_at,c.last_error,
 (select count(*) from public.reels r where r.creator_id=c.id) as tracked_reels,
 (select max(r.published_at) from public.reels r where r.creator_id=c.id) as latest_reel_date
 from public.creators c join public.workspace_creators wc on wc.creator_id=c.id where wc.workspace_id=p_workspace_id and wc.active) x),'[]'::jsonb);
end; $$;

create function public.query_reels(p_workspace_id uuid,p_query jsonb default '{}'::jsonb) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare q jsonb:=coalesce(p_query,'{}'); pg integer; lim integer; result jsonb; sort_key text; freshness text;
begin
 perform public.require_workspace(p_workspace_id);
 if jsonb_typeof(q)<>'object' or char_length(coalesce(q->>'search',''))>200 then raise exception 'invalid_query' using errcode='22023'; end if;
 pg:=coalesce((q->>'page')::integer,1); lim:=coalesce((q->>'limit')::integer,30);
 if pg not between 1 and 10000 or lim not between 1 and 50 then raise exception 'invalid_pagination' using errcode='22023'; end if;
 sort_key:=coalesce(q->>'sort','published_at'); freshness:=coalesce(q->>'freshness','all');
 if sort_key not in ('published_at','views','likes','comments','engagement','outlier') or freshness not in ('all','fresh','stale') then raise exception 'invalid_query' using errcode='22023'; end if;
 if q ? 'status' and q->>'status' not in ('active','pending','unavailable','private','failed','paused') then raise exception 'invalid_status' using errcode='22023'; end if;
 if (q ? 'from' and coalesce(q->>'from','') !~ '^\d{4}-\d{2}-\d{2}$') or (q ? 'to' and coalesce(q->>'to','') !~ '^\d{4}-\d{2}-\d{2}$') then raise exception 'invalid_date' using errcode='22023'; end if;
 if q ? 'from' and q ? 'to' and ((q->>'to')::date<(q->>'from')::date or (q->>'to')::date-(q->>'from')::date>366) then raise exception 'invalid_date_range' using errcode='22023'; end if;
 if coalesce((q->>'min_views')::numeric,0)<0 or coalesce((q->>'min_engagement')::numeric,0)<0 or coalesce((q->>'min_outlier')::numeric,0)<0 then raise exception 'invalid_threshold' using errcode='22023'; end if;
 with scoped as (
  select r.*,s.reel_id is not null as saved,coalesce(s.note,'') as note,
   coalesce((select array_agg(t.tag order by t.tag) from public.reel_tags t where t.workspace_id=p_workspace_id and t.reel_id=r.id),'{}'::text[]) as tags
  from public.reels_summary r join public.workspace_creators wc on wc.creator_id=r.creator_id and wc.workspace_id=p_workspace_id and wc.active
  left join public.saved_reels s on s.workspace_id=p_workspace_id and s.reel_id=r.id
  where (not(q ? 'search') or r.username ilike '%'||(q->>'search')||'%' or r.caption_preview ilike '%'||(q->>'search')||'%')
   and (not(q ? 'creator_id') or r.creator_id=(q->>'creator_id')::uuid)
   and (not(q ? 'min_views') or r.latest_views >= (q->>'min_views')::numeric)
   and (not(q ? 'min_engagement') or r.engagement_rate_pct >= (q->>'min_engagement')::numeric)
   and (not(q ? 'min_outlier') or r.follower_outlier_score >= (q->>'min_outlier')::numeric)
   and (not(q ? 'from') or r.published_at >= ((q->>'from')::date::timestamp at time zone 'Asia/Kolkata'))
   and (not(q ? 'to') or r.published_at < (((q->>'to')::date+1)::timestamp at time zone 'Asia/Kolkata'))
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
 ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(o)-'rn' order by rn) from ordered o where rn>(pg-1)*lim and rn<=pg*lim),'[]'::jsonb),'total',(select count(*) from scoped),'page',pg,'limit',lim) into result;
 return result;
end; $$;
create function public.get_overview(p_workspace_id uuid) returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare result jsonb;
begin
 perform public.require_workspace(p_workspace_id);
 with scoped as (select r.* from public.reels_summary r join public.workspace_creators wc on wc.creator_id=r.creator_id where wc.workspace_id=p_workspace_id and wc.active),
 leaders as (select c.id,c.username,c.display_name,c.avatar_url,c.followers_count,c.last_profile_fetch_at,c.status,c.last_reels_fetch_at,c.last_error,
 count(r.id) filter(where r.follower_outlier_score>=10) as outliers,max(r.follower_outlier_score) as best_score
 from public.creators c join public.workspace_creators wc on wc.creator_id=c.id and wc.workspace_id=p_workspace_id and wc.active left join scoped r on r.creator_id=c.id
 group by c.id order by outliers desc,best_score desc nulls last,c.username limit 10)
 select jsonb_build_object('active_competitors',(select count(*) from public.workspace_creators wc join public.creators c on c.id=wc.creator_id where wc.workspace_id=p_workspace_id and wc.active and c.status='active'),
 'tracked_reels',(select count(*) from scoped),'outliers',(select count(*) from scoped where follower_outlier_score>=10),
 'average_engagement',(select avg(engagement_rate_pct) from scoped),'last_refresh',(select max(latest_fetched_at) from scoped),
 'stale_reels',(select count(*) from scoped where latest_fetched_at<now()-interval '48 hours'),
 'leaderboard',coalesce((select jsonb_agg(jsonb_build_object('creator',to_jsonb(l)-'outliers'-'best_score','outliers',l.outliers,'best_score',l.best_score)) from leaders l),'[]'::jsonb),
 'recent',public.query_reels(p_workspace_id,'{"limit":8,"sort":"published_at"}'::jsonb)->'items') into result;
 return result;
end; $$;
create function public.set_bookmark(p_workspace_id uuid,p_reel_id uuid,p_saved boolean,p_note text default '',p_tags text[] default '{}') returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
 perform public.require_workspace(p_workspace_id);
 perform pg_advisory_xact_lock(hashtextextended('capacity:'||auth.uid()::text,0));
 if not exists(select 1 from public.reels r join public.workspace_creators wc on wc.creator_id=r.creator_id where r.id=p_reel_id and wc.workspace_id=p_workspace_id and wc.active) then raise exception 'reel_not_in_workspace' using errcode='42501'; end if;
 if p_saved is null or p_note is null or p_tags is null or cardinality(p_tags)>20 then raise exception 'invalid_bookmark' using errcode='22023'; end if;
 if p_saved then
  insert into public.saved_reels(workspace_id,reel_id,saved_by_user_id,note) values(p_workspace_id,p_reel_id,auth.uid(),p_note)
  on conflict(workspace_id,reel_id) do update set note=excluded.note;
  delete from public.reel_tags where workspace_id=p_workspace_id and reel_id=p_reel_id;
  insert into public.reel_tags(workspace_id,reel_id,tag) select p_workspace_id,p_reel_id,trim(t) from unnest(p_tags) t group by trim(t);
 else delete from public.saved_reels where workspace_id=p_workspace_id and reel_id=p_reel_id; end if;
end; $$;

create function public.update_settings(p_settings jsonb) returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare s public.app_settings; n integer;
begin
 if not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
 if jsonb_typeof(p_settings)<>'object' or exists(select 1 from jsonb_object_keys(p_settings) k where k not in ('daily_limit','weekly_limit','monthly_budget_usd','budget_warning_pct','paused','capacity')) then raise exception 'invalid_settings' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('capacity:'||auth.uid()::text,0));
 perform pg_advisory_xact_lock(hashtextextended('budget:'||auth.uid()::text,0));
 select count(distinct wc.creator_id) into n from public.workspace_creators wc join public.workspaces w on w.id=wc.workspace_id where wc.active and w.archived_at is null and w.owner_user_id=auth.uid();
 if coalesce((p_settings->>'capacity')::integer,1000)<n then raise exception 'capacity_below_current' using errcode='22023'; end if;
 update public.app_settings set daily_limit=coalesce((p_settings->>'daily_limit')::integer,daily_limit),weekly_limit=coalesce((p_settings->>'weekly_limit')::integer,weekly_limit),
 monthly_budget_usd=coalesce((p_settings->>'monthly_budget_usd')::numeric,monthly_budget_usd),budget_warning_pct=coalesce((p_settings->>'budget_warning_pct')::integer,budget_warning_pct),
 paused=coalesce((p_settings->>'paused')::boolean,paused),capacity=coalesce((p_settings->>'capacity')::integer,capacity) where owner_user_id=auth.uid() returning * into s;
 return jsonb_build_object('daily_limit',s.daily_limit,'weekly_limit',s.weekly_limit,'monthly_budget_usd',s.monthly_budget_usd,'budget_warning_pct',s.budget_warning_pct,'paused',s.paused,'timezone',s.timezone,'capacity',s.capacity,'scraping_enabled',s.scraping_enabled);
end; $$;
create function public.get_bootstrap() returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare s public.app_settings; usage jsonb; month_start date:=(date_trunc('month',now() at time zone 'UTC'))::date; actual numeric; reserved numeric; unknown integer; estimate numeric;
begin
 if not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
 select * into s from public.app_settings where owner_user_id=auth.uid();
 select coalesce(sum(estimated_cost_usd) filter(where (scheduled_for at time zone 'UTC')::date>=month_start),0),coalesce(sum(actual_cost_usd) filter(where billing_month=month_start),0),coalesce(sum(reserved_usd),0),count(*) filter(where live and actual_cost_usd is null and status<>'pending' and status<>'budget_paused') into estimate,actual,reserved,unknown
 from public.scrape_jobs where owner_user_id=auth.uid();
 usage:=jsonb_build_object('estimated_month_spend',estimate,'actual_month_spend',case when unknown>0 then null else actual end,'reserved_usd',reserved,'unreconciled_jobs',unknown,
 'remaining_allowance',greatest(0,s.monthly_budget_usd-greatest(actual,case when s.provider_billing_month=month_start then coalesce(s.provider_month_spend_usd,0) else 0 end)-reserved),
 'provider_balance_usd',case when s.provider_balance_checked_at>now()-interval '15 minutes' then s.provider_balance_usd end);
 return jsonb_build_object('mode','supabase','workspaces',coalesce((select jsonb_agg(to_jsonb(w)-'owner_user_id' order by created_at) from public.workspaces w where public.is_workspace_member(w.id)),'[]'::jsonb),
 'settings',jsonb_build_object('daily_limit',s.daily_limit,'weekly_limit',s.weekly_limit,'monthly_budget_usd',s.monthly_budget_usd,'budget_warning_pct',s.budget_warning_pct,'paused',s.paused,'timezone',s.timezone,'capacity',s.capacity,'scraping_enabled',s.scraping_enabled),
 'usage',usage,'jobs',coalesce((select jsonb_agg(to_jsonb(j) order by scheduled_for desc) from (select id,kind,status,scheduled_for,started_at,completed_at,actor_run_id,requested_profiles_count,returned_records_count,estimated_cost_usd,actual_cost_usd,error_message,attempt_count from public.scrape_jobs where owner_user_id=auth.uid() order by scheduled_for desc limit 50) j),'[]'::jsonb),
 'email',coalesce(auth.jwt()->>'email',''));
end; $$;

-- Hosted default ACLs grant service_role EXECUTE directly, independently of PUBLIC.
-- Revoke every app function from every API role, then grant only its intended entry points.
-- SECURITY DEFINER bodies still call helpers with the migration owner's privileges.
revoke execute on function public.is_allowed_owner(),public.is_workspace_member(uuid),public.can_read_creator(uuid),public.require_workspace(uuid),public.normalize_username(text),
 public.create_workspace(text,text),public.update_workspace(uuid,text,boolean),public.add_creator(uuid,text),public.remove_creator(uuid,uuid),public.import_creators(uuid,jsonb),
 public.list_creators(uuid),public.query_reels(uuid,jsonb),public.get_overview(uuid),public.set_bookmark(uuid,uuid,boolean,text,text[]),public.update_settings(jsonb),public.get_bootstrap(),
 public.provision_owner(uuid),public.require_service() from public,anon,authenticated,service_role;
grant execute on function public.is_allowed_owner(),public.is_workspace_member(uuid),public.can_read_creator(uuid),public.require_workspace(uuid),public.normalize_username(text),
 public.create_workspace(text,text),public.update_workspace(uuid,text,boolean),public.add_creator(uuid,text),public.remove_creator(uuid,uuid),public.import_creators(uuid,jsonb),
 public.list_creators(uuid),public.query_reels(uuid,jsonb),public.get_overview(uuid),public.set_bookmark(uuid,uuid,boolean,text,text[]),public.update_settings(jsonb),public.get_bootstrap() to authenticated;
grant execute on function public.provision_owner(uuid),public.require_service() to service_role;

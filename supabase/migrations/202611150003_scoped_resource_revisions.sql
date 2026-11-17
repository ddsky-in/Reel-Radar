-- Scoped signal-only browser cache revisions. No provider calls, schedules, or
-- billing/reservation changes. Keep owner_revisions for existing clients.
create table public.owner_resource_revisions (
  owner_user_id uuid not null references auth.users(id) on delete restrict,
  family text not null check (family in (
    'creators','reels','carousels','jobs','settings','transcription',
    'saved_reels','saved_carousels','reel_filters','carousel_filters','workspaces'
  )),
  workspace_id uuid,
  -- Realtime's WAL/RLS authorization requires a non-null primary key. This is
  -- scope metadata only, constrained to the already-permitted workspace column.
  scope_key text not null default 'global' check (scope_key = coalesce(workspace_id::text, 'global')),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (owner_user_id, family, scope_key)
);
-- No private source rows are published; the primary key is only owner scope.
alter table public.owner_resource_revisions enable row level security;
revoke all on public.owner_resource_revisions from public, anon, authenticated, service_role;
grant select on public.owner_resource_revisions to authenticated, service_role;
create policy owner_resource_revision_read on public.owner_resource_revisions for select to authenticated
  using (owner_user_id = auth.uid() and public.is_allowed_owner() and
    (workspace_id is null or public.is_workspace_member(workspace_id)));

create function public.signal_owner_resource_revision() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_rows jsonb[];
  v_row jsonb;
  v_owner uuid;
  v_workspace uuid;
  v_family text;
  v_scope text;
  v_seen jsonb;
  v_marker text;
  v_transaction text := txid_current()::text;
begin
  -- No-op writes do not generate cache work. Never inspect/send research values
  -- beyond resolving authorized ownership inside this private trigger function.
  if tg_op = 'UPDATE' and old is not distinct from new then return null; end if;
  v_rows := case when tg_op = 'INSERT' then array[to_jsonb(new)]
    when tg_op = 'DELETE' then array[to_jsonb(old)]
    else array[to_jsonb(old), to_jsonb(new)] end;
  v_seen := coalesce(nullif(current_setting('reelradar.resource_revision_scopes', true), '')::jsonb, '[]'::jsonb);
  foreach v_row in array v_rows loop
    v_owner := null;
    v_workspace := null;
    if tg_table_name in ('workspaces','workspace_members','workspace_creators','saved_reels','reel_tags','saved_carousels') then
      v_workspace := case when tg_table_name = 'workspaces' then (v_row->>'id')::uuid else (v_row->>'workspace_id')::uuid end;
      select owner_user_id into v_owner from public.workspaces where id = v_workspace;
      if v_owner is null then
        -- A cascading delete may already have removed its parent. Use a global
        -- owner signal, never expose a guessed/foreign workspace identifier.
        v_workspace := null;
      end if;
    end if;
    if v_owner is null and v_row ? 'owner_user_id' then v_owner := (v_row->>'owner_user_id')::uuid; end if;
    if v_owner is null then select owner_user_id into v_owner from public.app_settings where singleton; end if;
    if v_owner is null then continue; end if;
    -- Membership/workspace deletion can revoke the very RLS permission needed
    -- to receive a workspace-scoped event. Authorization metadata changes use
    -- a surviving owner-global signal so bootstrap and mounted reads recover.
    if tg_table_name in ('workspaces', 'workspace_members') then v_workspace := null; end if;
    -- Both feeds flush only after source/budget/app-settings mutations finish.
    -- The shared owner row MUST be locked before any family row: otherwise a
    -- creator -> jobs transaction can deadlock with jobs -> legacy owner. An
    -- eager owner lock merely moves that cycle to app_settings/budget locks.
    -- Use the legacy marker so old clients still receive exactly one revision.
    v_marker := v_owner::text || ':' || v_transaction;
    if current_setting('reelradar.owner_revision_transaction', true) is distinct from v_marker then
      insert into public.owner_revisions(owner_user_id, revision, updated_at)
        values(v_owner, 1, clock_timestamp())
        on conflict(owner_user_id) do update set
          revision = public.owner_revisions.revision + 1, updated_at = excluded.updated_at;
      perform set_config('reelradar.owner_revision_transaction', v_marker, true);
    end if;
    -- Shared canonical creator/reel/carousel rows affect all owner's workspaces.
    -- Do not infer a single workspace from the current membership graph.
    foreach v_family in array tg_argv loop
      v_scope := v_transaction || ':' || v_owner::text || ':' || v_family || ':' || coalesce(v_workspace::text, '*');
      if v_seen ? v_scope then continue; end if;
      insert into public.owner_resource_revisions(owner_user_id, family, workspace_id, scope_key, revision, updated_at)
        values(v_owner, v_family, v_workspace, coalesce(v_workspace::text, 'global'), 1, clock_timestamp())
        on conflict(owner_user_id, family, scope_key) do update set
          revision = public.owner_resource_revisions.revision + 1, updated_at = excluded.updated_at;
      v_seen := v_seen || jsonb_build_array(v_scope);
      perform set_config('reelradar.resource_revision_scopes', v_seen::text, true);
    end loop;
  end loop;
  return null;
end;
$$;
revoke all on function public.signal_owner_resource_revision() from public, anon, authenticated, service_role;

-- Arguments are a fixed domain allowlist. Deduplicate per owner/family/scope,
-- NOT per owner/transaction: later different families must never be overwritten
-- or skipped by an earlier change. Each affected family survives in its own row.
do $$
declare
  v_mapping record;
  v_arguments text;
begin
  for v_mapping in select * from (values
    ('app_settings', array['settings','jobs','transcription']),
    ('workspaces', array['workspaces','creators','jobs','settings']),
    ('workspace_members', array['workspaces','creators','reels','carousels','jobs']),
    ('workspace_creators', array['creators','reels','carousels','workspaces','jobs']),
    ('creators', array['creators','reels','carousels']),
    ('creator_follower_snapshots', array['creators','reels','carousels']),
    ('reels', array['reels','creators']),
    ('reel_metric_snapshots', array['reels']),
    ('reel_fetch_observations', array['reels','creators']),
    ('saved_reels', array['saved_reels']),
    ('reel_tags', array['saved_reels']),
    ('carousel_posts', array['carousels']),
    ('carousel_metric_snapshots', array['carousels']),
    ('saved_carousels', array['saved_carousels']),
    ('scrape_jobs', array['jobs']),
    ('scrape_job_creators', array['jobs','creators']),
    ('scrape_callback_receipts', array['jobs']),
    ('creator_retry_days', array['jobs','creators']),
    ('creator_initializations', array['jobs','creators']),
    ('budget_envelopes', array['jobs','settings']),
    ('competitor_refresh_runs', array['jobs','creators']),
    ('competitor_refresh_targets', array['jobs','creators']),
    ('apify_accounts', array['jobs','settings']),
    -- Capacity configuration affects summaries, not internal executor/wake churn.
    ('collection_worker_settings', array['settings','jobs']),
    ('carousel_automation_settings', array['settings','carousels','jobs']),
    ('transcription_settings', array['transcription','settings']),
    ('transcription_webhook_setup', array['transcription','settings']),
    ('reel_media_sources', array['transcription']),
    ('transcript_jobs', array['transcription']),
    ('transcript_attempts', array['transcription','jobs','settings']),
    ('reel_transcripts', array['transcription']),
    ('transcription_media_refreshes', array['transcription','jobs']),
    ('transcription_media_targets', array['transcription','jobs']),
    ('saved_reel_filters', array['reel_filters']),
    ('saved_carousel_filters', array['carousel_filters'])
  ) as domains(table_name, families) loop
    if to_regclass('public.' || v_mapping.table_name) is null then continue; end if;
    select string_agg(quote_literal(family), ',') into v_arguments from unnest(v_mapping.families) as family;
    if v_mapping.table_name = 'collection_worker_settings' then
      -- Executor wake/lease bookkeeping is not user configuration. Constraint
      -- triggers cannot use UPDATE OF; the immediate WHEN evaluation queues
      -- only meaningful control changes for the same deferred, ordered flush.
      execute format('create constraint trigger owner_resource_revision_changed after update on public.%I deferrable initially deferred for each row when (old.max_active is distinct from new.max_active or old.max_starts_per_wake is distinct from new.max_starts_per_wake) execute function public.signal_owner_resource_revision(%s)', v_mapping.table_name, v_arguments);
      execute format('create constraint trigger owner_revision_changed after update on public.%I deferrable initially deferred for each row when (old.max_active is distinct from new.max_active or old.max_starts_per_wake is distinct from new.max_starts_per_wake) execute function public.signal_owner_revision()', v_mapping.table_name);
      continue;
    end if;
    execute format('create constraint trigger owner_resource_revision_changed after insert or update or delete on public.%I deferrable initially deferred for each row execute function public.signal_owner_resource_revision(%s)', v_mapping.table_name, v_arguments);
    -- Newly covered domains must still notify older clients as well.
    if not exists(select 1 from pg_trigger where tgrelid = to_regclass('public.' || v_mapping.table_name) and tgname = 'owner_revision_changed' and not tgisinternal) then
      execute format('create constraint trigger owner_revision_changed after insert or update or delete on public.%I deferrable initially deferred for each row execute function public.signal_owner_revision()', v_mapping.table_name);
    end if;
  end loop;
end;
$$;

-- Retrofit the legacy feed as well, including any legacy-only domains. Leaving
-- even one eager trigger would reintroduce owner -> source/budget lock cycles.
-- Existing legacy triggers are unguarded INSERT/UPDATE/DELETE row triggers;
-- newly created guarded collection-control constraints are already deferred.
-- Reads within an open transaction see the previous revision until commit (or
-- an explicit SET CONSTRAINTS flush). Production mutations keep signals deferred.
do $$
declare
  v_trigger record;
begin
  for v_trigger in
    select t.tgname, n.nspname, c.relname
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
    where t.tgfoid = 'public.signal_owner_revision()'::regprocedure
      and not t.tgisinternal and not t.tgdeferrable
    order by n.nspname, c.relname, t.tgname
  loop
    execute format('drop trigger %I on %I.%I', v_trigger.tgname, v_trigger.nspname, v_trigger.relname);
    execute format('create constraint trigger %I after insert or update or delete on %I.%I deferrable initially deferred for each row execute function public.signal_owner_revision()', v_trigger.tgname, v_trigger.nspname, v_trigger.relname);
  end loop;
end;
$$;

do $$
begin
  if not exists(select 1 from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if;
  if not exists(select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'owner_resource_revisions') then
    alter publication supabase_realtime add table public.owner_resource_revisions;
  end if;
end;
$$;

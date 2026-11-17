-- Signal-only app-state sync. No collection schedules or provider work are changed.
create table public.owner_revisions (
  owner_user_id uuid primary key references auth.users(id) on delete restrict,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);
alter table public.owner_revisions enable row level security;
revoke all on public.owner_revisions from public, anon, authenticated, service_role;
grant select on public.owner_revisions to authenticated, service_role;
create policy owner_revision_read on public.owner_revisions for select to authenticated
  using (owner_user_id = auth.uid() and public.is_allowed_owner());

insert into public.owner_revisions(owner_user_id)
select owner_user_id from public.app_settings on conflict do nothing;

create function public.signal_owner_revision() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_owner uuid;
  v_marker text;
begin
  select owner_user_id into v_owner from public.app_settings where singleton;
  if v_owner is null and tg_table_name = 'app_settings' and tg_op = 'DELETE' then
    v_owner := old.owner_user_id;
  end if;
  if v_owner is null then return null; end if;
  v_marker := v_owner::text || ':' || txid_current()::text;
  if current_setting('reelradar.owner_revision_transaction', true) = v_marker then return null; end if;
  insert into public.owner_revisions(owner_user_id, revision, updated_at)
    values (v_owner, 1, clock_timestamp())
    on conflict(owner_user_id) do update set
      revision = public.owner_revisions.revision + 1, updated_at = excluded.updated_at;
  perform set_config('reelradar.owner_revision_transaction', v_marker, true);
  return null;
end;
$$;
revoke all on function public.signal_owner_revision() from public, anon, authenticated, service_role;

-- Each source mutation, including deletions, updates a surviving authorized row.
do $$
declare v_table text;
begin
  foreach v_table in array array[
    'app_settings','workspaces','workspace_members','workspace_creators','creators',
    'creator_follower_snapshots','reels','reel_metric_snapshots','saved_reels','reel_tags',
    'scrape_jobs','scrape_job_creators','creator_retry_days','creator_initializations','budget_envelopes'
  ] loop
    if to_regclass('public.' || v_table) is not null then
      execute format('create trigger owner_revision_changed after insert or update or delete on public.%I for each row execute function public.signal_owner_revision()', v_table);
    end if;
  end loop;
end;
$$;

-- Preserve unrelated publication members; never publish raw application payloads.
do $$
begin
  if not exists(select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists(select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'owner_revisions') then
    alter publication supabase_realtime add table public.owner_revisions;
  end if;
end;
$$;

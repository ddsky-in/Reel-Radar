-- Keep authenticated API contracts while isolating privileged implementations
-- from the exposed public schema. ALTER ... SET SCHEMA preserves dependency OIDs.
create schema authenticated_rpc_private;
revoke all on schema authenticated_rpc_private from public,anon,authenticated,service_role;
grant usage on schema authenticated_rpc_private to authenticated;

do $migration$
declare f record; positional_args text; moved integer:=0;
  names text[]:=array[
    'can_read_creator','collection_settle_job','create_carousel_filter','create_reel_filter','create_workspace',
    'delete_carousel_filter','delete_reel_filter','enqueue_carousel_refresh','enqueue_refresh','get_apify_account_status',
    'get_bootstrap','get_carousel_collection_status','get_carousel_detail','get_collection_holds','get_collection_job_recovery',
    'get_creator','get_creator_collection_state','get_creator_collection_summary','get_overview','get_profile_automation_status',
    'get_reel_transcript','get_transcription_overview','import_creators','is_allowed_owner','is_workspace_member',
    'list_carousel_filters','list_creator_directory','list_creators','list_reel_filters','query_carousel_summaries',
    'query_carousels','query_creators','query_reels','remove_creator','require_workspace','set_bookmark',
    'set_carousel_bookmark','update_settings','update_transcription_preferences','update_transcription_settings','update_workspace'];
begin
  for f in select p.*,pg_get_function_identity_arguments(p.oid) identity_args,
      pg_get_function_arguments(p.oid) declared_args,pg_get_function_result(p.oid) result_type
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=any(names) order by p.proname
  loop
    -- Fail on drift rather than silently widening an existing role's access.
    if not f.prosecdef or f.proretset or f.proisstrict or f.provariadic<>0
      or not has_function_privilege('authenticated',f.oid,'execute')
      or has_function_privilege('anon',f.oid,'execute')
      or has_function_privilege('service_role',f.oid,'execute') then
      raise exception 'unexpected_authenticated_rpc_contract: %',f.proname;
    end if;
    select coalesce(string_agg('$'||i,', ' order by i),'') into positional_args
      from generate_series(1,f.pronargs) i;
    execute format('alter function public.%I(%s) set schema authenticated_rpc_private',f.proname,f.identity_args);
    execute format('revoke all on function authenticated_rpc_private.%I(%s) from public,anon,service_role',f.proname,f.identity_args);
    execute format('create function public.%I(%s) returns %s language sql %s security invoker set search_path=pg_catalog as %L',
      f.proname,f.declared_args,f.result_type,
      case f.provolatile when 's' then 'stable' when 'i' then 'immutable' else 'volatile' end,
      format('select authenticated_rpc_private.%I(%s)',f.proname,positional_args));
    execute format('revoke all on function public.%I(%s) from public,anon,authenticated,service_role',f.proname,f.identity_args);
    execute format('grant execute on function public.%I(%s) to authenticated',f.proname,f.identity_args);
    moved:=moved+1;
  end loop;
  if moved<>cardinality(names) then raise exception 'authenticated_rpc_manifest_mismatch: %',moved; end if;
end $migration$;

notify pgrst,'reload schema';

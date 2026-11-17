-- Forward-only correction for a real multi-session local PostgreSQL deadlock.
-- Ingestion's carousel wrapper formerly took job -> transcription_settings,
-- while dispatch took transcription_settings -> budget and reconcile budget ->
-- job. Those three actual RPCs formed a native 40P01 cycle. Take transcription
-- first at the public ingestion entrypoint, before its unchanged job/lease body.
-- No networking, schedules, credentials, costs, reservation changes, accepted-run
-- replays, or authorization/grant changes. Reconcile/finish remain untouched.
do $$
declare
  signature text := 'public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb)';
  def text;
  patched text;
  lock_prefix text := E'begin\n  -- collection_lock_order_v1: transcription before the inherited job lock.\n  perform public.require_service();\n  perform 1 from public.transcription_settings where singleton for update;\n';
begin
  select pg_get_functiondef(signature::regprocedure) into def;
  if def is null or def not like '%SECURITY DEFINER%' or def not like '%public.require_service()%'
    or def not like '%worker_ingest_page_pre_carousels(%' or def not like '%where id=p_job_id for update%'
    or def like '%collection_lock_order_v1%'
    or (select count(*) from regexp_matches(def, E'(?m)^begin[ \\t]*\\r?\\n', 'g')) <> 1 then
    raise exception 'collection_lock_order_contract_drift: %', signature;
  end if;
  -- Replace only the outer entrypoint BEGIN. pg_get_functiondef retains its
  -- SECURITY DEFINER, search_path, defaults, existing body and CREATE OR REPLACE
  -- identity, so PostgreSQL retains the existing ACL. Private inherited bodies
  -- remain revoked and can only be reached behind this normalized entrypoint.
  patched := regexp_replace(def, E'(?m)^begin[ \\t]*\\r?\\n', lock_prefix);
  if patched = def or position('collection_lock_order_v1' in patched)=0 then
    raise exception 'collection_lock_order_patch_failed: %', signature;
  end if;
  execute patched;
end $$;

-- Workspace-scoped completion lives with the existing bookmark. Existing saved
-- Reels start Pending; changing notes/tags never resets their completion state.
alter table public.saved_reels add column completion_status text not null default 'pending'
  check(completion_status in ('pending','done')), add column completed_at timestamptz,
  add constraint saved_reel_completion_time check((completion_status='done')=(completed_at is not null));

create function reel_detail_private.set_completion(p_workspace_id uuid,p_reel_id uuid,p_status text) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if auth.uid() is null or not public.is_allowed_owner() then raise exception 'forbidden' using errcode='42501'; end if;
  perform public.require_workspace(p_workspace_id);
  if p_status is null or p_status not in ('pending','done') then raise exception 'invalid_completion_status' using errcode='22023'; end if;
  if not exists(select 1 from public.reels r join public.workspace_creators wc on wc.creator_id=r.creator_id
    join public.workspaces w on w.id=wc.workspace_id where r.id=p_reel_id and wc.workspace_id=p_workspace_id
    and wc.active and w.archived_at is null and w.owner_user_id=auth.uid()) then raise exception 'reel_not_in_workspace' using errcode='42501'; end if;
  perform 1 from public.saved_reels where workspace_id=p_workspace_id and reel_id=p_reel_id for update;
  if not found then raise exception 'reel_not_saved' using errcode='22023'; end if;
  update public.saved_reels set completion_status=p_status,completed_at=case when p_status='done' then now() end
    where workspace_id=p_workspace_id and reel_id=p_reel_id and completion_status is distinct from p_status;
end $$;
revoke all on function reel_detail_private.set_completion(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function reel_detail_private.set_completion(uuid,uuid,text) to authenticated;
create function public.set_saved_reel_completion(p_workspace_id uuid,p_reel_id uuid,p_status text) returns void
language sql security invoker set search_path=pg_catalog as $$ select reel_detail_private.set_completion(p_workspace_id,p_reel_id,p_status); $$;
revoke all on function public.set_saved_reel_completion(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.set_saved_reel_completion(uuid,uuid,text) to authenticated;

-- One authorized filtered order powers both pagination and neighbor lookup.
-- Score values continue to come from reels_summary; no formula changes.
create function reel_detail_private.ordered_reels(p_workspace_id uuid,p_query jsonb) returns table(item jsonb,ordinal bigint)
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare q jsonb; sort_key text; freshness text; creator_ids uuid[];
begin
  perform public.require_workspace(p_workspace_id);
  q:=public.validate_reel_query(p_query);
  sort_key:=coalesce(q->>'sort','published_at'); freshness:=coalesce(q->>'freshness','all');
  if q ? 'creator_ids' then select coalesce(array_agg(value::uuid),'{}'::uuid[]) into creator_ids from jsonb_array_elements_text(q->'creator_ids'); end if;
  return query with scoped as (
    select r.*,s.reel_id is not null as saved,coalesce(s.note,'') as note,coalesce(s.completion_status,'pending') as completion_status,
      coalesce((select array_agg(t.tag order by t.tag) from public.reel_tags t where t.workspace_id=p_workspace_id and t.reel_id=r.id),'{}'::text[]) as tags
    from public.reels_summary r join public.workspace_creators wc on wc.creator_id=r.creator_id and wc.workspace_id=p_workspace_id and wc.active
    join public.reels base on base.id=r.id left join public.saved_reels s on s.workspace_id=p_workspace_id and s.reel_id=r.id
    where (not(q ? 'search') or r.username ilike '%'||(q->>'search')||'%' or r.caption_preview ilike '%'||(q->>'search')||'%')
      and (not(q ? 'keywords') or strpos(lower(r.caption_preview),lower(q->>'keywords'))>0)
      and (not(q ? 'creator_id') or r.creator_id=(q->>'creator_id')::uuid)
      and (not(q ? 'creator_ids') or r.creator_id=any(creator_ids))
      and (not(q ? 'min_views') or r.latest_views>=(q->>'min_views')::numeric)
      and (not(q ? 'max_views') or r.latest_views<=(q->>'max_views')::numeric)
      and (not(q ? 'min_engagement') or r.engagement_rate_pct>=(q->>'min_engagement')::numeric)
      and (not(q ? 'max_engagement') or r.engagement_rate_pct<=(q->>'max_engagement')::numeric)
      and (not(q ? 'min_outlier') or r.follower_outlier_score>=(q->>'min_outlier')::numeric)
      and (not(q ? 'max_outlier') or r.follower_outlier_score<=(q->>'max_outlier')::numeric)
      and (not(q ? 'from') or r.published_at>=((q->>'from')::date::timestamp at time zone 'Asia/Kolkata'))
      and (not(q ? 'to') or r.published_at<(((q->>'to')::date+1)::timestamp at time zone 'Asia/Kolkata'))
      and (not(q ? 'platform') or base.platform=q->>'platform')
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
  ) select to_jsonb(o)-'rn',o.rn from ordered o;
end $$;
revoke all on function reel_detail_private.ordered_reels(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function reel_detail_private.ordered_reels(uuid,jsonb) to authenticated;

create or replace function public.query_reels(p_workspace_id uuid,p_query jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare pg integer:=coalesce((p_query->>'page')::integer,1); lim integer:=coalesce((p_query->>'limit')::integer,30); result jsonb;
begin
  with ordered as materialized(select * from reel_detail_private.ordered_reels(p_workspace_id,p_query))
  select jsonb_build_object('items',coalesce((select jsonb_agg(item order by ordinal) from ordered where ordinal>(pg-1)*lim and ordinal<=pg*lim),'[]'::jsonb),
    'total',(select count(*) from ordered),'page',pg,'limit',lim) into result;
  return result;
end $$;
revoke all on function public.query_reels(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.query_reels(uuid,jsonb) to authenticated;

create function public.get_reel_neighbors(p_workspace_id uuid,p_reel_id uuid,p_query jsonb default '{}'::jsonb) returns jsonb
language sql stable security invoker set search_path=pg_catalog as $$
  with ordered as materialized(select * from reel_detail_private.ordered_reels(p_workspace_id,p_query)),
    current_reel as(select ordinal from ordered where item->>'id'=p_reel_id::text)
  select jsonb_build_object('previous_id',(select item->>'id' from ordered where ordinal=(select ordinal-1 from current_reel)),
    'next_id',(select item->>'id' from ordered where ordinal=(select ordinal+1 from current_reel)),
    'position',(select ordinal from current_reel),'total',(select count(*) from ordered));
$$;
revoke all on function public.get_reel_neighbors(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.get_reel_neighbors(uuid,uuid,jsonb) to authenticated;

alter function reel_detail_private.read_detail(uuid,uuid) rename to read_detail_pre_completion;
revoke all on function reel_detail_private.read_detail_pre_completion(uuid,uuid) from public,anon,authenticated,service_role;
create function reel_detail_private.read_detail(p_workspace_id uuid,p_reel_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare detail jsonb; completion text;
begin
  detail:=reel_detail_private.read_detail_pre_completion(p_workspace_id,p_reel_id);
  select completion_status into completion from public.saved_reels where workspace_id=p_workspace_id and reel_id=p_reel_id;
  return jsonb_set(detail,'{reel,completion_status}',to_jsonb(coalesce(completion,'pending')));
end $$;
revoke all on function reel_detail_private.read_detail(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function reel_detail_private.read_detail(uuid,uuid) to authenticated;

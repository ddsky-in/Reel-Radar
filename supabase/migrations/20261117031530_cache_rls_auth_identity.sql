-- Evaluate statement-constant identity checks once, retaining every owner and
-- row-dependent workspace predicate. No grants, roles or write policies change.
alter policy owner_settings_read on public.app_settings
  using (owner_user_id=(select auth.uid()));
alter policy members_private_read on public.workspace_members
  using (user_id=(select auth.uid()) and public.is_workspace_member(workspace_id));
alter policy jobs_read on public.scrape_jobs
  using (owner_user_id=(select auth.uid()) and (select public.is_allowed_owner()));
alter policy budget_envelope_owner_read on public.budget_envelopes
  using (owner_user_id=(select auth.uid()) and (select public.is_allowed_owner()));
alter policy owner_revision_read on public.owner_revisions
  using (owner_user_id=(select auth.uid()) and (select public.is_allowed_owner()));
alter policy saved_reel_filter_owner_read on public.saved_reel_filters
  using (owner_user_id=(select auth.uid()) and (select public.is_allowed_owner()));
alter policy owner_resource_revision_read on public.owner_resource_revisions
  using (owner_user_id=(select auth.uid()) and (select public.is_allowed_owner())
    and (workspace_id is null or public.is_workspace_member(workspace_id)));

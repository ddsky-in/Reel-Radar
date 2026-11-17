import { AccountDiagnosticsError, accountDiagnostics, authenticate, body, CollectionSession, configureAccounts, continuationBudget, diagnosticsMissingKeys, dispatch, dispatchCarouselPilot, inspectRun, json, rpc, validUuid, wakeReconciliation } from '../_shared/worker.ts';
import { env, liveMode, required, validateCarouselPilotSetup, validateDispatchSetup, validateProfileSetup } from '../_shared/providers.ts';
export async function handler(request: Request): Promise<Response> {
  if (!await authenticate(request)) return json({ error: 'unauthorized' }, 401);
  try {
    const input = await body(request);
    if (input.action !== undefined && (typeof input.action !== 'string' || !['diagnostics', 'configure_accounts', 'configure_collection_throughput', 'configure_carousel_automation', 'configure_profile_automation', 'inspect_run', 'install_competitor_schedules', 'carousel_pilot'].includes(input.action))) return json({ error: 'invalid_action' }, 400);
    if (input.action === 'diagnostics') {
      const missing = diagnosticsMissingKeys();
      if (missing.length) return json({ error: 'diagnostics_configuration_missing', missingKeys: missing }, 503);
      const owner = required('REELRADAR_OWNER_USER_ID');
      if (!validUuid(owner)) return json({ error: 'diagnostics_configuration_invalid', invalidKeys: ['REELRADAR_OWNER_USER_ID'] }, 503);
      return json({ diagnostics: await accountDiagnostics(owner) });
    }
    const owner = required('REELRADAR_OWNER_USER_ID');
    if (!validUuid(owner)) throw new Error('Owner setup invalid');
    if (input.action === 'configure_accounts') return json({ accounts: await configureAccounts(owner, input) });
    if (input.action === 'configure_collection_throughput') {
      if (![input.max_active, input.max_starts_per_wake].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 4) ||
          Object.keys(input).some(key => !['action','max_active','max_starts_per_wake'].includes(key))) return json({ error: 'invalid_collection_throughput' }, 400);
      // Service-only configuration does not reconcile usage, start work or alter money.
      return json({ throughput: await rpc('worker_configure_collection_throughput', {
        p_owner_user_id: owner, p_max_active: input.max_active, p_max_starts_per_wake: input.max_starts_per_wake,
      }) });
    }
    if (input.action === 'configure_carousel_automation') {
      if (typeof input.enabled !== 'boolean' || Object.keys(input).some(key => !['action', 'enabled'].includes(key))) return json({ error: 'invalid_carousel_automation_configuration' }, 400);
      const providerValidated = env('CAROUSEL_PROVIDER_VALIDATED') === 'true';
      if (input.enabled) {
        if (!providerValidated || !liveMode()) throw new Error('Carousel automation requires validated live provider setup');
        validateDispatchSetup();
      }
      // Configure durable state only. Usage reconciliation, queue maintenance and
      // transactional budget reservations stay in the existing generic wake.
      return json({ automation: await rpc('worker_configure_carousel_automation', {
        p_owner_user_id: owner, p_enabled: input.enabled, p_provider_validated: providerValidated,
      }) });
    }
    if (input.action === 'configure_profile_automation') {
      if (typeof input.enabled !== 'boolean' || Object.keys(input).some(key => !['action', 'enabled'].includes(key))) return json({ error: 'invalid_profile_automation_configuration' }, 400);
      const providerValidated = env('PROFILE_PROVIDER_VALIDATED') === 'true';
      if (input.enabled) {
        if (!providerValidated || !liveMode()) throw new Error('Profile automation requires validated live provider setup');
        validateProfileSetup('profile');
        validateDispatchSetup();
      }
      // Configuration only: combined profile jobs are queued on generic wakes,
      // then use the existing provider, budget and partial-completion path.
      return json({ automation: await rpc('worker_configure_profile_automation', {
        p_owner_user_id: owner, p_enabled: input.enabled, p_provider_validated: providerValidated,
      }) });
    }
    if (input.action === 'install_competitor_schedules') {
      validateDispatchSetup();
      return json(await rpc('worker_install_competitor_schedules', { p_owner_user_id: owner, p_edge_url: required('SUPABASE_URL'), p_secret: required('INTERNAL_CRON_SECRET') }));
    }
    if (input.action === 'inspect_run') {
      if (typeof input.run_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.run_id)) return json({ error: 'invalid_run_id' }, 400);
      return json({ inspection: await inspectRun(owner, input.run_id) });
    }
    const budget = continuationBudget(input);
    if (input.action === 'carousel_pilot') {
      if (!validUuid(input.job_id) || input.kind !== undefined) return json({ error: 'invalid_pilot_job' }, 400);
      validateCarouselPilotSetup(input.job_id);
      const outcome = await dispatchCarouselPilot(owner, input.job_id);
      if (outcome.status === 'running') wakeReconciliation(budget, input.job_id);
      return json({ outcome });
    }
    if (input.kind !== undefined) {
      if (typeof input.kind !== 'string' || !['daily', 'weekly', 'profile', 'retry', 'discovery', 'metrics'].includes(input.kind)) return json({ error: 'invalid_kind' }, 400);
      await rpc('worker_schedule', { p_owner_user_id: owner, p_kind: input.kind });
    }
    const work = async () => {
      const outcomes = await dispatch(owner, false, new CollectionSession(owner), false, input.kind === undefined ? 'generic' : 'scoped');
      if (outcomes.some((value) => (value as { status?: string }).status === 'running')) wakeReconciliation(budget);
      return { outcomes };
    };
    const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
    if (runtime) {
      runtime.waitUntil(work().catch(() => console.error('[ReelRadar] Collection dispatch failed; durable maintenance will retry.')));
      return json({ accepted: true }, 202);
    }
    return json(await work());
  } catch (error) {
    if (error instanceof AccountDiagnosticsError) return json({ error: 'authoritative_usage_unavailable', stage: error.stage, upstreamStatus: error.upstreamStatus }, 503);
    return json({ error: 'dispatch_blocked_or_unavailable', hint: 'Check validated provider configuration, authoritative usage and durable job states. No automatic start retry.' }, 503);
  }
}
Deno.serve(handler);

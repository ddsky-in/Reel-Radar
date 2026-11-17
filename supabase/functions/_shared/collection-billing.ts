import type { Job } from './model.ts';
import { object } from './model.ts';
import { accountTokenName, liveMode, parseAccountUsage, parseRun, required, safeProviderId } from './providers.ts';
import { RecoveryReader } from './collection-recovery.ts';
import { CollectionSession, rpc, validUuid } from './worker.ts';
import { parseMonthlyBilling } from './monthly-billing.ts';

export interface BillingSyncResult {
  accounts: { accountSlot: number; enabled: boolean; success: boolean; syncedAt: string | null; error: 'usage_unverified' | 'usage_persistence_failed' | null; monthlyReportSyncedAt: string | null; monthlyReportError: 'monthly_report_unavailable' | null }[];
  runs: { checked: number; reconciled: number; unknown: number; failed: number };
  paidStarts: 0;
  syncedAt: string;
}
/** Explicit billing-only operator read. No dispatch/queue maintenance/abort/wake calls. */
export async function syncBillingOnly(owner: string): Promise<BillingSyncResult> {
  if (!validUuid(owner) || !liveMode()) throw new Error('Billing sync requires authorized live configuration');
  const deadline = Date.now() + 20000;
  const boundedRpc = <T = unknown>(name: string, args: Record<string, unknown>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.reject(new Error('Billing sync deadline reached'));
    return rpc<T>(name, args, Math.min(3000, remaining));
  };
  const session = new CollectionSession(owner), accounts = await session.accounts();
  const readers = new Map<number, RecoveryReader>();
  const results: BillingSyncResult['accounts'] = accounts.map(account => ({ accountSlot: account.account_slot,
    enabled: account.enabled, success: false, syncedAt: null, error: null, monthlyReportSyncedAt: null, monthlyReportError: null }));
  let index = 0;
  const syncAccount = async () => {
    while (index < accounts.length) {
      const position = index++, account = accounts[position], result = results[position];
      if (!account.enabled) continue;
      let observationId: string | null = null;
      try {
        if (!account.authorization_confirmed || !account.provider_user_id ||
            account.account_slot === 1 && account.provider_user_id !== required('APIFY_ACCOUNT_ID')) throw new Error('Unverified account');
        required(accountTokenName(account.account_slot));
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Billing sync deadline reached');
        const reader = new RecoveryReader({ accountSlot: account.account_slot, expectedProviderUserId: account.provider_user_id }, remaining, 3000);
        readers.set(account.account_slot, reader);
        const observation = object(await boundedRpc('worker_begin_account_usage', { p_owner_user_id: owner, p_account_slot: account.account_slot, p_provider_user_id: account.provider_user_id }));
        if (!validUuid(observation.observation_id) || typeof observation.observed_at !== 'string' || !Number.isFinite(Date.parse(observation.observed_at))) throw new Error('Usage checkpoint invalid');
        observationId = observation.observation_id;
        // read verifies /users/me once and returns that exact response for parsing.
        const me = await reader.identity(), limits = await reader.read('/users/me/limits');
        const usage = parseAccountUsage(me, limits, Date.now(), account.provider_user_id);
        result.error = 'usage_persistence_failed';
        const args = { p_owner_user_id: owner, p_provider_user_id: usage.userId, p_cycle_start_at: usage.cycleStart,
          p_cycle_end_at: usage.cycleEnd, p_usage_usd: usage.usageUsd, p_limit_usd: usage.limitUsd,
          p_observation_id: observationId, p_observed_at: observation.observed_at };
        await boundedRpc(account.account_slot === 1 ? 'worker_record_usage' : 'worker_record_account_usage',
          account.account_slot === 1 ? args : { ...args, p_account_slot: account.account_slot });
        result.success = true; result.syncedAt = new Date().toISOString(); result.error = null;
        // Monthly detail is independent of the limits observation. Failure must
        // not discard a valid limits read, or invent zero monthly usage.
        try {
          const monthly = parseMonthlyBilling(await reader.read('/users/me/usage/monthly'), usage.cycleStart, usage.cycleEnd);
          const saved = await boundedRpc('worker_record_monthly_billing_report', {
            p_owner_user_id: owner, p_account_slot: account.account_slot, p_provider_user_id: usage.userId,
            p_observation_id: observationId, p_observed_at: observation.observed_at,
            p_cycle_start_at: usage.cycleStart, p_cycle_end_at: usage.cycleEnd,
            p_before_discount_usd: monthly.beforeDiscountUsd, p_after_discount_usd: monthly.afterDiscountUsd, p_service_amounts: monthly.serviceAmounts,
          });
          if (saved !== true) throw new Error('Monthly report not accepted');
          result.monthlyReportSyncedAt = new Date().toISOString();
        } catch { result.monthlyReportError = 'monthly_report_unavailable'; }
      } catch {
        result.error ??= 'usage_unverified';
        if (observationId !== null) {
          try { await boundedRpc('worker_invalidate_account_usage', { p_owner_user_id: owner, p_account_slot: account.account_slot, p_observation_id: observationId }); }
          catch { /* Failed reads cannot invent a balance or invalidate newer observations. */ }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, accounts.length) }, syncAccount));
  let claims: { job: Job; reconciliation_token: string }[] = [];
  try { claims = await boundedRpc('worker_claim_billing_reconciliation', { p_owner_user_id: owner, p_job_id: null, p_limit: 10 }); }
  catch { /* Return partial per-account results; never call this a current balance. */ }
  if (!Array.isArray(claims) || claims.length > 10) throw new Error('Billing candidates unavailable');
  const counts = { checked: 0, reconciled: 0, unknown: 0, failed: 0 };
  for (const claim of claims) {
    const job = claim.job;
    try {
      if (!job || job.owner_user_id !== owner || !validUuid(job.id) || !job.live || !safeProviderId(job.actor_run_id) ||
          !['SUCCEEDED','FAILED','ABORTED','TIMED-OUT'].includes(job.provider_terminal_status ?? '')) throw new Error('Billing candidate scope invalid');
      counts.checked++;
      const account = accounts.find(account => account.account_slot === job.apify_account_slot && account.provider_user_id === job.expected_provider_user_id);
      if (!account?.provider_user_id || !account.authorization_confirmed) throw new Error('Billing run account unavailable');
      let reader = readers.get(account.account_slot);
      if (!reader) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Billing sync deadline reached');
        reader = new RecoveryReader({ accountSlot: account.account_slot, expectedProviderUserId: account.provider_user_id }, remaining, 3000);
        readers.set(account.account_slot, reader);
      }
      const run = parseRun(await reader.read(`/actor-runs/${encodeURIComponent(job.actor_run_id)}`));
      if (run.id !== job.actor_run_id || run.actorId !== job.expected_actor_id || run.userId !== job.expected_provider_user_id ||
          !['SUCCEEDED','FAILED','ABORTED','TIMED-OUT'].includes(run.status)) throw new Error('Billing run identity invalid');
      const stored = object(await boundedRpc('worker_reconcile_run_billing_only', { p_job_id: job.id, p_run_id: run.id, p_actor_id: run.actorId,
        p_provider_user_id: run.userId, p_status: run.status, p_dataset_id: run.defaultDatasetId, p_usage_total_usd: run.usageTotalUsd }));
      if (stored.billing_review_required === true || run.usageTotalUsd === null && stored.actual_cost_usd !== null) counts.failed++;
      else if (typeof stored.actual_cost_usd === 'number' && Number.isFinite(stored.actual_cost_usd) && stored.actual_cost_usd >= 0) counts.reconciled++;
      else counts.unknown++;
    } catch { counts.failed++; }
    // Billing claims own a separate bounded lease. Do not complete a generic
    // reconciliation claim here: that may generate a collection completion wake.
  }
  return { accounts: results, runs: counts, paidStarts: 0, syncedAt: new Date().toISOString() };
}

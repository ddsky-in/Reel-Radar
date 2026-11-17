import type { Job } from '../_shared/model.ts';
import { attachAcceptedRun, authenticate, body, CollectionMaintenanceError, CollectionSession, continuationBudget, dispatch, json, processJob, recordCompletionWake, rpc, validUuid, verifyRun, wakeReconciliation } from '../_shared/worker.ts';
import { isCarouselPilotJob, required } from '../_shared/providers.ts';
import { syncBillingOnly } from '../_shared/collection-billing.ts';
import { recoverJournalRun, recoverMissingRuns } from '../_shared/collection-recovery.ts';
type ReconciliationClaim = { job: Job; callback_hint: { run_id: string; dispatch_nonce: string } | null; reconciliation_token: string };
export async function handler(request: Request): Promise<Response> {
  if (!await authenticate(request)) return json({ error: 'unauthorized' }, 401);
  try {
    const input = await body(request);
    if (input.action === 'billing_sync') {
      if (input.continuation_budget !== 0 || Object.keys(input).some(key => !['action','continuation_budget'].includes(key))) return json({ error: 'invalid_billing_sync' }, 400);
      const billingOwner = required('REELRADAR_OWNER_USER_ID');
      if (!validUuid(billingOwner)) throw new Error('Owner setup invalid');
      // Deliberately synchronous and isolated: no ACK work chain, completion wake,
      // queue maintenance, expired-dispatch work, aborts or paid starts.
      return json({ sync: await syncBillingOnly(billingOwner) });
    }
    if (input.action !== undefined) return json({ error: 'invalid_action' }, 400);
    const budget = continuationBudget(input);
    const pilotInput = input.carousel_pilot_job_id;
    const settleInput = input.settle_job_id;
    const ordinaryInput = input.ordinary_callback_job_id;
    if (pilotInput !== undefined && (!validUuid(pilotInput) || !isCarouselPilotJob(pilotInput))) return json({ error: 'invalid_pilot_job' }, 400);
    if ([settleInput, ordinaryInput].some(value => value !== undefined && !validUuid(value)) ||
        [pilotInput, settleInput, ordinaryInput].filter(value => value !== undefined).length > 1) return json({ error: 'invalid_settlement_job' }, 400);
    const pilotId = validUuid(pilotInput) ? pilotInput : undefined;
    const settleId = validUuid(settleInput) ? settleInput : undefined;
    const ordinaryId = validUuid(ordinaryInput) ? ordinaryInput : undefined;
    const scopedId = pilotId ?? settleId ?? ordinaryId;
    const owner = required('REELRADAR_OWNER_USER_ID'); if (!validUuid(owner)) throw new Error('Owner setup invalid');
    // Explicit operator settlement is durably isolated BEFORE the asynchronous ACK.
    if (settleId) await rpc('worker_isolate_collection_settlement', { p_owner_user_id: owner, p_job_id: settleId });
    const session = new CollectionSession(owner);
    const work = async () => {
      // Targeted settlement must not mutate unrelated owner dispatch leases.
      if (!scopedId) await rpc('worker_expire_dispatches', { p_owner_user_id: owner });
      // Service RPC selects and stamps a fair, durable <=10 batch BEFORE any provider reads.
      const claims = await rpc<ReconciliationClaim[]>('worker_claim_reconciliation', {
        p_owner_user_id: owner, p_job_id: scopedId ?? null, p_kind: pilotId ? 'carousel' : null, p_limit: 10,
      });
      const outcomes: { job_id: string; state: string }[] = [];
      let billingPending = false;
      for (const claim of claims) {
        const job = claim.job;
        let callbackState: 'pending' | 'verified' | 'rejected' = 'pending';
        try {
          if (job.owner_user_id !== owner || scopedId && job.id !== scopedId || pilotId && job.kind !== 'carousel' ||
              ordinaryId && job.collection_source !== 'ordinary') throw new Error('Reconciliation scope mismatch');
          if (claim.callback_hint) {
            const hint = claim.callback_hint;
            // An unbound hint is not proof of a start or non-start. Read that exact run only.
            let run;
            try { run = await (await session.adapter(job)).run(hint.run_id); }
            catch (error) {
              if (error instanceof Error && error.message === 'Apify read failed (404)') {
                callbackState = 'rejected';
                outcomes.push({ job_id: job.id, state: 'callback_identity_rejected' });
                continue;
              }
              throw error;
            }
            if (hint.dispatch_nonce !== job.dispatch_nonce || run.id !== hint.run_id || run.actorId !== job.expected_actor_id ||
                run.userId !== job.expected_provider_user_id || job.actor_run_id && job.actor_run_id !== run.id) {
              callbackState = 'rejected';
              outcomes.push({ job_id: job.id, state: 'callback_identity_rejected' });
              continue;
            }
            await attachAcceptedRun(job, run, 'callback');
            job.actor_run_id = run.id;
            session.rememberRun(job, run);
            callbackState = 'verified';
          }
          if (!job.actor_run_id && !await recoverJournalRun(job, session)) { outcomes.push({ job_id: job.id, state: 'acceptance_unknown' }); continue; }
          const verified = await verifyRun(job, session);
          billingPending ||= verified.live && verified.actual_cost_usd === null && verified.provider_terminal_status !== null;
          const state = verified.status === 'processing' ? await processJob(job.id, session) : verified.status;
          if (job.collection_source === 'ordinary' && ['finished','succeeded','partial','failed'].includes(state)) await recordCompletionWake(owner, job.id);
          outcomes.push({ job_id: job.id, state });
        } catch { outcomes.push({ job_id: job.id, state: 'provider_or_processing_unavailable' }); }
        finally {
          try {
            await rpc('worker_complete_reconciliation', { p_owner_user_id: owner, p_job_id: job.id,
              p_reconciliation_token: claim.reconciliation_token, p_callback_run_id: claim.callback_hint?.run_id ?? null, p_callback_state: callbackState });
          } catch { /* A lost completion retains the stamped lease; durable maintenance retries later. */ }
        }
      }
      // Existing generic/scoped wakes perform only bounded GET recovery of missing
      // IDs. This helper neither starts work nor releases an unknown reservation.
      try { outcomes.push(...await recoverMissingRuns(owner, session, scopedId)); }
      catch { /* Fail closed on unavailable recovery claims. */ }
      const needsContinuation = billingPending || outcomes.some(value => ['running', 'continuation_required', 'processing_retry_required', 'provider_or_processing_unavailable'].includes(value.state));
      let next: unknown;
      if (scopedId && !ordinaryId) {
        await session.reconcileUsage();
        if (needsContinuation) wakeReconciliation(budget, pilotId, settleId);
        return { outcomes, next: pilotId ? 'pilot_only' : 'settlement_only' };
      }
      // Ordinary scoped retries retain their proven continuation permission;
      // finishing on a later callback wake can immediately dispatch the backlog.
      try {
        const ready = !ordinaryId || await recordCompletionWake(owner, ordinaryId);
        next = ready ? await dispatch(owner, false, session, Boolean(ordinaryId), ordinaryId ? 'none' : 'generic') : 'ordinary_callback_pending';
      } catch (error) {
        if (error instanceof CollectionMaintenanceError) throw error;
        next = 'dispatch_blocked_pending_authoritative_setup_or_usage';
      }
      const hasNext = Array.isArray(next) && next.some((value) => value.status === 'running');
      if (hasNext) wakeReconciliation(budget);
      else if (needsContinuation) wakeReconciliation(budget, undefined, undefined, ordinaryId);
      return { outcomes, next };
    };
    const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
    if (runtime) {
      runtime.waitUntil(work().catch(() => console.error('[ReelRadar] Collection reconciliation failed; durable maintenance will retry.')));
      return json({ accepted: true }, 202);
    }
    return json(await work());
  } catch { return json({ error: 'reconciliation_unavailable' }, 503); }
}
Deno.serve(handler);

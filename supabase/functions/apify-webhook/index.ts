import type { Job } from '../_shared/model.ts';
import { accountForJob, attachAcceptedRun, authenticate, body, CollectionSession, dispatch, json, processJob, recordCompletionWake, rows, rpc, validUuid, verifyRun, wakeReconciliation } from '../_shared/worker.ts';
import { env, isCarouselPilotJob, required } from '../_shared/providers.ts';
import { recoverJournalRun } from '../_shared/collection-recovery.ts';
export async function handler(request: Request): Promise<Response> {
  if (!await authenticate(request, true)) return json({ error: 'unauthorized' }, 401);
  try {
    const input = await body(request), url = new URL(request.url);
    const jobId = url.searchParams.get('job_id'), nonce = url.searchParams.get('dispatch_nonce');
    if (url.searchParams.getAll('job_id').length !== 1 || url.searchParams.getAll('dispatch_nonce').length !== 1 ||
        !validUuid(jobId) || !validUuid(nonce) || typeof input.run_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.run_id)) return json({ error: 'invalid_callback' }, 400);
    const owner = required('REELRADAR_OWNER_USER_ID');
    if (!validUuid(owner)) throw new Error('Owner setup invalid');
    const [job] = await rows<Job>('scrape_jobs', `id=eq.${jobId}&owner_user_id=eq.${encodeURIComponent(owner)}&limit=1`);
    if (!job || job.dispatch_nonce !== nonce || !job.live || !job.expected_actor_id ||
        !job.expected_provider_user_id || job.actor_run_id && job.actor_run_id !== input.run_id) return json({ error: 'unknown_callback' }, 403);
    const session = new CollectionSession(owner);
    try { await accountForJob(job, await session.accounts()); } catch { return json({ error: 'unknown_callback' }, 403); }
    // The callback supplies only a hint, not provider evidence. Commit it before ACK/waitUntil.
    const receipt = await rpc<{ accepted: boolean; reason?: string }>('worker_record_callback_receipt', {
      p_owner_user_id: owner, p_job_id: jobId, p_dispatch_nonce: nonce, p_run_id: input.run_id,
      p_actor_id: job.expected_actor_id, p_provider_user_id: job.expected_provider_user_id,
    });
    if (!receipt.accepted) return receipt.reason === 'callback_capacity_retry'
      ? json({ error: 'callback_retry_required' }, 503) : json({ error: 'unknown_callback' }, 403);
    const work = async () => {
      const [claim] = await rpc<{ job: Job; callback_hint: { run_id: string; dispatch_nonce: string } | null; reconciliation_token: string }[]>('worker_claim_reconciliation', {
        p_owner_user_id: owner, p_job_id: jobId, p_limit: 1,
      });
      if (!claim) return { accepted: true, processing: 'durably_queued', next: 'not_dispatched' };
      let callbackState: 'pending' | 'verified' | 'rejected' = 'pending';
      try {
        const selected = claim.job;
        if (selected.owner_user_id !== owner || selected.id !== jobId || selected.kind !== job.kind || !selected.live ||
            selected.dispatch_nonce !== nonce || selected.expected_actor_id !== job.expected_actor_id ||
            selected.expected_provider_user_id !== job.expected_provider_user_id || selected.apify_account_slot !== job.apify_account_slot) throw new Error('Callback reconciliation scope mismatch');
        if (claim.callback_hint) {
          const hint = claim.callback_hint;
          let run;
          try { run = await (await session.adapter(selected)).run(hint.run_id); }
          catch (error) {
            // A definitive missing hint is quarantined, never proof that the owned dispatch did not start.
            if (error instanceof Error && error.message === 'Apify read failed (404)') {
              callbackState = 'rejected';
              return { accepted: true, processing: 'callback_identity_rejected', next: 'not_dispatched' };
            }
            throw error;
          }
          if (hint.dispatch_nonce !== selected.dispatch_nonce || run.id !== hint.run_id || run.actorId !== selected.expected_actor_id ||
              run.userId !== selected.expected_provider_user_id || selected.actor_run_id && selected.actor_run_id !== run.id) {
            callbackState = 'rejected';
            return { accepted: true, processing: 'callback_identity_rejected', next: 'not_dispatched' };
          }
          await attachAcceptedRun(selected, run, 'callback');
          selected.actor_run_id = run.id;
          session.rememberRun(selected, run);
          callbackState = 'verified';
        }
        if (!selected.actor_run_id && !await recoverJournalRun(selected, session)) return { accepted: true, processing: 'acceptance_unknown', next: 'not_dispatched' };
        const verified = await verifyRun(selected, session);
        const processing = verified.status === 'processing' ? await processJob(selected.id, session) : verified.status;
        const media = await rpc<{ status: string }>('worker_transcription_media_reconcile', { p_job_id: selected.id });
        const mediaRefresh = media.status !== 'not_linked' || selected.collection_source === 'target_media';
        // Database provenance survives pilot env removal and generic maintenance.
        const carouselPilot = selected.collection_source === 'carousel_pilot' || selected.kind === 'carousel' &&
          (isCarouselPilotJob(selected.id) || env('CAROUSEL_PROVIDER_VALIDATED') !== 'true');
        const ordinary = selected.collection_source === 'ordinary' && !mediaRefresh && !carouselPilot;
        let next: unknown = carouselPilot ? 'pilot_only' : mediaRefresh ? 'transcription_media_reconciled' : 'not_dispatched';
        if (ordinary && ['finished','succeeded','partial','failed'].includes(processing) && await recordCompletionWake(owner, selected.id)) {
          try { next = await dispatch(owner, false, session, true); } catch { next = 'live_setup_or_usage_blocked'; }
        }
        const billingPending = verified.live && verified.actual_cost_usd === null && verified.provider_terminal_status !== null;
        const retry = billingPending || ['running','continuation_required','processing_retry_required'].includes(processing);
        const hasNext = Array.isArray(next) && next.some((value) => value.status === 'running');
        if (hasNext) wakeReconciliation(4);
        else if (retry) {
          if (ordinary) wakeReconciliation(4, undefined, undefined, selected.id);
          else wakeReconciliation(4, carouselPilot && isCarouselPilotJob(selected.id) ? selected.id : undefined,
            carouselPilot && isCarouselPilotJob(selected.id) ? undefined : selected.id);
        }
        return { accepted: true, processing, next };
      } finally {
        await rpc('worker_complete_reconciliation', { p_owner_user_id: owner, p_job_id: claim.job.id,
          p_reconciliation_token: claim.reconciliation_token, p_callback_run_id: claim.callback_hint?.run_id ?? null, p_callback_state: callbackState });
      }
    };
    const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
    if (runtime) {
      runtime.waitUntil(work().catch(() => console.error('[ReelRadar] Durable callback processing deferred to maintenance.')));
      return json({ accepted: true }, 202);
    }
    return json(await work());
  } catch { return json({ error: 'verification_or_processing_failed' }, 503); }
}
Deno.serve(handler);

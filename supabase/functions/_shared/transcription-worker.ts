import { boundedBytes, constantEqual, decodeJson, hmacHex, MAX_CALLBACK_BYTES, MAX_DURATION_SECONDS, normalizeEvent, normalizeTranscript, signatureParts, TRANSCRIPTION_MODEL, uuid, verifyWebhook } from './transcription-model.ts';
import type { TranscriptAttempt, TranscriptConfig, TranscriptJob, TranscriptResult, ValidatedTranscriptMedia } from './transcription-model.ts';
import { transcriptionBody, transcriptionEnv, transcriptionJson, transcriptionRequired, transcriptionRpc } from './transcription-db.ts';
import { prepareTranscription, retrieveTranscript, transcriptionAccountDiagnostics, transcriptionCanDispatch, TranscriptionSubmissionError } from './transcription-provider.ts';
import type { Submission } from './transcription-provider.ts';
import { maintainTranscriptMedia, probeTranscriptMedia, refreshTranscriptMedia } from './transcription-media.ts';
import { resolveWebhookCredentials, setupTranscriptionWebhook } from './transcription-setup.ts';

let mediaSlot = Promise.resolve();
async function withMediaSlot<T>(work: () => Promise<T>): Promise<T> {
  const previous = mediaSlot;
  let release!: () => void;
  mediaSlot = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await work(); } finally { release(); }
}

export async function maintenanceSecret(): Promise<string> {
  return await hmacHex(transcriptionRequired('INTERNAL_CRON_SECRET'), new TextEncoder().encode('reelradar:transcription:maintenance:v1'));
}
export async function authenticateTranscriptionInternal(request: Request): Promise<'base' | 'maintenance' | null> {
  if (request.method !== 'POST') return null;
  const supplied = request.headers.get('x-internal-secret') ?? '', base = transcriptionEnv('INTERNAL_CRON_SECRET');
  if (!base || !supplied || supplied.length > 4096) return null;
  if (await constantEqual(supplied, base)) return 'base';
  return await constantEqual(supplied, await maintenanceSecret()) ? 'maintenance' : null;
}
export async function dispatchTranscripts(): Promise<unknown[]> {
  const config = await transcriptionRpc<TranscriptConfig>('worker_transcription_config');
  if (!config.enabled || config.paused || !config.key_validated || !config.contract_validated || transcriptionEnv('TRANSCRIPTION_ENABLED') !== 'true' || transcriptionEnv('TRANSCRIPTION_PROVIDER_VALIDATED') !== 'true' || !transcriptionEnv('ELEVENLABS_API_KEY') || transcriptionEnv('PROVIDER_MODE') === 'mock') return [{ status: 'disabled' }];
  const webhook = await resolveWebhookCredentials();
  if (!transcriptionCanDispatch(config, webhook)) return [{ status: 'disabled' }];
  const limit = config.phase === 'automatic' && Number.isInteger(config.concurrency) && config.concurrency! >= 2 ? 2 : 1;
  // The transactional claim reserves budget and fences the whole bounded batch BEFORE
  // media or paid work. The database also enforces concurrency across invocations.
  const claim = await transcriptionRpc<{ jobs: TranscriptJob[]; reason?: string }>('worker_transcription_claim', { p_limit: limit });
  if (!Array.isArray(claim.jobs) || claim.jobs.length > limit) throw new Error('Invalid transcription claim');
  // Database concurrency can span runtimes. Within one isolate, serialize the
  // full download/upload lifetime, including overlapping HTTP invocations.
  const batch = await Promise.allSettled(claim.jobs.map(job => withMediaSlot(async () => {
    let media: ValidatedTranscriptMedia;
    let submit: () => Promise<Submission>;
    try {
      media = await probeTranscriptMedia(job);
      submit = await prepareTranscription(job, media.source_url, webhook!, media);
    }
    catch {
      await transcriptionRpc('worker_transcription_fail', { p_attempt_id: job.attempt_id, p_lease_token: job.lease_token, p_status: 'media_unavailable', p_error_message: 'Bounded media accessibility or container-duration check failed' });
      return { job_id: job.id, status: 'media_unavailable' };
    }
    // Persist the candidate that actually passed audio validation, so playback
    // and downloads use it too instead of returning to a silent primary variant.
    await transcriptionRpc('worker_transcription_select_media', { p_attempt_id: job.attempt_id, p_lease_token: job.lease_token, p_source_url: media.source_url });
    // Explicit denial is the only proof authorizing a not-started hold release.
    // Timeout/malformed gate responses are not proof; retain the hold and do no POST.
    const gate = await transcriptionRpc<{ allow: boolean; reason?: string }>('worker_transcription_before_submit', { p_attempt_id: job.attempt_id, p_lease_token: job.lease_token });
    if (gate.allow === false) {
      await transcriptionRpc('worker_transcription_cancel_not_started', { p_attempt_id: job.attempt_id, p_lease_token: job.lease_token });
      return { job_id: job.id, status: 'not_started' };
    }
    if (gate.allow !== true) throw new Error('Submission gate unavailable');
    try {
      const submission = await submit();
      await transcriptionRpc('worker_transcription_attach', { p_attempt_id: job.attempt_id, p_lease_token: job.lease_token, p_provider_job_id: submission.request_id, p_provider_transcription_id: submission.transcription_id });
      return { job_id: job.id, status: 'submitted' };
    } catch (error) {
      const reason = error instanceof TranscriptionSubmissionError ? error.reason : 'submission_or_attachment';
      const status = error instanceof TranscriptionSubmissionError ? error.status : null;
      // Stable diagnostics only: never log credentials, URLs, provider bodies or media.
      console.warn(JSON.stringify({ event: 'transcription_submission_uncertain', attempt_id: job.attempt_id, reason, http_status: status }));
      await transcriptionRpc('worker_transcription_fail', { p_attempt_id: job.attempt_id, p_lease_token: job.lease_token, p_status: 'uncertain', p_error_message: `Submission acceptance uncertain (${reason}${status === null ? '' : ` ${status}`}); hold retained without automatic resubmission` });
      return { job_id: job.id, status: 'uncertain' };
    }
  })));
  // Isolate each attempt: an unavailable gate/settlement retains that hold while its
  // independently gated sibling can finish. No raw transport errors reach responses.
  const outcomes = await Promise.all(batch.map(async (outcome, index) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    const job = claim.jobs[index];
    try {
      // The DB checks the paid fence under the same lock as before_submit.
      // A transport error alone is never permission to release a reservation.
      const result = await transcriptionRpc<{ released: boolean }>('worker_transcription_release_unsubmitted', { p_attempt_id: job.attempt_id, p_lease_token: job.lease_token });
      if (result.released === true) return { job_id: job.id, status: 'not_started' };
    } catch { /* Retain the hold; expired pre-submit work is recovered by claim. */ }
    return { job_id: job.id, status: 'unresolved' };
  }));
  return outcomes.length ? outcomes : [{ status: claim.reason ?? 'idle' }];
}
async function complete(attempt: TranscriptAttempt, result: TranscriptResult): Promise<unknown> {
  return await transcriptionRpc('worker_transcription_complete', { p_attempt_id: attempt.attempt_id, p_lease_token: attempt.lease_token,
    p_text: result.text, p_language: result.language, p_segments: result.segments, p_no_speech: result.no_speech });
}
export async function reconcileTranscripts(): Promise<unknown[]> {
  if (!transcriptionEnv('ELEVENLABS_API_KEY') || transcriptionEnv('TRANSCRIPTION_PROVIDER_VALIDATED') !== 'true' || transcriptionEnv('PROVIDER_MODE') === 'mock') return [{ status: 'reconciliation_unavailable' }];
  const candidates = await transcriptionRpc<{ jobs: TranscriptAttempt[] }>('worker_transcription_candidates', { p_limit: 2 });
  if (!Array.isArray(candidates.jobs) || candidates.jobs.length > 2) throw new Error('Invalid transcription candidates');
  const outcomes: unknown[] = [];
  for (const candidate of candidates.jobs) {
    if (!uuid(candidate.attempt_id)) continue;
    const { job } = await transcriptionRpc<{ job: TranscriptAttempt | null }>('worker_transcription_callback_context', { p_attempt_id: candidate.attempt_id });
    if (!job || job.id !== candidate.id || job.attempt_id !== candidate.attempt_id || job.lease_token !== candidate.lease_token || job.model !== TRANSCRIPTION_MODEL || !job.provider_transcription_id) {
      outcomes.push({ job_id: candidate.id, status: 'unresolved' }); continue;
    }
    try {
      const result = await retrieveTranscript(job.provider_transcription_id, Math.min(job.max_duration_seconds, MAX_DURATION_SECONDS));
      await complete(job, result); outcomes.push({ job_id: job.id, status: result.no_speech ? 'no_speech' : 'completed' });
    } catch { outcomes.push({ job_id: job.id, status: 'unresolved' }); }
    // No billing guessed from duration, no 404-to-not_started conversion, no POST retry.
  }
  return outcomes;
}
export async function transcriptionWebhookHandler(request: Request): Promise<Response> {
  const header = request.headers.get('elevenlabs-signature');
  const length = request.headers.get('content-length');
  if (request.method !== 'POST' || !signatureParts(header) || length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_CALLBACK_BYTES)) return transcriptionJson({ error: 'unauthorized' }, 401);
  let bytes: Uint8Array;
  try { bytes = await boundedBytes(request.body, MAX_CALLBACK_BYTES, AbortSignal.timeout(5000)); }
  catch { return transcriptionJson({ error: 'unauthorized' }, 401); }
  let secret: string;
  try { secret = (await resolveWebhookCredentials())?.secret ?? ''; }
  catch { return transcriptionJson({ error: 'transcription_callback_unavailable' }, 503); }
  if (!secret || !await verifyWebhook(bytes, header, secret)) return transcriptionJson({ error: 'unauthorized' }, 401);
  // Only trusted service configuration lookup may precede HMAC. Exact-byte verification
  // precedes JSON parsing, business database access, writes and all provider work.
  try {
    const event = normalizeEvent(decodeJson(bytes));
    const { job } = await transcriptionRpc<{ job: TranscriptAttempt | null }>('worker_transcription_callback_context', { p_attempt_id: event.metadata.attempt_id });
    if (!job || job.id !== event.metadata.job_id || job.attempt_id !== event.metadata.attempt_id ||
        !await constantEqual(job.lease_token, event.metadata.nonce) || job.model !== TRANSCRIPTION_MODEL ||
        job.provider_job_id !== null && job.provider_job_id !== event.request_id) return transcriptionJson({ error: 'identity_mismatch' }, 409);
    const result = event.failed ? null : normalizeTranscript(event.transcription, Math.min(job.max_duration_seconds, MAX_DURATION_SECONDS));
    if (result?.transcription_id && job.provider_transcription_id && result.transcription_id !== job.provider_transcription_id) return transcriptionJson({ error: 'identity_mismatch' }, 409);
    // A signed early callback can recover a timed-out POST using its fenced nonce.
    await transcriptionRpc('worker_transcription_attach', { p_attempt_id: job.attempt_id, p_lease_token: job.lease_token,
      p_provider_job_id: event.request_id, p_provider_transcription_id: result?.transcription_id ?? job.provider_transcription_id ?? null });
    if (result) await complete(job, result);
    else await transcriptionRpc('worker_transcription_provider_failure', { p_attempt_id: job.attempt_id, p_lease_token: job.lease_token, p_provider_job_id: event.request_id });
    // DB idempotence/fencing rejects stale attempts and makes replay harmless across runtimes.
    return transcriptionJson({ accepted: true });
  } catch { return transcriptionJson({ error: 'transcription_callback_unavailable' }, 503); }
}
async function diagnostics(config: TranscriptConfig): Promise<Record<string, unknown>> {
  const webhook = await resolveWebhookCredentials();
  return { key_configured: Boolean(transcriptionEnv('ELEVENLABS_API_KEY')), webhook_id_configured: Boolean(webhook),
    webhook_secret_configured: Boolean(webhook), environment_enabled: transcriptionEnv('TRANSCRIPTION_ENABLED') === 'true',
    provider_validated: transcriptionEnv('TRANSCRIPTION_PROVIDER_VALIDATED') === 'true', enabled: config.enabled === true, paused: config.paused === true,
    key_validated: config.key_validated === true, contract_validated: config.contract_validated === true, phase: ['pilot', 'automatic'].includes(config.phase) ? config.phase : 'unknown',
    can_dispatch: transcriptionCanDispatch(config, webhook), model: TRANSCRIPTION_MODEL, max_concurrency: 2, actual_cost_basis: 'unknown_until_authoritative_reconciliation' };
}
export async function transcriptionInternalHandler(request: Request, reconcile = false): Promise<Response> {
  const authentication = await authenticateTranscriptionInternal(request);
  if (!authentication) return transcriptionJson({ error: 'unauthorized' }, 401);
  try {
    const input = await transcriptionBody(request), action = input.action ?? (reconcile ? 'reconcile' : 'dispatch');
    if (!['dispatch', 'reconcile', 'maintenance', 'diagnostics', 'configure', 'install_schedule', 'setup_webhook', 'account_diagnostics', 'enable_pilot', 'media_refresh', 'source_refresh', 'verify_pilot', 'enable_automatic'].includes(String(action))) return transcriptionJson({ error: 'invalid_action' }, 400);
    if (['account_diagnostics', 'enable_pilot', 'media_refresh', 'source_refresh', 'verify_pilot', 'enable_automatic'].includes(String(action))) {
      if (authentication !== 'base') return transcriptionJson({ error: 'unauthorized' }, 401);
      if (action === 'account_diagnostics') return transcriptionJson({ diagnostics: await transcriptionAccountDiagnostics() });
      if (action === 'verify_pilot') {
        const result = await transcriptionRpc<{ verified: boolean }>('worker_transcription_verify_pilot');
        return transcriptionJson({ verified: result.verified === true, reason: result.verified === true ? null : 'pilot_evidence_incomplete' });
      }
      if (action === 'media_refresh' || action === 'source_refresh') {
        if (!uuid(input.creator_id)) return transcriptionJson({ error: 'invalid_creator_id' }, 400);
        return transcriptionJson(await refreshTranscriptMedia(input.creator_id, false, action === 'source_refresh'));
      }
      // An operator activation never writes environment flags, submits media, or starts STT.
      if (transcriptionEnv('TRANSCRIPTION_ENABLED') !== 'true' || transcriptionEnv('TRANSCRIPTION_PROVIDER_VALIDATED') !== 'true' ||
          !transcriptionEnv('ELEVENLABS_API_KEY') || transcriptionEnv('PROVIDER_MODE') === 'mock' || !await resolveWebhookCredentials()) return transcriptionJson({ error: 'configuration_unvalidated' }, 503);
      const account = await transcriptionAccountDiagnostics();
      if (!account.usable) return transcriptionJson({ error: 'account_or_pricing_unvalidated', diagnostics: account }, 409);
      await transcriptionRpc('worker_transcription_validate_account', { p_rate_usd_per_hour: account.price.rate_usd_per_hour, p_max_item_usd: account.price.max_item_reservation_usd });
      const phase = action === 'enable_automatic' ? 'automatic' : 'pilot';
      if (phase === 'pilot') await transcriptionRpc('worker_transcription_configure', { p_key_validated: true, p_enabled: false, p_phase: 'pilot', p_contract_validated: true });
      const activated = await transcriptionRpc<TranscriptConfig>('worker_transcription_activate', { p_phase: phase });
      return transcriptionJson({ activated: activated.enabled === true && activated.paused === false && activated.phase === phase, phase,
        pilot_limit_usd: activated.pilot_limit_usd ?? .25, monthly_budget_usd: activated.monthly_budget_usd ?? null,
        max_item_reservation_usd: .08, actual_cost_basis: 'unknown_until_authoritative_reconciliation' });
    }
    if (action === 'setup_webhook') {
      if (authentication !== 'base') return transcriptionJson({ error: 'unauthorized' }, 401);
      const result = await setupTranscriptionWebhook();
      return transcriptionJson(result, result.configured ? 200 : result.status === 'unauthorized' || result.status === 'missing_permission' ? 403 : ['uncertain', 'recovery_required', 'busy'].includes(result.status) ? 409 : 503);
    }
    if (action === 'diagnostics') {
      if (authentication !== 'base') return transcriptionJson({ error: 'unauthorized' }, 401);
      return transcriptionJson({ diagnostics: await diagnostics(await transcriptionRpc<TranscriptConfig>('worker_transcription_config')) });
    }
    if (action === 'install_schedule') {
      if (authentication !== 'base') return transcriptionJson({ error: 'unauthorized' }, 401);
      await transcriptionRpc('worker_transcription_install_schedule', { p_secret: await maintenanceSecret() });
      return transcriptionJson({ installed: true });
    }
    if (action === 'configure') {
      if (authentication !== 'base') return transcriptionJson({ error: 'unauthorized' }, 401);
      if (typeof input.enabled !== 'boolean' || input.phase !== undefined && !['pilot', 'automatic'].includes(String(input.phase))) return transcriptionJson({ error: 'invalid_configuration' }, 400);
      const validated = transcriptionEnv('TRANSCRIPTION_PROVIDER_VALIDATED') === 'true';
      if (input.enabled) return transcriptionJson({ error: 'use_activation_action' }, 400);
      await transcriptionRpc('worker_transcription_configure', { p_key_validated: Boolean(transcriptionEnv('ELEVENLABS_API_KEY')) && validated,
        p_enabled: input.enabled, p_phase: input.phase ?? 'pilot', p_contract_validated: validated });
      return transcriptionJson({ configured: true });
    }
    if (authentication === 'maintenance' && action !== 'maintenance' && action !== 'reconcile' && action !== 'dispatch') return transcriptionJson({ error: 'unauthorized' }, 401);
    const media = action === 'maintenance' || action === 'reconcile' ? await maintainTranscriptMedia(action === 'maintenance') : [];
    const reconciled = action === 'maintenance' || action === 'reconcile' ? await reconcileTranscripts() : [];
    const dispatched = action === 'maintenance' || action === 'dispatch' ? await dispatchTranscripts() : [];
    return transcriptionJson({ media, reconciled, dispatched });
  } catch { return transcriptionJson({ error: 'transcription_blocked_or_unavailable' }, 503); }
}

import { mp4Duration } from './mp4.ts';
export { mp4Duration } from './mp4.ts';
import { instagramMediaUrl } from './model.ts';
import { boundedBytes, MediaBodyLimitError, MAX_DURATION_SECONDS, MAX_MEDIA_BYTES, TRANSCRIPTION_MODEL, uuid } from './transcription-model.ts';
import type { TranscriptJob, ValidatedTranscriptMedia } from './transcription-model.ts';
import type { Context, Job } from './model.ts';
import { ApifyReels, liveMode, required, validateDispatchSetup } from './providers.ts';
import { processJob, reconcileUsage, rows, submitCollectionClaim, verifyRun } from './worker.ts';
import { transcriptionEnv, transcriptionRpc } from './transcription-db.ts';

export function mediaCandidates(job: TranscriptJob): string[] {
  const values: unknown[] = [job.source_url, ...(Array.isArray(job.candidates) ? job.candidates.slice(0, 10) : [])];
  return [...new Set(values.map(instagramMediaUrl).filter((url): url is string => url !== null))].slice(0, 3);
}

export async function probeTranscriptMedia(job: TranscriptJob): Promise<ValidatedTranscriptMedia> {
  if (!uuid(job.id) || !uuid(job.attempt_id) || !uuid(job.lease_token) || job.model !== TRANSCRIPTION_MODEL || job.options_version !== 1 ||
      !Number.isFinite(job.duration_seconds) || Number(job.duration_seconds) <= 0 || Number(job.duration_seconds) > MAX_DURATION_SECONDS ||
      !Number.isFinite(job.max_duration_seconds) || job.max_duration_seconds <= 0 || job.max_duration_seconds > MAX_DURATION_SECONDS ||
      !Number.isSafeInteger(job.max_media_bytes) || job.max_media_bytes <= 0 || job.max_media_bytes > MAX_MEDIA_BYTES ||
      !Number.isFinite(job.reservation_usd) || job.reservation_usd < .08) throw new Error('Media unavailable');
  // GETs can be retried before the paid submission fence. Keep a single bounded
  // deadline across candidates; permanent failures never repeat the same URL.
  const deadline = AbortSignal.timeout(60000);
  for (const source_url of mediaCandidates(job)) for (let attempt = 0; attempt < 2 && !deadline.aborted; attempt++) {
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(25000)]);
    try {
      const response = await fetch(source_url, { method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit', signal });
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase(), declared = response.headers.get('content-length');
      if ([408, 429, 500, 502, 503, 504].includes(response.status) && attempt === 0) {
        await response.body?.cancel(); continue;
      }
      if (!response.ok || response.redirected || response.url && response.url !== source_url || !['video/mp4', 'audio/mp4', 'application/octet-stream'].includes(type ?? '') ||
          declared !== null && (!/^\d+$/.test(declared) || Number(declared) > job.max_media_bytes)) {
        await response.body?.cancel(); break;
      }
      const bytes = await boundedBytes(response.body, job.max_media_bytes, signal);
      try {
        const duration_seconds = mp4Duration(bytes);
        if (duration_seconds > job.max_duration_seconds || Math.abs(duration_seconds - Number(job.duration_seconds)) > Math.max(1, duration_seconds * .05)) break;
        return { source_url, bytes, content_type: 'video/mp4', duration_seconds };
      } catch { break; } // Complete but invalid/silent/oversized containers need another candidate.
    } catch (error) {
      // A network/body interruption is repeatable. A byte-limit failure is permanent.
      if (deadline.aborted || error instanceof MediaBodyLimitError) break;
    }
  }
  throw new Error('Media unavailable');
}

interface LinkedMediaJob { id: string; status: string; actor_run_id: string | null; creator_id: string }
interface MediaEnqueue { job_id: string | null; refresh_id: string | null; target_count: number; reason?: string | null }
function canStartMedia(): boolean {
  return transcriptionEnv('TRANSCRIPTION_ENABLED') === 'true' && transcriptionEnv('TRANSCRIPTION_PROVIDER_VALIDATED') === 'true' && Boolean(transcriptionEnv('ELEVENLABS_API_KEY')) && transcriptionEnv('PROVIDER_MODE') === 'apify';
}
export async function dispatchMediaJob(jobId: string): Promise<{ job_id: string; status: string }> {
  if (!uuid(jobId)) throw new Error('Invalid media job');
  if (!canStartMedia()) return { job_id: jobId, status: 'disabled' };
  validateDispatchSetup();
  if (!liveMode()) throw new Error('Media recovery requires live policy');
  const owner = required('REELRADAR_OWNER_USER_ID');
  if (!uuid(owner)) throw new Error('Media owner unavailable');
  // Record authoritative account usage before the exact DB claim; no generic dispatch.
  await reconcileUsage(owner);
  const adapter = new ApifyReels();
  const claim = await transcriptionRpc<Context & { max_total_charge_usd: number; reason?: string }>('worker_transcription_media_claim', { p_job_id: jobId, p_actor_id: adapter.actorId });
  if (!claim.job) return { job_id: jobId, status: claim.reason ?? 'not_claimable' };
  const cap = Number(claim.max_total_charge_usd);
  if (claim.job.id !== jobId || claim.job.owner_user_id !== owner || !claim.job.live || claim.job.kind !== 'manual' || claim.job.results_limit !== 100 ||
      claim.job.collection_source !== 'target_media' || !uuid(claim.job.dispatch_nonce) || claim.creators.length !== 1 || !uuid(claim.creators[0].id) || !Number.isFinite(cap) || cap <= 0 || cap > 10000 ||
      cap !== Number(claim.job.reserved_usd)) throw new Error('Invalid targeted media claim');
  return submitCollectionClaim(claim, cap, 'target_media');
}
export async function refreshTranscriptMedia(creatorId: string, automatic = false, sourceRepair = false): Promise<Record<string, unknown>> {
  if (!uuid(creatorId)) throw new Error('Invalid media creator');
  if (automatic && sourceRepair) throw new Error('Source repair requires an operator');
  if (!canStartMedia()) return { status: 'disabled' };
  validateDispatchSetup();
  const owner = required('REELRADAR_OWNER_USER_ID');
  if (!uuid(owner) || !liveMode()) throw new Error('Media owner unavailable');
  // Resolve only an existing active authorized creator; no user-supplied profile strings.
  const memberships = await rows<{ creators: { id: string; username: string }; workspaces: { owner_user_id: string } }>('workspace_creators',
    `select=creators!inner(id,username),workspaces!inner(owner_user_id,archived_at)&creator_id=eq.${encodeURIComponent(creatorId)}&active=eq.true&workspaces.owner_user_id=eq.${encodeURIComponent(owner)}&workspaces.archived_at=is.null&limit=1`);
  const member = memberships[0];
  const config = await transcriptionRpc<{ phase: string }>('worker_transcription_config');
  if (automatic && config.phase !== 'automatic') throw new Error('Automatic media recovery disabled');
  if (!member || member.creators.id !== creatorId || member.workspaces.owner_user_id !== owner ||
      !automatic && !sourceRepair && (creatorId !== '0e4e0fb0-4b78-483c-b9a2-d95051838726' || member.creators.username !== 'harshpanwar.ai')) throw new Error('Media creator not authorized');
  const queued = await transcriptionRpc<MediaEnqueue>(sourceRepair ? 'worker_transcription_source_refresh_enqueue' : 'worker_transcription_media_enqueue', { p_creator_id: creatorId });
  if (!queued.job_id) return { status: queued.reason ?? 'not_queued', target_count: 0 };
  if (!uuid(queued.job_id) || !uuid(queued.refresh_id) || !Number.isSafeInteger(queued.target_count) || queued.target_count < 1 || queued.target_count > 100) throw new Error('Invalid media enqueue');
  const outcome = await dispatchMediaJob(queued.job_id);
  return { ...outcome, refresh_id: queued.refresh_id, target_count: queued.target_count };
}
export async function maintainTranscriptMedia(recover: boolean): Promise<unknown[]> {
  if (transcriptionEnv('PROVIDER_MODE') !== 'apify') return [];
  const result = await transcriptionRpc<{ jobs: LinkedMediaJob[] }>('worker_transcription_media_jobs');
  if (!Array.isArray(result.jobs) || result.jobs.length > 4) throw new Error('Invalid media candidates');
  const outcomes: unknown[] = []; let started = false;
  // Reconcile at most two exact linked jobs. Do not advance unrelated pending scraping.
  for (const candidate of result.jobs.slice(0, 2)) {
    if (!uuid(candidate.id) || !uuid(candidate.creator_id)) throw new Error('Invalid linked media job');
    let status = candidate.status;
    if (candidate.actor_run_id) {
      try {
        const owner = required('REELRADAR_OWNER_USER_ID');
        const [job] = await rows<Job>('scrape_jobs', `id=eq.${encodeURIComponent(candidate.id)}&owner_user_id=eq.${encodeURIComponent(owner)}&limit=1`);
        if (!job || job.id !== candidate.id || job.actor_run_id !== candidate.actor_run_id || !job.live || job.kind !== 'manual' || job.results_limit !== 100) throw new Error('Linked media identity unavailable');
        const verified = await verifyRun(job);
        status = verified.status;
        if (status === 'processing' && verified.provider_terminal_status !== null) status = await processJob(job.id);
        const settled = await transcriptionRpc<{ status: string; actual_cost_known: boolean }>('worker_transcription_media_reconcile', { p_job_id: candidate.id });
        outcomes.push({ job_id: candidate.id, status: settled.status ?? status, actual_cost_known: settled.actual_cost_known === true });
      } catch { outcomes.push({ job_id: candidate.id, status: 'unresolved' }); }
    } else outcomes.push({ job_id: candidate.id, status });
  }
  if (recover && canStartMedia()) {
    const pending = result.jobs.find(job => !job.actor_run_id && ['pending', 'budget_paused'].includes(job.status));
    if (pending) { outcomes.push(await dispatchMediaJob(pending.id)); started = true; }
    // Durable candidate exclusion prevents a status-only paid refresh loop after settlement.
    if (!started && result.jobs.length === 0) {
      const config = await transcriptionRpc<{ phase: string }>('worker_transcription_config');
      if (config.phase !== 'automatic') return outcomes;
      const candidates = await transcriptionRpc<{ creators: { creator_id: string; username: string }[] }>('worker_transcription_media_candidates', { p_limit: 1 });
      if (!Array.isArray(candidates.creators) || candidates.creators.length > 1) throw new Error('Invalid media recovery candidates');
      const creator = candidates.creators[0];
      if (creator && uuid(creator.creator_id) && /^[a-z0-9._]{1,30}$/.test(creator.username)) outcomes.push(await refreshTranscriptMedia(creator.creator_id, true));
    }
  }
  return outcomes;
}

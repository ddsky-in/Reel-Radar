import type { ApifyAccountContext, Job, Run } from './model.ts';
import { object, zonedTimestamp } from './model.ts';
import { accountTokenName, freezeAccount, parseRun, required, safeProviderId } from './providers.ts';
import { accountForJob, attachAcceptedRun, collectionRecoveryState, CollectionSession, rpc, validUuid } from './worker.ts';

const ORIGIN = 'https://api.apify.com';
const MAX_BYTES = 1024 * 1024;
const MAX_CALLS = 16;
const MAX_PAGES = 3;
const PAGE_SIZE = 50;
const EVENTS = ['ACTOR.RUN.CREATED','ACTOR.RUN.SUCCEEDED','ACTOR.RUN.FAILED','ACTOR.RUN.ABORTED','ACTOR.RUN.TIMED_OUT'];
export interface RecoveryCursor { mode: 'webhooks' | 'receipts'; offset: number }
export interface RecoveryResult {
  outcome: 'no_match' | 'exhausted' | 'matched'; cursor: RecoveryCursor | null; pagesUsed: number;
  run?: Run;
}
export class RecoveryReadError extends Error {
  constructor(readonly reason: 'read_unavailable' | 'response_limit' | 'metadata_invalid' | 'budget_exhausted') { super('Bounded provider recovery unavailable'); }
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (!response.body || declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
    await response.body?.cancel(); throw new RecoveryReadError('response_limit');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  const interrupted = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', interrupted, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new RecoveryReadError('read_unavailable');
      const part = await reader.read(); if (part.done) break;
      length += part.value.length;
      if (length > MAX_BYTES) { await reader.cancel(); throw new RecoveryReadError('response_limit'); }
      chunks.push(part.value);
    }
    if (signal.aborted) throw new RecoveryReadError('read_unavailable');
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new RecoveryReadError('metadata_invalid'); }
  } finally { signal.removeEventListener('abort', interrupted); reader.releaseLock(); }
}
/** Extracted from the prior audit. All requests are fixed-origin GETs without redirects. */
export class RecoveryReader {
  private verified?: Promise<void>;
  private identityResult?: Promise<unknown>;
  private calls = 0;
  private readonly token: string;
  readonly account: ApifyAccountContext;
  private readonly deadline: number;
  constructor(account: ApifyAccountContext, maximumDurationMs = 45000, private readonly perCallMs = 10000) {
    this.account = freezeAccount(account); this.token = required(accountTokenName(this.account.accountSlot));
    if (!Number.isSafeInteger(maximumDurationMs) || maximumDurationMs < 1 || maximumDurationMs > 45000 || !Number.isSafeInteger(perCallMs) || perCallMs < 1 || perCallMs > 10000) throw new RecoveryReadError('budget_exhausted');
    this.deadline = Date.now() + maximumDurationMs;
  }
  private async get(path: string): Promise<unknown> {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('://') || ++this.calls > MAX_CALLS || Date.now() >= this.deadline) throw new RecoveryReadError('budget_exhausted');
    const url = `${ORIGIN}/v2${path}`, signal = AbortSignal.timeout(Math.min(this.perCallMs, this.deadline - Date.now()));
    try {
      const response = await fetch(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { Authorization: `Bearer ${this.token}` }, signal });
      if (!response.ok || response.redirected || response.url && response.url !== url) { await response.body?.cancel(); throw new RecoveryReadError('read_unavailable'); }
      return await boundedJson(response, signal);
    } catch (error) { if (error instanceof RecoveryReadError) throw error; throw new RecoveryReadError('read_unavailable'); }
  }
  private verify(): Promise<void> {
    return this.verified ??= (this.identityResult ??= this.get('/users/me')).then(value => {
      if (object(object(value).data).id !== this.account.expectedProviderUserId) throw new RecoveryReadError('metadata_invalid');
    });
  }
  async identity(): Promise<unknown> { await this.verify(); return this.identityResult; }
  async read(path: string): Promise<unknown> { await this.verify(); return this.get(path); }
}
export function exactRecoveryHookRun(value: unknown, job: Job, callbackOrigin: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const hook = value as Record<string, unknown>;
  if (hook.actionType !== 'HTTP_REQUEST' || hook.userId !== undefined && hook.userId !== job.expected_provider_user_id || typeof hook.requestUrl !== 'string' || hook.requestUrl.length > 2048) return null;
  try {
    const url = new URL(hook.requestUrl), origin = new URL(callbackOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
        url.origin !== origin.origin || url.username || url.password || url.hash || url.pathname !== '/functions/v1/apify-webhook' ||
        url.searchParams.getAll('job_id').length !== 1 || url.searchParams.get('job_id') !== job.id ||
        url.searchParams.getAll('dispatch_nonce').length !== 1 || url.searchParams.get('dispatch_nonce') !== job.dispatch_nonce ||
        [...url.searchParams.keys()].some(key => !['job_id','dispatch_nonce'].includes(key))) return null;
    const condition = object(hook.condition);
    if (!safeProviderId(condition.actorRunId) || condition.actorId != null && condition.actorId !== job.expected_actor_id || condition.actorTaskId != null) return null;
    return condition.actorRunId;
  } catch { return null; }
}
function exactReceiptRun(value: unknown, job: Job, callbackOrigin: string): string | null {
  try {
    const receipt = object(value), event = object(receipt.eventData);
    if (!safeProviderId(receipt.id) || receipt.userId !== job.expected_provider_user_id || !zonedTimestamp(receipt.createdAt) || !EVENTS.includes(String(receipt.eventType))) return null;
    const id = exactRecoveryHookRun(receipt.webhook, job, callbackOrigin);
    return id && event.actorId === job.expected_actor_id && event.actorRunId === id ? id : null;
  } catch { return null; }
}
function cursorValue(value: unknown): RecoveryCursor {
  if (value === null || value === undefined) return { mode: 'webhooks', offset: 0 };
  if (typeof value === 'string') {
    if (value.length > 256) throw new RecoveryReadError('metadata_invalid');
    try { value = JSON.parse(value); } catch { throw new RecoveryReadError('metadata_invalid'); }
  }
  const row = object(value);
  if (!['webhooks','receipts'].includes(String(row.mode)) || !Number.isSafeInteger(row.offset) || Number(row.offset) < 0 || Number(row.offset) > 10000 || Number(row.offset) % PAGE_SIZE !== 0) throw new RecoveryReadError('metadata_invalid');
  return { mode: row.mode as RecoveryCursor['mode'], offset: Number(row.offset) };
}
function verifiedJobRun(value: unknown, id: string, job: Job): Run {
  const run = parseRun(value);
  if (run.id !== id || run.actorId !== job.expected_actor_id || run.userId !== job.expected_provider_user_id) throw new RecoveryReadError('metadata_invalid');
  return run;
}
/** Empty pages, same-input runs and temporal proximity never prove a non-start. */
export async function findMissingRun(job: Job, reader: RecoveryReader, cursor: unknown = null, pagesLimit = MAX_PAGES): Promise<RecoveryResult> {
  if (!validUuid(job.id) || !validUuid(job.owner_user_id) || !validUuid(job.dispatch_nonce) || !job.live || job.actor_run_id !== null ||
      reader.account.expectedProviderUserId !== job.expected_provider_user_id || reader.account.accountSlot !== job.apify_account_slot ||
      !Number.isSafeInteger(pagesLimit) || pagesLimit < 1 || pagesLimit > MAX_PAGES) throw new RecoveryReadError('metadata_invalid');
  const callbackOrigin = required('SUPABASE_URL');
  let next = cursorValue(cursor), pagesUsed = 0;
  for (; pagesUsed < pagesLimit;) {
    const mode = next.mode, offset = next.offset;
    const prefix = mode === 'webhooks' ? '/webhooks' : '/webhook-dispatches';
    const page = object(object(await reader.read(`${prefix}?desc=0&limit=${PAGE_SIZE}&offset=${offset}`)).data);
    pagesUsed++;
    if (!Array.isArray(page.items) || page.items.length > PAGE_SIZE || page.offset !== offset || page.limit !== PAGE_SIZE ||
        page.count !== page.items.length || page.desc !== false || !Number.isSafeInteger(page.total) || Number(page.total) < 0 ||
        page.items.length > 0 && Number(page.total) < offset + page.items.length || page.items.length === 0 && Number(page.total) > offset) throw new RecoveryReadError('metadata_invalid');
    const candidates = new Set<string>();
    for (const value of page.items) {
      if (mode === 'webhooks') {
        const id = exactRecoveryHookRun(value, job, callbackOrigin); if (id) candidates.add(id);
      } else {
        const id = exactReceiptRun(value, job, callbackOrigin); if (!id) continue;
        const receipt = object(value), detail = object(object(await reader.read(`/webhook-dispatches/${encodeURIComponent(String(receipt.id))}`)).data);
        if (detail.id === receipt.id && detail.eventType === receipt.eventType && detail.createdAt === receipt.createdAt && exactReceiptRun(detail, job, callbackOrigin) === id) candidates.add(id);
      }
      if (candidates.size > 2) throw new RecoveryReadError('metadata_invalid');
    }
    if (candidates.size > 1) throw new RecoveryReadError('metadata_invalid');
    for (const id of candidates) {
      const run = verifiedJobRun(await reader.read(`/actor-runs/${encodeURIComponent(id)}`), id, job);
      return { outcome: 'matched', run, pagesUsed, cursor: next };
    }
    if (offset + page.items.length >= Number(page.total)) {
      if (mode === 'receipts') return { outcome: 'exhausted', pagesUsed, cursor: null };
      next = { mode: 'receipts', offset: 0 };
    } else if (offset + PAGE_SIZE > 10000) return { outcome: 'exhausted', pagesUsed, cursor: null };
    else next = { mode, offset: offset + PAGE_SIZE };
  }
  return { outcome: 'no_match', pagesUsed, cursor: next };
}
export async function recoverJournalRun(job: Job, session: CollectionSession): Promise<boolean> {
  const state = await collectionRecoveryState(job);
  const ids = [...new Set([...state.accepted_evidence.map(row => row.run_id), ...state.callback_hints.map(row => row.run_id)])];
  if (!ids.length) return false;
  if (ids.length !== 1) throw new RecoveryReadError('metadata_invalid');
  const run = await (await session.adapter(job)).run(ids[0]);
  if (run.id !== ids[0] || run.actorId !== job.expected_actor_id || run.userId !== job.expected_provider_user_id) throw new RecoveryReadError('metadata_invalid');
  await attachAcceptedRun(job, run, 'provider_recovery'); job.actor_run_id = run.id; session.rememberRun(job, run);
  return true;
}
export async function recoverMissingRuns(owner: string, session: CollectionSession, jobId?: string): Promise<{ job_id: string; state: string }[]> {
  if (!validUuid(owner) || session.owner !== owner || jobId !== undefined && !validUuid(jobId)) throw new RecoveryReadError('metadata_invalid');
  const claims = await rpc<{ job: Job; recovery_token: string; cursor: unknown; attempt: number; pages_remaining: number }[]>('worker_claim_missing_run_recovery',
    { p_owner_user_id: owner, p_job_id: jobId ?? null, p_limit: 2 });
  if (!Array.isArray(claims) || claims.length > 2) throw new RecoveryReadError('metadata_invalid');
  const outcomes: { job_id: string; state: string }[] = [];
  for (const claim of claims) {
    const job = claim.job;
    if (!job || job.owner_user_id !== owner || jobId && job.id !== jobId || !validUuid(claim.recovery_token) ||
        !Number.isSafeInteger(claim.attempt) || claim.attempt < 1 || claim.attempt > 8 || !Number.isSafeInteger(claim.pages_remaining) || claim.pages_remaining < 0 || claim.pages_remaining > 8) throw new RecoveryReadError('metadata_invalid');
    let result: RecoveryResult = { outcome: 'no_match', cursor: null, pagesUsed: Math.min(MAX_PAGES, claim.pages_remaining) };
    try {
      result.cursor = cursorValue(claim.cursor);
      if (await recoverJournalRun(job, session)) result = { outcome: 'matched', cursor: null, pagesUsed: 0 };
      else if (claim.pages_remaining === 0) result = { outcome: 'exhausted', cursor: null, pagesUsed: 0 };
      else {
        const account = await accountForJob(job, await session.accounts());
        if (!account) throw new RecoveryReadError('metadata_invalid');
        result = await findMissingRun(job, new RecoveryReader(account), claim.cursor, Math.min(MAX_PAGES, claim.pages_remaining));
        if (result.run) { await attachAcceptedRun(job, result.run, 'provider_recovery'); job.actor_run_id = result.run.id; session.rememberRun(job, result.run); }
      }
      outcomes.push({ job_id: job.id, state: result.outcome === 'matched' ? 'run_recovered' : result.outcome === 'exhausted' ? 'review_required' : 'acceptance_unknown' });
    } catch { outcomes.push({ job_id: job.id, state: 'recovery_unavailable' }); }
    finally {
      try { await rpc('worker_complete_missing_run_recovery', { p_owner_user_id: owner, p_job_id: job.id, p_recovery_token: claim.recovery_token,
        p_outcome: result.outcome, p_cursor: result.cursor === null ? null : JSON.stringify(result.cursor), p_pages_used: result.pagesUsed }); }
      catch { /* Bounded DB lease, eight attempts and page budget own later recovery. */ }
    }
  }
  return outcomes;
}

import type { AccountUsage, ApifyAccount, ApifyAccountContext, ApifyAccountSlot, CollectionSubmitScope, Context, CreatorRef, Job, Normalized, PreparedStart, ProfileError, Provider, Run } from './model.ts';
import { identity, metric, object, publicUrl, timestampBasis } from './model.ts';
import { accountSlot, accountTokenName, apifyRead, authoritativeUsage, env, freezeAccount, jobAccount, liveMode, profileIdentity, provider, required, safeProviderId, unavailableSummary, validateCarouselPilotSetup, validateDispatchSetup, validateProfileSetup } from './providers.ts';

export async function rpc<T = unknown>(name: string, args: Record<string, unknown>, timeoutMs = 12000): Promise<T> {
  // Validate the runtime before every DB call too; mocks may never target hosted canonical data.
  liveMode();
  const response = await fetch(`${required('SUPABASE_URL')}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: required('SUPABASE_SERVICE_ROLE_KEY'), Authorization: `Bearer ${required('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Database RPC ${name} failed (${response.status})`);
  const body = await response.text(); return (body ? JSON.parse(body) : null) as T;
}
export async function rows<T>(table: string, query: string): Promise<T[]> {
  liveMode();
  const response = await fetch(`${required('SUPABASE_URL')}/rest/v1/${table}?${query}`, { headers: {
    apikey: required('SUPABASE_SERVICE_ROLE_KEY'), Authorization: `Bearer ${required('SUPABASE_SERVICE_ROLE_KEY')}` }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Database read failed (${response.status})`);
  const data: unknown = await response.json(); if (!Array.isArray(data)) throw new Error('Invalid database result'); return data as T[];
}
export async function workerAccounts(owner: string): Promise<ApifyAccount[]> {
  if (!validUuid(owner)) throw new Error('Owner setup invalid');
  const result = await rpc<unknown>('worker_accounts', { p_owner_user_id: owner });
  if (!Array.isArray(result) || result.length < 1 || result.length > 5) throw new Error('Account registry unavailable');
  const slots = new Set<number>(), identities = new Set<string>();
  return result.map(value => {
    const row = object(value), slot = accountSlot(row.account_slot);
    if (row.owner_user_id !== owner || slots.has(slot) || typeof row.enabled !== 'boolean' || typeof row.authorization_confirmed !== 'boolean' ||
        row.provider_user_id !== null && (typeof row.provider_user_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.provider_user_id) || identities.has(row.provider_user_id))) throw new Error('Account registry identity invalid');
    slots.add(slot); if (typeof row.provider_user_id === 'string') identities.add(row.provider_user_id);
    return Object.freeze({ ...row, account_slot: slot }) as unknown as ApifyAccount;
  }).sort((a, b) => a.account_slot - b.account_slot);
}
export async function accountForJob(job: Job, accounts?: ApifyAccount[]): Promise<ApifyAccountContext | undefined> {
  if (!job.live) return undefined;
  if (job.apify_account_slot === undefined || job.apify_account_slot === null) return jobAccount(job);
  if (!validUuid(job.owner_user_id)) throw new Error('Job owner unavailable');
  const slot = accountSlot(job.apify_account_slot);
  const row = (accounts ?? await workerAccounts(job.owner_user_id)).find(account => account.account_slot === slot);
  if (!row || row.owner_user_id !== job.owner_user_id || row.provider_user_id !== job.expected_provider_user_id ||
      slot === 1 && row.provider_user_id !== required('APIFY_ACCOUNT_ID')) throw new Error('Pinned account registry mismatch');
  // Disabled accounts must still settle their historical accepted jobs. Usage freshness is a dispatch-only DB gate.
  return jobAccount(job, freezeAccount({ accountSlot: slot, expectedProviderUserId: row.provider_user_id }));
}
export async function providerForJob(job: Job, accounts?: ApifyAccount[]) {
  const adapter = provider(job.kind, job.live, await accountForJob(job, accounts));
  if (job.expected_actor_id !== adapter.actorId) throw new Error('Job kind Actor contract mismatch');
  return adapter;
}
/** Invocation-local only: no warm-isolate credential, usage, adapter or run cache. */
export class CollectionSession {
  private registry?: Promise<ApifyAccount[]>;
  private usage?: Promise<void>;
  private adapters = new Map<string, Provider>();
  private runs = new Map<string, Readonly<Run>>();
  constructor(readonly owner: string) { if (!validUuid(owner)) throw new Error('Owner setup invalid'); }
  private key(job: Job): string {
    if (job.owner_user_id !== this.owner || !validUuid(job.id)) throw new Error('Session job owner mismatch');
    return JSON.stringify([job.id, job.live, job.kind, job.dispatch_nonce, job.expected_actor_id, job.expected_provider_user_id, job.apify_account_slot ?? null]);
  }
  accounts(): Promise<ApifyAccount[]> { return this.registry ??= workerAccounts(this.owner); }
  async adapter(job: Job): Promise<Provider> {
    const key = this.key(job);
    let adapter = this.adapters.get(key);
    if (!adapter) { adapter = await providerForJob(job, job.live ? await this.accounts() : undefined); this.adapters.set(key, adapter); }
    return adapter;
  }
  rememberRun(job: Job, run: Run): void {
    if (run.id !== job.actor_run_id || run.actorId !== job.expected_actor_id || run.userId !== job.expected_provider_user_id) throw new Error('Session run identity mismatch');
    this.runs.set(this.key(job), Object.freeze({ ...run }));
  }
  run(job: Job): Run | undefined {
    const run = this.runs.get(this.key(job));
    if (run && (run.id !== job.actor_run_id || run.actorId !== job.expected_actor_id || run.userId !== job.expected_provider_user_id)) throw new Error('Session run identity mismatch');
    return run;
  }
  reconcileUsage(): Promise<void> { return this.usage ??= reconcileUsage(this.owner, this); }
}
function collectionTiming(phase: 'usage' | 'dispatch', started: number, counts: Record<string, number>): void {
  console.info('[ReelRadar] collection_timing', JSON.stringify({ phase, duration_ms: Math.max(0, Math.round(performance.now() - started)), ...counts }));
}
export interface CollectionRecoveryState {
  input_digest: string | null;
  accepted_evidence: { run_id: string; source: 'start_response' | 'callback' | 'provider_recovery'; verified: boolean }[];
  callback_hints: { run_id: string; dispatch_nonce: string }[];
}
export async function collectionRecoveryState(job: Job): Promise<CollectionRecoveryState> {
  if (!validUuid(job.owner_user_id) || !validUuid(job.id) || !validUuid(job.dispatch_nonce)) throw new Error('Recovery identity invalid');
  const result = object(await rpc('worker_get_collection_recovery_state', { p_owner_user_id: job.owner_user_id, p_job_id: job.id, p_dispatch_nonce: job.dispatch_nonce }));
  if (result.input_digest !== null && (typeof result.input_digest !== 'string' || !/^[a-f0-9]{64}$/.test(result.input_digest)) ||
      !Array.isArray(result.accepted_evidence) || result.accepted_evidence.length > 16 || !Array.isArray(result.callback_hints) || result.callback_hints.length > 16) throw new Error('Recovery state invalid');
  const accepted_evidence = result.accepted_evidence.map(value => {
    const row = object(value);
    if (!safeProviderId(row.run_id) || !['start_response','callback','provider_recovery'].includes(String(row.source)) || typeof row.verified !== 'boolean') throw new Error('Recovery evidence invalid');
    return { run_id: row.run_id, source: row.source as CollectionRecoveryState['accepted_evidence'][number]['source'], verified: row.verified };
  });
  const callback_hints = result.callback_hints.map(value => {
    const row = object(value);
    if (!safeProviderId(row.run_id) || row.dispatch_nonce !== job.dispatch_nonce) throw new Error('Recovery callback invalid');
    return { run_id: row.run_id, dispatch_nonce: row.dispatch_nonce as string };
  });
  return { input_digest: result.input_digest as string | null, accepted_evidence, callback_hints };
}
export async function recordAcceptedEvidence(job: Job, runId: string, source: 'start_response' | 'callback' | 'provider_recovery', verified: boolean): Promise<void> {
  if (!validUuid(job.owner_user_id) || !validUuid(job.id) || !validUuid(job.dispatch_nonce) || !safeProviderId(runId) ||
      !['start_response','callback','provider_recovery'].includes(source) || typeof verified !== 'boolean') throw new Error('Accepted evidence invalid');
  const pinned = Object.freeze({ ...job });
  const args = Object.freeze({ p_owner_user_id: job.owner_user_id, p_job_id: job.id, p_dispatch_nonce: job.dispatch_nonce,
    p_run_id: runId, p_source: source, p_verified: verified });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const receipt = object(await rpc('worker_record_accepted_evidence', args));
      if (receipt.recorded !== true) throw new Error('Evidence rejected');
      return;
    } catch {
      try {
        const stored = await collectionRecoveryState(pinned);
        if (stored.accepted_evidence.some(row => row.run_id === runId && row.source === source && (!verified || row.verified))) return;
      } catch { /* A full DB/callback outage cannot guarantee recovery of a lost provider ACK. */ }
      if (attempt === 2) throw new Error('Accepted evidence persistence unavailable');
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}
export async function attachAcceptedRun(job: Job, run: Run, source: 'start_response' | 'callback' | 'provider_recovery' = 'start_response'): Promise<void> {
  const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const mockRun = job.live === false && run.id === `mock:${job.id}`;
  if (!validUuid(job.id) || !validUuid(job.owner_user_id) || !validUuid(job.dispatch_nonce) || typeof job.live !== 'boolean' ||
      !safeId(job.expected_actor_id) || !safeId(job.expected_provider_user_id) || (!safeId(run.id) && !mockRun) ||
      run.actorId !== job.expected_actor_id || run.userId !== job.expected_provider_user_id ||
      !['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ABORTING', 'ABORTED', 'TIMING-OUT', 'TIMED-OUT'].includes(run.status) ||
      (run.defaultDatasetId !== null && !safeId(run.defaultDatasetId)) ||
      (run.defaultKeyValueStoreId !== undefined && run.defaultKeyValueStoreId !== null && !safeId(run.defaultKeyValueStoreId)) ||
      (run.usageTotalUsd !== null && (typeof run.usageTotalUsd !== 'number' || !Number.isFinite(run.usageTotalUsd) || run.usageTotalUsd < 0))) {
    throw new Error('Accepted run identity/metadata invalid');
  }
  if (mockRun && liveMode()) throw new Error('Synthetic run requires an isolated mock runtime');
  // Freeze the accepted identity before any await. Retrying a paid start is never safe;
  // only this exact idempotent attachment may repeat after a database interruption.
  const args = Object.freeze({ p_job_id: job.id, p_dispatch_nonce: job.dispatch_nonce, p_run_id: run.id,
    p_actor_id: run.actorId, p_provider_user_id: run.userId, p_dataset_id: run.defaultDatasetId });
  const owner = job.owner_user_id, live = job.live;
  // Receipt journal must survive independently of canonical attachment, including
  // attachment failures. Only idempotent writes/reads repeat, never the paid POST.
  if (live) await recordAcceptedEvidence(job, run.id, source, true);
  const query = `id=eq.${encodeURIComponent(args.p_job_id)}&owner_user_id=eq.${encodeURIComponent(owner)}` +
    `&dispatch_nonce=eq.${encodeURIComponent(args.p_dispatch_nonce)}&actor_run_id=eq.${encodeURIComponent(args.p_run_id)}` +
    `&expected_actor_id=eq.${encodeURIComponent(args.p_actor_id)}&expected_provider_user_id=eq.${encodeURIComponent(args.p_provider_user_id)}&limit=2`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await rpc('worker_attach_run', args); return; }
    catch (error) {
      // An attachment (including an early authenticated webhook) may have committed
      // despite a lost response. Never infer success from a foreign/stale row.
      try {
        const persisted = await rows<Job>('scrape_jobs', query);
        if (persisted.length === 1 && persisted[0]?.id === args.p_job_id && persisted[0].owner_user_id === owner &&
            persisted[0].dispatch_nonce === args.p_dispatch_nonce && persisted[0].actor_run_id === args.p_run_id &&
            persisted[0].expected_actor_id === args.p_actor_id && persisted[0].expected_provider_user_id === args.p_provider_user_id &&
            persisted[0].live === live) return;
      } catch { /* Unverified persistence must keep the reservation uncertain. */ }
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
}
export function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }
async function constantEqual(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([a, b].map((v) => crypto.subtle.digest('SHA-256', encoder.encode(v))));
  const x = new Uint8Array(left), y = new Uint8Array(right); let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}
export async function authenticate(request: Request, webhook = false): Promise<boolean> {
  const supplied = webhook ? request.headers.get('x-webhook-secret') ?? '' : request.headers.get('x-internal-secret') ?? '';
  return request.method === 'POST' && await constantEqual(supplied, env(webhook ? 'APIFY_WEBHOOK_SHARED_SECRET' : 'INTERNAL_CRON_SECRET'));
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new Error('JSON required');
  if (Number(request.headers.get('content-length') ?? 0) > 16384) throw new Error('Payload too large');
  // Bound streaming input too, not only attacker-supplied Content-Length.
  const reader = request.body?.getReader(); if (!reader) throw new Error('Body required');
  let length = 0; const chunks: Uint8Array[] = [];
  while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 16384) { await reader.cancel(); throw new Error('Payload too large'); } chunks.push(part.value); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return object(JSON.parse(new TextDecoder().decode(bytes)));
}
function isMetricsCoauthorRow(row: Record<string, unknown>, context: Context): boolean {
  if (context.job.kind !== 'metrics' || !context.job.competitor_run_id || context.creators.length !== 1 || row.error || row.errorDescription ||
      typeof row.ownerUsername !== 'string' || !/^[a-z0-9._]{1,30}$/i.test(row.ownerUsername) ||
      row.ownerUsername.toLowerCase() === context.creators[0].username || !Array.isArray(row.coauthorProducers)) return false;
  const url = publicUrl(row.url, true);
  return Boolean(url && /^\/(?:reel|p)\/[A-Za-z0-9_-]{1,64}\/?$/.test(new URL(url).pathname) && row.coauthorProducers.slice(0, 20).some(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const username = (value as Record<string, unknown>).username;
    return typeof username === 'string' && username.toLowerCase() === context.creators[0].username;
  }));
}
export async function processJob(jobId: string, session?: CollectionSession): Promise<string> {
  const claim = await rpc<Context & { reason?: string }>('worker_claim_processing', { p_job_id: jobId });
  if (!claim.job) return claim.reason ?? 'not_claimable';
  if (claim.job.id !== jobId) throw new Error('Processing claim identity mismatch');
  const context = claim;
  try {
    const adapter = session ? await session.adapter(context.job) : await providerForJob(context.job);
    // At most three bounded pages per invocation; cursor survives restarts and missed callbacks.
    for (let pageNumber = 0; pageNumber < 3 && !context.job.dataset_finished; pageNumber++) {
      const page = await adapter.page(context, 100);
      const records: Normalized[] = [], errors: ProfileError[] = [], receivedCounts: Record<string, number> = {};
      let unidentifiedErrors = 0;
      for (const item of page.items) {
        try {
          const row = object(item);
          // A profile feed also contains collaborations owned by another creator.
          // Count the verified coauthor's delivered row, but never import it under
          // that creator. SQL still requires every frozen metrics target to return.
          if (isMetricsCoauthorRow(row, context)) {
            const creatorId = context.creators[0].id;
            receivedCounts[creatorId] = (receivedCounts[creatorId] ?? 0) + 1;
            continue;
          }
          const creator = context.job.kind === 'profile' ? profileIdentity(row, context) : identity(row.ownerUsername, context);
          receivedCounts[creator.id] = (receivedCounts[creator.id] ?? 0) + 1;
          // An explicit empty discovery result is a pagination placeholder,
          // not a failed creator or a fabricated Reel.
          if (['discovery','carousel'].includes(context.job.kind) && row.error === 'no_items') continue;
          const normalized = adapter.normalize(item, context);
          if (normalized.record) records.push(normalized.record);
          if (normalized.error) errors.push(normalized.error);
        } catch { unidentifiedErrors++; }
      }
      // Unknown/mismatched owner never gets accepted or attached to an arbitrary creator.
      // Preserve valid records, but surface the batch-level identity/schema failure per profile.
      if (unidentifiedErrors) for (const creator of context.creators) errors.push({ creator_id: creator.id, status: 'failed', message: `${unidentifiedErrors} dataset record(s) had unknown identity/schema and were rejected` });
      const errorMap = new Map(errors.map((e) => [e.creator_id, e]));
      await rpc('worker_ingest_page', { p_job_id: jobId, p_lease_token: context.job.lease_token, p_expected_cursor: context.job.dataset_cursor,
        p_records: records, p_errors: [...errorMap.values()], p_received_counts: receivedCounts, p_next_cursor: page.next, p_finished: page.finished });
      context.job.dataset_cursor = page.next; context.job.dataset_finished = page.finished;
    }
    if (context.job.dataset_finished) {
      let summary;
      try { summary = await adapter.summary(context, session?.run(context.job)); }
      catch { summary = unavailableSummary(context, 'output_unavailable'); }
      await rpc('worker_record_output_summary', { p_job_id: jobId, p_lease_token: context.job.lease_token, p_summary: summary });
      await rpc('worker_finish_processing', { p_job_id: jobId, p_lease_token: context.job.lease_token }); return 'finished';
    }
    await rpc('worker_release_processing', { p_job_id: jobId, p_lease_token: context.job.lease_token }); return 'continuation_required';
  } catch {
    await rpc('worker_release_processing', { p_job_id: jobId, p_lease_token: context.job.lease_token, p_error: 'Bounded processing failed; cursor preserved for reconciliation' });
    return 'processing_retry_required';
  }
}
export async function verifyRun(job: Job, session?: CollectionSession): Promise<Job> {
  if (!job.actor_run_id) throw new Error('Run not attached');
  const adapter = session ? await session.adapter(job) : await providerForJob(job);
  const run = session?.run(job) ?? await adapter.run(job.actor_run_id);
  if (run.id !== job.actor_run_id || run.actorId !== job.expected_actor_id || run.userId !== job.expected_provider_user_id) throw new Error('Run/Actor/account identity mismatch');
  session?.rememberRun(job, run);
  return await rpc<Job>('worker_reconcile_run', { p_job_id: job.id, p_run_id: run.id, p_actor_id: run.actorId, p_provider_user_id: run.userId,
    p_status: run.status, p_dataset_id: run.defaultDatasetId, p_usage_total_usd: run.usageTotalUsd });
}
export async function checkedAccountUsage(owner: string, slot: ApifyAccountSlot, expectedId: string | null, registeredId: string | null = expectedId,
  onObservation?: (observationId: string) => void): Promise<AccountUsage> {
  if (!validUuid(owner)) throw new Error('Owner setup invalid');
  accountSlot(slot);
  const result = object(await rpc('worker_begin_account_usage', { p_owner_user_id: owner, p_account_slot: slot, p_provider_user_id: registeredId }));
  if (!validUuid(result.observation_id) || typeof result.observed_at !== 'string' || !Number.isFinite(Date.parse(result.observed_at))) throw new Error('Account usage checkpoint unavailable');
  // Capture the DB token before provider awaits, including when those reads fail.
  onObservation?.(result.observation_id);
  return authoritativeUsage(slot, expectedId, { observationId: result.observation_id, observedAt: result.observed_at });
}
async function invalidateUsageObservation(owner: string, slot: ApifyAccountSlot, observationId: string | null): Promise<void> {
  // No token means this invocation cannot prove which read it may invalidate.
  // The caller still fails closed; never clear a possibly newer observation.
  if (observationId !== null) await rpc('worker_invalidate_account_usage', {
    p_owner_user_id: owner, p_account_slot: slot, p_observation_id: observationId,
  });
}
export async function recordUsage(owner: string, usage: AccountUsage, slot: ApifyAccountSlot = 1): Promise<void> {
  if (!validUuid(owner)) throw new Error('Owner setup invalid');
  accountSlot(slot);
  const checkpoint = usage.observationId === undefined && usage.observedAt === undefined ? {} :
    validUuid(usage.observationId) && typeof usage.observedAt === 'string' && Number.isFinite(Date.parse(usage.observedAt))
      ? { p_observation_id: usage.observationId, p_observed_at: usage.observedAt } : null;
  if (!checkpoint) throw new Error('Invalid account usage checkpoint');
  const args = { p_owner_user_id: owner, p_provider_user_id: usage.userId, p_cycle_start_at: usage.cycleStart, p_cycle_end_at: usage.cycleEnd, p_usage_usd: usage.usageUsd, p_limit_usd: usage.limitUsd, ...checkpoint };
  if (slot === 1) await rpc('worker_record_usage', args); // Backward-compatible primary initialization/sync.
  else await rpc('worker_record_account_usage', { ...args, p_account_slot: slot });
}
export async function reconcileUsage(owner: string, session?: CollectionSession): Promise<void> {
  if (!liveMode()) return;
  if (session && session.owner !== owner) throw new Error('Usage session owner mismatch');
  const started = performance.now();
  const accounts = session ? await session.accounts() : await workerAccounts(owner);
  let failed = false, checked = 0, reused = 0, index = 0;
  // Three concurrent accounts at most, two sequential authoritative reads each.
  // DB still independently enforces its hard 15-minute usage/identity gate.
  const check = async () => {
    while (index < accounts.length) {
      const account = accounts[index++];
      if (!account.enabled) continue;
      let observationId: string | null = null;
      try {
        if (!account.authorization_confirmed || !account.provider_user_id || account.account_slot === 1 && account.provider_user_id !== required('APIFY_ACCOUNT_ID')) throw new Error('Account setup unavailable');
        required(accountTokenName(account.account_slot));
        const now = Date.now(), checkedAt = Date.parse(account.usage_reconciled_at ?? '');
        const fresh = session && Number.isFinite(checkedAt) && checkedAt <= now && now - checkedAt <= 60000 &&
          Date.parse(account.usage_cycle_start_at ?? '') <= now && Date.parse(account.usage_cycle_end_at ?? '') > now &&
          typeof account.usage_usd === 'number' && Number.isFinite(account.usage_usd) && account.usage_usd >= 0 &&
          typeof account.limit_usd === 'number' && Number.isFinite(account.limit_usd) && account.limit_usd >= 0;
        if (fresh) { reused++; continue; }
        const usage = await checkedAccountUsage(owner, account.account_slot, account.provider_user_id, account.provider_user_id, token => { observationId = token; });
        await recordUsage(owner, usage, account.account_slot);
        checked++;
      } catch {
        // No guessed exhaustion or fallback after an unverified enabled account.
        await invalidateUsageObservation(owner, account.account_slot, observationId);
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, accounts.length) }, check));
  collectionTiming('usage', started, { checked_accounts: checked, reused_accounts: reused });
  if (failed) throw new Error('Authoritative account usage unavailable');
}
export async function configureAccounts(owner: string, input: Record<string, unknown>): Promise<unknown> {
  if (!validUuid(owner) || !liveMode()) throw new Error('Account setup unavailable');
  if (input.authorization_confirmed !== true || !Array.isArray(input.account_slots) || input.account_slots.length < 1 || input.account_slots.length > 5 ||
      Object.keys(input).some(key => !['action', 'account_slots', 'authorization_confirmed'].includes(key))) throw new Error('Explicit account authorization required');
  const slots = input.account_slots.map(accountSlot);
  if (new Set(slots).size !== slots.length) throw new Error('Duplicate account slots');
  const accounts = await workerAccounts(owner), verified: { slot: ApifyAccountSlot; usage: AccountUsage }[] = [];
  // Validate the complete request before enabling any slot. Only /users/me and
  // /users/me/limits are called; never Actor input, paid starts or Cron setup.
  for (const slot of slots) {
    const existing = accounts.find(account => account.account_slot === slot);
    if (!existing) throw new Error('Account registry unavailable');
    const expected = existing.provider_user_id ?? (slot === 1 ? required('APIFY_ACCOUNT_ID') : null);
    let usage: AccountUsage, observationId: string | null = null;
    try { usage = await checkedAccountUsage(owner, slot, expected, existing.provider_user_id, token => { observationId = token; }); }
    catch (error) {
      if (existing.enabled) await invalidateUsageObservation(owner, slot, observationId);
      throw error;
    }
    if (accounts.some(account => account.account_slot !== slot && account.provider_user_id === usage.userId) || verified.some(account => account.usage.userId === usage.userId)) throw new Error('Duplicate provider account');
    verified.push({ slot, usage });
  }
  for (const { slot, usage } of verified) {
    // DB uniqueness and immutable historical pins are authoritative across races.
    await rpc('worker_configure_apify_account', { p_owner_user_id: owner, p_account_slot: slot, p_provider_user_id: usage.userId, p_enabled: true, p_authorization_confirmed: true });
    try { await recordUsage(owner, usage, slot); }
    catch (error) { await invalidateUsageObservation(owner, slot, usage.observationId ?? null); throw error; }
  }
  return { configured: verified.map(({ slot }) => ({ accountSlot: slot, tokenEnvName: accountTokenName(slot), enabled: true, usageStored: true })), paidStarts: 0 };
}
export interface CollectionRuntime {
  max_active: number; max_starts_per_wake: number; wake_revision: number; drained_revision: number;
  wake_pending: boolean; eligible_kinds: string[];
  executor_nonce: string | null; executor_revision: number | null; executor_expires_at: string | null;
  executor_starts: number; executor_start_limit: number; wake_retry_after: string | null;
}
function validateCollectionRuntime(result: CollectionRuntime): CollectionRuntime {
  const safeRevision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  const safeTime = (value: unknown) => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (!result || ![result.max_active, result.max_starts_per_wake, result.executor_start_limit].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 4) ||
      ![result.wake_revision, result.drained_revision, result.executor_starts].every(safeRevision) ||
      result.drained_revision > result.wake_revision || result.executor_starts > result.executor_start_limit ||
      typeof result.wake_pending !== 'boolean' || result.wake_pending !== (result.wake_revision > result.drained_revision) ||
      result.executor_revision !== null && (!safeRevision(result.executor_revision) || result.executor_revision > result.wake_revision) ||
      result.executor_nonce !== null && !validUuid(result.executor_nonce) ||
      (result.executor_nonce === null) !== (result.executor_expires_at === null) ||
      result.executor_nonce !== null && result.executor_revision === null ||
      !safeTime(result.executor_expires_at) || !safeTime(result.wake_retry_after) || !Array.isArray(result.eligible_kinds) ||
      result.eligible_kinds.some(kind => !['daily','weekly','backfill','profile','manual','retry','discovery','metrics','carousel'].includes(kind))) throw new Error('Collection runtime unavailable');
  return result;
}
export async function collectionRuntime(owner: string): Promise<CollectionRuntime> {
  if (!validUuid(owner)) throw new Error('Owner setup invalid');
  return validateCollectionRuntime(await rpc<CollectionRuntime>('worker_collection_runtime', { p_owner_user_id: owner }));
}
export async function recordCompletionWake(owner: string, jobId: string): Promise<boolean> {
  if (!validUuid(owner) || !validUuid(jobId)) throw new Error('Completion wake identity invalid');
  const pending = await rpc<boolean>('worker_record_completion_wake', { p_owner_user_id: owner, p_job_id: jobId });
  if (typeof pending !== 'boolean') throw new Error('Completion wake unavailable');
  return pending;
}
export interface CollectionSubmitFence { executorNonce: string; claimedRevision: number }
export async function submitCollectionClaim(context: Context, maxCharge: number, scope: CollectionSubmitScope,
  fence?: CollectionSubmitFence, session?: CollectionSession): Promise<{ job_id: string; status: 'running' | 'uncertain' | 'cancelled' | 'not_authorized' }> {
  const job = Object.freeze({ ...context.job }), jobId = job.id;
  const pinned: Context = { job: { ...job }, creators: context.creators.map(creator => Object.freeze({ ...creator })) };
  const identityArgs = Object.freeze({ p_owner_user_id: job.owner_user_id, p_job_id: job.id, p_dispatch_nonce: job.dispatch_nonce });
  let prepared: PreparedStart;
  try {
    if (!validUuid(job.owner_user_id) || !validUuid(job.id) || !validUuid(job.dispatch_nonce) || job.collection_source !== scope ||
        scope === 'ordinary' && (!fence || !validUuid(fence.executorNonce) || !Number.isSafeInteger(fence.claimedRevision) || fence.claimedRevision < 0) ||
        scope !== 'ordinary' && fence !== undefined || scope === 'carousel_pilot' && (job.kind !== 'carousel' || pinned.creators.length !== 1) ||
        scope === 'target_media' && (job.kind !== 'manual' || job.results_limit !== 100 || pinned.creators.length !== 1)) throw new Error('Submit claim scope invalid');
    // A fresh invocation consumes durable journal/callback hints before considering
    // a start. SQL independently prevents a duplicate start even if this read races.
    if (job.live) {
      const recovery = await collectionRecoveryState(job);
      const ids = [...new Set([...recovery.accepted_evidence.map(row => row.run_id), ...recovery.callback_hints.map(row => row.run_id)])];
      if (ids.length) {
        if (ids.length !== 1) return { job_id: jobId, status: 'uncertain' };
        const adapter = session ? await session.adapter(job) : await providerForJob(job);
        const run = await adapter.run(ids[0]);
        if (run.id !== ids[0] || run.actorId !== job.expected_actor_id || run.userId !== job.expected_provider_user_id) return { job_id: jobId, status: 'uncertain' };
        await attachAcceptedRun(job, run, 'provider_recovery');
        return { job_id: jobId, status: 'running' };
      }
    }
    const adapter = session ? await session.adapter(job) : await providerForJob(job);
    prepared = await adapter.prepare(pinned, maxCharge);
  } catch {
    // This RPC verifies phase=prepared and atomically cancels delayed invocations;
    // it cannot release an already-authorized/accepted hold after a read failure.
    try {
      const result = object(await rpc('worker_cancel_pre_submit', { ...identityArgs, p_reason: 'preparation_failed' }));
      if (result.cancelled === true) return { job_id: jobId, status: 'cancelled' };
    } catch { /* No proof of cancellation: retain the protected reservation. */ }
    return { job_id: jobId, status: 'uncertain' };
  }
  const authorizeArgs = Object.freeze({ ...identityArgs, p_input_digest: prepared.inputDigest,
    p_executor_nonce: fence?.executorNonce ?? null, p_claimed_revision: fence?.claimedRevision ?? null });
  // No authorize retry even after a timeout/lost response: only a fresh DB winner
  // may make the next single paid POST. All other outcomes retain uncertainty.
  const outcome = await prepared.submit(async () => {
    const result = object(await rpc('worker_authorize_collection_submit', authorizeArgs));
    return result.authorized === true;
  });
  if (outcome.kind === 'accepted') {
    try {
      await attachAcceptedRun(job, outcome.run);
      if (!job.live) {
        pinned.job.actor_run_id = outcome.run.id;
        session?.rememberRun(pinned.job, outcome.run);
        await verifyRun(pinned.job, session); await processJob(jobId, session);
      }
      return { job_id: jobId, status: 'running' };
    } catch { /* Journal or callback may restore canonical attachment later. */ }
  } else if (outcome.kind === 'accepted_hint') {
    try { await recordAcceptedEvidence(job, outcome.runId, 'start_response', false); } catch { /* Full outage caveat: no local journal guarantee. */ }
  } else if (outcome.kind === 'not_authorized') {
    try {
      const cancelled = object(await rpc('worker_cancel_pre_submit', { ...identityArgs, p_reason: 'authorization_not_granted' }));
      if (cancelled.cancelled === true) return { job_id: jobId, status: 'cancelled' };
    } catch { /* Another executor may already have crossed the fence. */ }
    return { job_id: jobId, status: 'not_authorized' };
  }
  try {
    const failure = object(await rpc('worker_dispatch_failure', { ...identityArgs, p_classification: 'request_unknown',
      p_error: outcome.kind === 'authorization_unknown' ? 'Submission authorization response unavailable; transactional recovery required' : 'Provider acceptance or persistence unknown' }));
    if (failure.cancelled === true) return { job_id: jobId, status: 'cancelled' };
  }
  catch { /* SQL submit fence already protects the reservation if diagnostics fail. */ }
  return { job_id: jobId, status: 'uncertain' };
}
export class CollectionMaintenanceError extends Error {
  constructor() { super('Collection maintenance unavailable'); }
}
export async function dispatch(owner: string, alreadyReconciled = false, session = new CollectionSession(owner), completionOnly = false,
  maintenance: 'none' | 'generic' | 'scoped' = 'none'): Promise<unknown[]> {
  validateDispatchSetup();
  if (session.owner !== owner) throw new Error('Dispatch session owner mismatch');
  const started = performance.now();
  type Executor = CollectionRuntime & { claimed_revision: number; starts_remaining: number };
  const acquired = await rpc<Executor | { reason: string }>('worker_claim_collection_executor', {
    p_owner_user_id: owner, p_completion_only: completionOnly,
  });
  if (acquired && 'reason' in acquired) {
    if (!['executor_busy','wake_not_pending','wake_retry_deferred','wake_start_limit','owner_not_provisioned'].includes(acquired.reason)) throw new Error('Collection executor unavailable');
    return [{ reason: acquired.reason }];
  }
  const config = validateCollectionRuntime(acquired as Executor) as Executor;
  if (!validUuid(config.executor_nonce) || config.claimed_revision !== config.executor_revision ||
      !Number.isSafeInteger(config.starts_remaining) || config.starts_remaining < 0 ||
      config.starts_remaining !== config.executor_start_limit - config.executor_starts) throw new Error('Collection executor unavailable');
  const fence = { p_owner_user_id: owner, p_executor_nonce: config.executor_nonce, p_revision: config.claimed_revision };
  const outcomes: unknown[] = [];
  let starts = 0, drained = false, completed = true;
  try {
    // Maintenance shares the existing executor fence. Losing/duplicate wakes
    // must not repeatedly scan queues before discovering that another owns it.
    if (maintenance !== 'none') {
      try {
        await rpc('worker_competitor_maintain', { p_owner_user_id: owner });
        if (env('CAROUSEL_PROVIDER_VALIDATED') === 'true') await rpc('worker_carousel_maintain', { p_owner_user_id: owner, p_limit: 10 });
        if (maintenance === 'generic' && env('PROFILE_PROVIDER_VALIDATED') === 'true') await rpc('worker_profile_maintain', { p_owner_user_id: owner, p_limit: 20 });
      } catch { throw new CollectionMaintenanceError(); }
    }
    // Only the transactional winner reconciles accounts or contacts providers.
    if (!alreadyReconciled) await session.reconcileUsage();
    const live = liveMode(), actorIds: Record<string, string> = {};
    const eligible = config.eligible_kinds.filter(kind => {
      try { validateProfileSetup(kind); actorIds[kind] = provider(kind, live).actorId; return true; }
      catch { completed = false; outcomes.push({ reason: kind === 'carousel' ? 'carousel_mapping_unverified' : 'profile_mapping_unverified', kind }); return false; }
    });
    for (let attempt = 0; attempt < config.starts_remaining && eligible.length; attempt++) {
      // Nonce/revision validation and durable attempt accounting are in the SAME
      // transaction as the existing fair selector and monetary reservation.
      const claim = await rpc<Context & { max_total_charge_usd: number; reason?: string }>('worker_claim_next', {
        p_owner_user_id: owner, p_live: live, p_actor_ids: actorIds, p_eligible_kinds: eligible,
        p_executor_nonce: config.executor_nonce, p_claimed_revision: config.claimed_revision,
      });
      if (!claim.job) {
        outcomes.push({ reason: claim.reason });
        completed &&= claim.reason === 'no_pending_jobs';
        break;
      }
      starts++;
      if (claim.job.owner_user_id !== owner || !eligible.includes(claim.job.kind) || claim.job.collection_source !== 'ordinary' ||
          claim.job.live !== live || claim.job.expected_actor_id !== actorIds[claim.job.kind]) throw new Error('Ordinary claim scope mismatch');
      const outcome = await submitCollectionClaim(claim, Number(claim.max_total_charge_usd), 'ordinary',
        { executorNonce: config.executor_nonce!, claimedRevision: config.claimed_revision }, session);
      outcomes.push(outcome);
      if (outcome.status !== 'running') { completed = false; break; }
    }
    // A blocked/ambiguous head is not a completed executor. Keep its continuation
    // and defer retries; duplicate callbacks must not spin against the provider.
    if (completed) {
      drained = await rpc<boolean>('worker_drain_completion_wake', fence) === true;
      if (!drained) throw new Error('Collection executor lease lost before drain');
    }
    collectionTiming('dispatch', started, { claimed_starts: starts, max_active: config.max_active });
    return outcomes;
  } finally {
    if (!drained) {
      try { await rpc('worker_release_collection_executor', fence); }
      catch { /* A lost release keeps the nonce; bounded expiry recovery owns it next. */ }
    }
  }
}
export async function dispatchCarouselPilot(owner: string, jobId: string): Promise<{ job_id?: string; status?: string; reason?: string }> {
  validateCarouselPilotSetup(jobId);
  await reconcileUsage(owner);
  const adapter = provider('carousel', true);
  const claim = await rpc<Context & { max_total_charge_usd: number; reason?: string }>('worker_claim_carousel_pilot',
    { p_owner_user_id: owner, p_job_id: jobId, p_actor_id: adapter.actorId });
  if (!claim.job) return { reason: claim.reason };
  if (claim.job.id !== jobId || claim.job.owner_user_id !== owner || claim.job.kind !== 'carousel'
    || claim.job.collection_source !== 'carousel_pilot' || !claim.job.live || claim.max_total_charge_usd <= 0 || claim.max_total_charge_usd > .10
    || !Number.isFinite(claim.max_total_charge_usd) || Number(claim.job.reserved_usd) !== claim.max_total_charge_usd) throw new Error('Invalid carousel pilot claim');
  return submitCollectionClaim(claim, claim.max_total_charge_usd, 'carousel_pilot');
}
export function validUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
export function continuationBudget(input: Record<string, unknown>): number {
  const value = input.continuation_budget ?? 4;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 4) throw new Error('Invalid continuation budget');
  return value;
}
export function wakeReconciliation(budget: number, carouselPilotJobId?: string, settleJobId?: string, ordinaryCallbackJobId?: string): void {
  if ([carouselPilotJobId, settleJobId, ordinaryCallbackJobId].some(value => value !== undefined && !validUuid(value)) ||
      [carouselPilotJobId, settleJobId, ordinaryCallbackJobId].filter(value => value !== undefined).length > 1) throw new Error('Invalid reconciliation scope');
  const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
  if (!runtime || budget <= 0 || env('PROVIDER_MODE') !== 'apify') return;
  // One bounded chain: no retries, no start POST replay, no unbounded self-invocation.
  const work = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const response = await fetch(`${required('SUPABASE_URL')}/functions/v1/reconcile-jobs`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'x-internal-secret': required('INTERNAL_CRON_SECRET'),
      Authorization: `Bearer ${required('SUPABASE_SERVICE_ROLE_KEY')}`,
    }, body: JSON.stringify({ continuation_budget: budget - 1, ...(carouselPilotJobId ? { carousel_pilot_job_id: carouselPilotJobId } : {}),
      ...(settleJobId ? { settle_job_id: settleJobId } : {}),
      ...(ordinaryCallbackJobId ? { ordinary_callback_job_id: ordinaryCallbackJobId } : {}) }), signal: AbortSignal.timeout(60000) });
    await response.body?.cancel();
  })().catch(() => undefined);
  runtime.waitUntil(work);
}
export function diagnosticsMissingKeys(): string[] {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'REELRADAR_OWNER_USER_ID', 'PROVIDER_MODE'].filter((key) => !env(key));
  if (![1, 2, 3, 4, 5].some(slot => env(accountTokenName(slot as ApifyAccountSlot)))) missing.unshift('APIFY_API_TOKEN');
  return missing;
}
export class AccountDiagnosticsError extends Error {
  constructor(readonly stage: 'provider_usage' | 'usage_persistence', readonly upstreamStatus: number | null = null) {
    super('Authoritative usage diagnostics unavailable');
  }
}
export async function accountDiagnostics(owner: string): Promise<unknown> {
  if (!liveMode()) throw new Error('Account diagnostics require Apify mode');
  const accounts = await workerAccounts(owner);
  const results: Record<string, unknown>[] = [];
  let failure: AccountDiagnosticsError | undefined;
  for (const account of accounts) {
    const base = { accountSlot: account.account_slot, tokenEnvName: accountTokenName(account.account_slot), enabled: account.enabled };
    if (!account.enabled) { results.push({ ...base, stored: false, reason: 'disabled' }); continue; }
    let usage: AccountUsage, observationId: string | null = null;
    try {
      if (!account.authorization_confirmed || !account.provider_user_id || account.account_slot === 1 && account.provider_user_id !== required('APIFY_ACCOUNT_ID')) throw new Error('Account setup unavailable');
      usage = await checkedAccountUsage(owner, account.account_slot, account.provider_user_id, account.provider_user_id, token => { observationId = token; });
    } catch (error) {
      const status = error instanceof Error ? /^Apify read failed \((\d{3})\)$/.exec(error.message) : null;
      failure ??= new AccountDiagnosticsError('provider_usage', status ? Number(status[1]) : null);
      await invalidateUsageObservation(owner, account.account_slot, observationId);
      results.push({ ...base, stored: false, reason: 'usage_unverified', balanceUsd: null }); continue;
    }
    try { await recordUsage(owner, usage, account.account_slot); }
    catch (error) {
      const status = error instanceof Error ? /^Database RPC worker_record_(?:account_)?usage failed \((\d{3})\)$/.exec(error.message) : null;
      failure ??= new AccountDiagnosticsError('usage_persistence', status ? Number(status[1]) : null);
      await invalidateUsageObservation(owner, account.account_slot, observationId);
      results.push({ ...base, stored: false, reason: 'usage_persistence_failed', balanceUsd: null }); continue;
    }
    results.push({ ...base, ...usage, balanceUsd: null, balanceBasis: 'not_exposed_by_documented_api', stored: true });
  }
  if (failure && !results.some(account => account.stored === true)) throw failure;
  // Keep primary singleton diagnostic fields for existing operators while exposing each slot explicitly.
  const primary = results.find(account => account.accountSlot === 1 && account.stored === true) ?? {};
  return { ...primary, accounts: results,
    gates: { scrapingEnabled: env('SCRAPING_ENABLED', 'false') === 'true', providerValidated: env('PROVIDER_VALIDATED', 'false') === 'true',
      accountUsageValidated: env('ACCOUNT_USAGE_VALIDATED', 'false') === 'true', runChargeCapValidated: env('RUN_CHARGE_CAP_VALIDATED', env('PAY_PER_EVENT_CAP_VALIDATED', 'false')) === 'true', profileProviderValidated: env('PROFILE_PROVIDER_VALIDATED', 'false') === 'true' } };
}
export async function inspectRun(owner: string, runId: string): Promise<unknown> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId) || !liveMode()) throw new Error('Invalid run inspection');
  const [job] = await rows<Job>('scrape_jobs', `owner_user_id=eq.${encodeURIComponent(owner)}&actor_run_id=eq.${encodeURIComponent(runId)}&live=eq.true&limit=1`);
  if (!job || job.owner_user_id !== owner) throw new Error('Owned run unavailable');
  const account = await accountForJob(job);
  const adapter = provider(job.kind, true, account);
  if (job.expected_actor_id !== adapter.actorId) throw new Error('Job kind Actor contract mismatch');
  const run = await adapter.run(runId);
  if (run.id !== runId || run.actorId !== job.expected_actor_id || run.userId !== job.expected_provider_user_id) throw new Error('Run identity mismatch');
  const associations = await rows<{ creators: CreatorRef }>('scrape_job_creators', `select=creators(id,username)&job_id=eq.${encodeURIComponent(job.id)}&limit=20`);
  const context: Context = { job, creators: associations.map((row) => row.creators) };
  const raw = run.defaultDatasetId ? await apifyRead(`/datasets/${encodeURIComponent(run.defaultDatasetId)}/items?format=json&clean=true&offset=0&limit=3`, account) : [];
  if (!Array.isArray(raw) || raw.length > 3) throw new Error('Invalid sample');
  const samples = raw.map((value) => {
    const label = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9._]{1,30}$/.test(value) ? value : null;
    const sample = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    try {
      const row = object(value);
      const creator = job.kind === 'profile' ? profileIdentity(row, context) : identity(row.ownerUsername, context);
      const normalized = adapter.normalize(value, context);
      // Allow-listed metric/identity fields only; no arbitrary URLs, captions or provider error text.
      const timestamp = typeof row.timestamp === 'string' && row.timestamp.length < 64 && /^[0-9TZ:+.\-]+$/.test(row.timestamp) ? row.timestamp : null;
      return { username: creator.username, mediaId: typeof row.id === 'string' && /^\d{1,40}(?:_\d{1,40})?$/.test(row.id) ? row.id : null,
        rawTimestamp: timestamp, timestampField: job.kind === 'profile' ? null : 'timestamp', timestampBasis: timestampBasis(row.timestamp),
        views: metric(row.videoPlayCount), likes: metric(row.likesCount), comments: metric(row.commentsCount), followers: metric(row.followersCount),
        providerErrorRow: Boolean(row.error || row.errorDescription), normalizationAccepted: Boolean(normalized.record), normalizationError: normalized.error?.message ?? null };
    } catch { return { normalizationAccepted: false, normalizationError: 'sample_identity_or_schema_invalid',
      ownerUsername: label(sample.ownerUsername), username: label(sample.username),
      coauthors: Array.isArray(sample.coauthorProducers) ? sample.coauthorProducers.slice(0, 20).map(value =>
        value && typeof value === 'object' && !Array.isArray(value) ? label((value as Record<string, unknown>).username) : null).filter(Boolean) : [],
      fields: Object.keys(sample).filter(key => /^[A-Za-z0-9_]{1,60}$/.test(key)).slice(0, 60) }; }
  });
  let outputSummary;
  try { outputSummary = await adapter.summary(context); } catch { outputSummary = unavailableSummary(context, 'output_unavailable'); }
  let profileOutputEvidence;
  if (job.kind === 'profile' && run.defaultKeyValueStoreId && safeProviderId(run.defaultKeyValueStoreId)) {
    try {
      const output = object(await apifyRead(`/key-value-stores/${encodeURIComponent(run.defaultKeyValueStoreId)}/records/OUTPUT`, account));
      profileOutputEvidence = { fields: Object.keys(output).filter(key => /^[A-Za-z0-9_]{1,60}$/.test(key)).slice(0, 40),
        controls: Object.fromEntries(['version','results','profilesFound','statsRead','statsUnavailable','detailsRead','detailsUnavailable','blocked','costStateUnreadable','stopReason'].map(key => {
          const value = output[key]; return [key, typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ||
            typeof value === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(value) ? value : null];
        })),
        ok: typeof output.ok === 'boolean' ? output.ok : null, total_items: Number.isSafeInteger(output.total_items) ? output.total_items : null,
        users: Array.isArray(output.users) ? output.users.slice(0, 20).map(value => {
          const user = object(value); return { user: typeof user.user === 'string' && /^@?[A-Za-z0-9._]{1,30}$/.test(user.user) ? user.user : null,
            count: Number.isSafeInteger(user.count) ? user.count : null, hasError: Boolean(user.error) };
        }) : null };
    } catch { profileOutputEvidence = { unavailable: true }; }
  }
  return { jobId: job.id, runId: run.id, actorId: run.actorId, userId: run.userId, status: run.status, usageTotalUsd: run.usageTotalUsd, sampleLimit: 3, samples, outputSummary,
    ...(job.kind === 'profile' ? { profileOutputEvidence } : {}) };
}

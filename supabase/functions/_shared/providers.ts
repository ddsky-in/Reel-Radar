import type { AccountUsage, AccountUsageObservation, ApifyAccountContext, ApifyAccountSlot, Context, Job, Normalized, OutputSummary, Page, PreparedStart, ProfileError, ProfileProvider, ReelProvider, Run, StartOutcome } from './model.ts';
import { identity, metric, normalizeReel, normalizeCarousel, object, publicUrl, zonedTimestamp } from './model.ts';
import type { CarouselProvider } from './model.ts';

export function env(name: string, fallback = ''): string { return Deno.env.get(name) ?? fallback; }
export function required(name: string): string { const value = env(name); if (!value) throw new Error(`Missing ${name}`); return value; }
export function assertMockSetup(): void {
  // Synthetic adapters are test fixtures, never a production fallback (including old live=false jobs).
  if (env('PROVIDER_MODE') !== 'mock' || !['test', 'local'].includes(env('ENVIRONMENT')) ||
      Deno.env.get('SB_REGION') !== undefined || Deno.env.get('DENO_DEPLOYMENT_ID') !== undefined) {
    throw new Error('Mock providers require an explicit isolated local/test runtime');
  }
  let url: URL;
  try { url = new URL(required('SUPABASE_URL')); } catch { throw new Error('Mock providers require a loopback Supabase URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Mock providers require a loopback Supabase URL');
  }
}
export function liveMode(): boolean {
  const mode = required('PROVIDER_MODE');
  if (mode === 'apify') return true;
  if (mode === 'mock') { assertMockSetup(); return false; }
  throw new Error('Unsupported provider mode; no synthetic fallback');
}
export function accountSlot(value: unknown): ApifyAccountSlot {
  if (value !== 1 && value !== 2 && value !== 3 && value !== 4 && value !== 5) throw new Error('Invalid Apify account slot');
  return value;
}
export function accountTokenName(slot: ApifyAccountSlot): string {
  return ['APIFY_API_TOKEN', 'APIFY_API_TOKEN_2', 'APIFY_API_TOKEN_3', 'APIFY_API_TOKEN_4', 'APIFY_API_TOKEN_5'][accountSlot(slot) - 1];
}
function providerUserId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
export function freezeAccount(account: ApifyAccountContext): ApifyAccountContext {
  if (!providerUserId(account.expectedProviderUserId)) throw new Error('Account identity unavailable');
  return Object.freeze({ accountSlot: accountSlot(account.accountSlot), expectedProviderUserId: account.expectedProviderUserId });
}
export function jobAccount(job: Job, configured?: ApifyAccountContext): ApifyAccountContext {
  const slot = job.apify_account_slot === undefined || job.apify_account_slot === null
    ? (job.expected_provider_user_id && job.expected_provider_user_id === required('APIFY_ACCOUNT_ID') ? 1 : null)
    : accountSlot(job.apify_account_slot);
  if (slot === null || !providerUserId(job.expected_provider_user_id)) throw new Error('Historical account identity unavailable');
  if (configured && (configured.accountSlot !== slot || configured.expectedProviderUserId !== job.expected_provider_user_id)) throw new Error('Pinned account identity mismatch');
  // New secondary accounts always require an owner-scoped registry context.
  if (slot !== 1 && !configured) throw new Error('Account registry context required');
  if (slot === 1 && !configured && job.expected_provider_user_id !== required('APIFY_ACCOUNT_ID')) throw new Error('Primary account identity mismatch');
  return freezeAccount({ accountSlot: slot, expectedProviderUserId: job.expected_provider_user_id });
}
function liveGate(profile = false): void {
  const capValidated = env('RUN_CHARGE_CAP_VALIDATED', env('PAY_PER_EVENT_CAP_VALIDATED', 'false')) === 'true';
  if (env('SCRAPING_ENABLED', 'false') !== 'true' || env('PROVIDER_VALIDATED', 'false') !== 'true' || !capValidated || env('ACCOUNT_USAGE_VALIDATED', 'false') !== 'true') throw new Error('Live dispatch disabled or provider/run cap/account usage not validated');
  if (![1, 2, 3, 4, 5].some(slot => env(accountTokenName(slot as ApifyAccountSlot)))) throw new Error('Missing Apify account token');
  if (![2, 3, 4, 5].some(slot => env(accountTokenName(slot as ApifyAccountSlot)))) required('APIFY_ACCOUNT_ID');
  if (profile && env('PROFILE_PROVIDER_VALIDATED') !== 'true') throw new Error('Profile provider input/output mapping not validated');
}
function field(row: Record<string, unknown>, path: string): unknown {
  let value: unknown = row;
  for (const part of path.split('.')) { if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, part)) return undefined; value = (value as Record<string, unknown>)[part]; }
  return value;
}
async function readWithToken(path: string, token: string): Promise<unknown> {
  // Fixed origin and controlled paths prevent webhook/Actor data from becoming arbitrary fetch targets.
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) throw new Error('Invalid Apify path');
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(`https://api.apify.com/v2${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) });
      if (response.status !== 429 && response.status < 500) break;
      await response.body?.cancel();
    } catch { if (attempt === 2) throw new Error('Apify read unavailable'); }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  if (!response?.ok) throw new Error(`Apify read failed (${response?.status ?? 'network'})`);
  return await response.json();
}
function readIdentity(me: unknown, expectedId: string | null): string {
  const user = object(object(me).data);
  if (!providerUserId(user.id) || expectedId !== null && user.id !== expectedId) throw new Error('Account identity mismatch or unavailable');
  return user.id;
}
function accountClient(account: ApifyAccountContext) {
  const frozen = freezeAccount(account), token = required(accountTokenName(frozen.accountSlot));
  let verified: Promise<void> | undefined;
  const verify = () => verified ??= readWithToken('/users/me', token).then(me => { readIdentity(me, frozen.expectedProviderUserId); });
  return Object.freeze({ verify, token, read: async (path: string) => { await verify(); return readWithToken(path, token); } });
}
export async function apifyRead(path: string, account?: ApifyAccountContext): Promise<unknown> {
  if (account) return accountClient(account).read(path);
  // Legacy read-only diagnostics compatibility; production job callers always supply context.
  return readWithToken(path, required('APIFY_API_TOKEN'));
}
export function safeProviderId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
export async function sha256Body(body: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
export function parseRun(value: unknown): Run {
  const row = object(object(value).data);
  const actorId = typeof row.actId === 'string' ? row.actId : '';
  const userId = typeof row.userId === 'string' ? row.userId : '';
  const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (!safeId(row.id) || !safeId(actorId) || !safeId(userId) ||
      typeof row.status !== 'string' || !['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ABORTING', 'ABORTED', 'TIMING-OUT', 'TIMED-OUT'].includes(row.status) ||
      (row.defaultDatasetId !== undefined && row.defaultDatasetId !== null && !safeId(row.defaultDatasetId)) ||
      (row.defaultKeyValueStoreId !== undefined && row.defaultKeyValueStoreId !== null && !safeId(row.defaultKeyValueStoreId))) throw new Error('Apify run identity incomplete');
  return { id: row.id, actorId, userId, status: row.status,
    defaultDatasetId: typeof row.defaultDatasetId === 'string' ? row.defaultDatasetId : null,
    defaultKeyValueStoreId: typeof row.defaultKeyValueStoreId === 'string' ? row.defaultKeyValueStoreId : null,
    // Do NOT derive actual spend from item counts, pricingInfo, usageUsd components or estimates.
    usageTotalUsd: typeof row.usageTotalUsd === 'number' && Number.isFinite(row.usageTotalUsd) && row.usageTotalUsd >= 0 ? row.usageTotalUsd : null };
}
abstract class ApifyBase {
  abstract actorId: string;
  abstract input(context: Context): Record<string, unknown>;
  abstract normalize(item: unknown, context: Context): { record?: Normalized; error?: ProfileError };
  profile = false;
  private readonly account?: ApifyAccountContext;
  private client?: ReturnType<typeof accountClient>;
  private pinned?: ApifyAccountContext;
  constructor(account?: ApifyAccountContext) { this.account = account ? freezeAccount(account) : undefined; }
  private forJob(job: Job) {
    const account = jobAccount(job, this.account);
    if (this.pinned && (account.accountSlot !== this.pinned.accountSlot || account.expectedProviderUserId !== this.pinned.expectedProviderUserId)) throw new Error('Adapter account is immutable');
    if (!this.client) { this.pinned = account; this.client = accountClient(account); }
    return this.client;
  }
  private forRun() {
    if (!this.client) {
      const account = this.account ?? freezeAccount({ accountSlot: 1, expectedProviderUserId: required('APIFY_ACCOUNT_ID') });
      this.pinned = account; this.client = accountClient(account);
    }
    return this.client;
  }
  async prepare(context: Context, maxChargeUsd: number): Promise<PreparedStart> {
    liveGate(this.profile);
    if (!Number.isFinite(maxChargeUsd) || maxChargeUsd <= 0 || maxChargeUsd > 10000 ||
        maxChargeUsd !== Number(context.job.reserved_usd)) throw new Error('Invalid reserved maximum charge');
    // Everything repeatable happens before SQL crosses the non-idempotent fence.
    const input = this.input(context);
    if (context.job.expected_actor_id !== this.actorId) throw new Error('Claim provider identity mismatch');
    const client = this.forJob(context.job);
    await client.verify();
    const base = new URL(required('SUPABASE_URL'));
    if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Invalid callback configuration');
    const webhookUrl = new URL('/functions/v1/apify-webhook', base);
    webhookUrl.searchParams.set('job_id', context.job.id);
    webhookUrl.searchParams.set('dispatch_nonce', context.job.dispatch_nonce);
    const webhook = [{ eventTypes: ['ACTOR.RUN.CREATED', 'ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED', 'ACTOR.RUN.TIMED_OUT'],
      requestUrl: webhookUrl.href, headersTemplate: JSON.stringify({ 'x-webhook-secret': required('APIFY_WEBHOOK_SHARED_SECRET') }),
      payloadTemplate: '{"run_id": {{resource.id}}}' }];
    const endpoint = new URL(`https://api.apify.com/v2/actors/${encodeURIComponent(this.actorId)}/runs`);
    endpoint.searchParams.set('maxTotalChargeUsd', String(maxChargeUsd));
    endpoint.searchParams.set('webhooks', btoa(JSON.stringify(webhook)));
    const exactBody = JSON.stringify(input), inputDigest = await sha256Body(exactBody);
    // The only durable projection is allowlisted Actor input, not a body/header envelope.
    const inputProjection = Object.freeze(JSON.parse(exactBody) as Record<string, unknown>);
    const address = endpoint.href, token = client.token;
    const expectedActorId = context.job.expected_actor_id, expectedUserId = context.job.expected_provider_user_id;
    let used = false;
    return Object.freeze({ inputDigest, inputProjection, submit: async (authorize: () => Promise<boolean>): Promise<StartOutcome> => {
      if (used) return { kind: 'not_authorized' };
      used = true; // Also consumes a lost authorization ACK: never retry this paid POST.
      let allowed: boolean;
      try { allowed = await authorize(); }
      catch { return { kind: 'authorization_unknown' }; }
      if (allowed !== true) return { kind: 'not_authorized' };
      try {
        const response = await fetch(address, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: exactBody, signal: AbortSignal.timeout(20000) });
        if (!response.ok || response.redirected) { await response.body?.cancel(); return { kind: 'acceptance_unknown' }; }
        const value: unknown = await response.json();
        try {
          const run = parseRun(value);
          if (run.actorId !== expectedActorId || run.userId !== expectedUserId) throw new Error('Unverified metadata');
          return { kind: 'accepted', run };
        } catch {
          const row = object(object(value).data);
          return safeProviderId(row.id) ? { kind: 'accepted_hint', runId: row.id } : { kind: 'acceptance_unknown' };
        }
      } catch { return { kind: 'acceptance_unknown' }; }
    } });
  }
  async start(context: Context, maxChargeUsd: number, authorize?: () => Promise<boolean>): Promise<Run> {
    const prepared = await this.prepare(context, maxChargeUsd);
    // Missing SQL authority is never a legacy bypass for direct adapter callers.
    if (!authorize) throw new Error('Transactional collection submit authorization required');
    const outcome = await prepared.submit(authorize);
    if (outcome.kind !== 'accepted') throw new Error('Apify start acceptance uncertain');
    return outcome.run;
  }
  async run(id: string): Promise<Run> { return parseRun(await this.forRun().read(`/actor-runs/${encodeURIComponent(id)}`)); }
  async page(context: Context, limit: number): Promise<Page> {
    const client = this.forJob(context.job);
    if (!context.job.dataset_id) return { items: [], next: context.job.dataset_cursor, finished: true };
    const items = await client.read(`/datasets/${encodeURIComponent(context.job.dataset_id)}/items?format=json&clean=true&offset=${context.job.dataset_cursor}&limit=${limit}`);
    if (!Array.isArray(items) || items.length > limit) throw new Error('Invalid dataset page');
    return { items, next: context.job.dataset_cursor + items.length, finished: items.length < limit };
  }
  async summary(context: Context, verifiedRun?: Run): Promise<OutputSummary> {
    const client = this.forJob(context.job);
    if (!context.job.actor_run_id) return unavailableSummary(context, 'output_run_missing');
    const run = verifiedRun ?? await this.run(context.job.actor_run_id);
    if (run.id !== context.job.actor_run_id || run.actorId !== context.job.expected_actor_id || run.userId !== context.job.expected_provider_user_id) throw new Error('OUTPUT run identity mismatch');
    if (!run.defaultKeyValueStoreId) return unavailableSummary(context, 'output_store_missing');
    const output = await client.read(`/key-value-stores/${encodeURIComponent(run.defaultKeyValueStoreId)}/records/OUTPUT`);
    if (this.profile) {
      // This Actor reports aggregate profile counters, not the Reels users/count
      // contract. Prove coverage with its counters AND the exact bounded dataset.
      try {
        if (run.status !== 'SUCCEEDED' || !context.job.dataset_finished || !context.job.dataset_id || run.defaultDatasetId !== context.job.dataset_id ||
            context.creators.length < 1 || context.creators.length > 20 || context.job.dataset_cursor !== context.creators.length) return unavailableSummary(context, 'profile_output_contract_unverified');
        const evidence = object(output), n = context.creators.length;
        if (evidence.results !== n || evidence.profilesFound !== n || evidence.statsRead !== n || evidence.detailsRead !== n ||
            evidence.statsUnavailable !== 0 || evidence.detailsUnavailable !== 0 || evidence.costStateUnreadable !== false) return unavailableSummary(context, 'profile_output_contract_unverified');
        const metadata = object(object(await client.read(`/datasets/${encodeURIComponent(context.job.dataset_id)}`)).data);
        if (metadata.id !== context.job.dataset_id || metadata.userId !== context.job.expected_provider_user_id || metadata.itemCount !== n) return unavailableSummary(context, 'profile_output_contract_unverified');
        const records = await client.read(`/datasets/${encodeURIComponent(context.job.dataset_id)}/items?format=json&clean=true&offset=0&limit=${n + 1}`);
        if (!Array.isArray(records) || records.length !== n) return unavailableSummary(context, 'profile_output_contract_unverified');
        const seen = new Set<string>();
        for (const item of records) {
          const row = object(item), creator = profileIdentity(row, context), normalized = this.normalize(row, context);
          if (row.error || row.errorDescription || seen.has(creator.id) || !normalized.record || normalized.error || normalized.record.creator_id !== creator.id) return unavailableSummary(context, 'profile_output_contract_unverified');
          seen.add(creator.id);
        }
        if (seen.size !== n) return unavailableSummary(context, 'profile_output_contract_unverified');
        return { ok: true, total_items: n, users: context.creators.map(creator => ({ creator_id: creator.id, username: creator.username, count: 1, error: null })), complete: true, reason: null };
      } catch { return unavailableSummary(context, 'profile_output_contract_unverified'); }
    }
    const summary = reconcileOutput(output, context);
    if (summary.complete || !['discovery', 'carousel'].includes(context.job.kind) || context.creators.length !== 1 ||
        context.job.dataset_cursor !== 1 || !context.job.dataset_finished || run.status !== 'SUCCEEDED' ||
        !context.job.dataset_id || run.defaultDatasetId !== context.job.dataset_id) return summary;
    const row = object(output);
    if (row.ok !== true || row.total_items !== 0 || row.charge_limit_reached === true ||
        !Array.isArray(row.users) || row.users.length !== 1) return summary;
    const user = object(row.users[0]);
    if (user.count !== 0 || user.error || identity(user.user, context).id !== context.creators[0].id) return summary;
    // Photo/Reel feeds can omit no_items from OUTPUT while delivering one placeholder.
    // Re-read that exact run's bounded dataset; an empty count alone is not proof.
    const items = await client.read(`/datasets/${encodeURIComponent(context.job.dataset_id)}/items?format=json&clean=true&offset=0&limit=2`);
    if (!Array.isArray(items) || items.length !== 1) return summary;
    const item = object(items[0]);
    if (item.error !== 'no_items' || identity(item.ownerUsername, context).id !== context.creators[0].id) return summary;
    return reconcileOutput({ ...row, users: [{ ...user, error: 'no_items' }] }, context);
  }
}
function usernames(context: Context): string[] {
  if (!context.creators.length || context.creators.length > 20) throw new Error('Invalid creator batch');
  const names = context.creators.map((c) => c.username);
  if (names.some((name) => !/^[a-z0-9._]{1,30}$/.test(name)) || new Set(names).size !== names.length) throw new Error('Invalid creator username');
  return names;
}
export function unavailableSummary(context: Context, reason: string): OutputSummary {
  return { ok: false, total_items: null, users: context.creators.map((c) => ({ creator_id: c.id, username: c.username, count: null, error: reason })), complete: false, reason };
}
function boundedDiscoveryWindow(job: Job): boolean {
  return job.kind === 'discovery' && job.discovery_bounded === true && job.results_limit === 50;
}
function boundedMetricsWindow(job: Job): boolean {
  return job.kind === 'metrics' && Number.isSafeInteger(job.metrics_tracked_count) && Number(job.metrics_tracked_count) > 0 &&
    job.results_limit === Math.min(Number(job.metrics_tracked_count) + 50, 10000);
}
export function reconcileOutput(value: unknown, context: Context): OutputSummary {
  try {
    const row = object(value);
    if (typeof row.ok !== 'boolean' || !Number.isSafeInteger(row.total_items) || Number(row.total_items) < 0 || !Array.isArray(row.users) || row.users.length > 100) return unavailableSummary(context, 'output_schema_invalid');
    const workflow = ['discovery', 'metrics'].includes(context.job.kind);
    const emptyRows = ['discovery','carousel'].includes(context.job.kind) ? row.users.filter(item => {
      const user = object(item); return user.error === 'no_items' && user.count === 0;
    }).length : 0;
    const reportedCount = row.users.reduce((sum, item) => sum + Number(object(item).count), 0);
    const emptyPlaceholders = emptyRows > 0 && context.job.dataset_cursor - reportedCount === emptyRows;
    const users: OutputSummary['users'] = [];
    const seen = new Set<string>();
    let complete = row.ok && (row.total_items === context.job.dataset_cursor || emptyRows > 0 && Number(row.total_items) + emptyRows === context.job.dataset_cursor)
      && (!(workflow || context.job.kind === 'carousel') || row.charge_limit_reached !== true);
    for (const item of row.users) {
      const user = object(item), creator = identity(user.user, context);
      if (seen.has(creator.id) || !Number.isSafeInteger(user.count) || Number(user.count) < 0) return unavailableSummary(context, 'output_identity_or_count_invalid');
      seen.add(creator.id);
      const empty = ['discovery','carousel'].includes(context.job.kind) && user.error === 'no_items' && (user.count === 0 || user.count === 1);
      const error = user.error && !empty ? 'provider_output_profile_error' : null;
      if (error) complete = false;
      // A no_items dataset row occupies a cursor position, but imports no Reel.
      users.push({ creator_id: creator.id, username: creator.username, count: empty && user.count === 0 && emptyPlaceholders ? 1 : Number(user.count), error });
      // Bounded metrics completeness comes from frozen target coverage in SQL,
      // not feed exhaustion. Hitting that intentional window must not force a retry.
      if (workflow && !boundedMetricsWindow(context.job) && !boundedDiscoveryWindow(context.job) && Number(user.count) >= context.job.results_limit) complete = false;
      if ((boundedMetricsWindow(context.job) || boundedDiscoveryWindow(context.job)) && Number(user.count) > context.job.results_limit) complete = false;
    }
    if (seen.size !== context.creators.length || users.reduce((sum, user) => sum + Number(user.count), 0) !== context.job.dataset_cursor) complete = false;
    for (const creator of context.creators) if (!seen.has(creator.id)) users.push({ creator_id: creator.id, username: creator.username, count: null, error: 'output_profile_missing' });
    // Only an otherwise exact, error-free OUTPUT/dataset reconciliation earns
    // the intentional cap reason. Charge/schema/profile errors retain retries.
    const discoveryCapped = complete && boundedDiscoveryWindow(context.job) && context.creators.length === 1 &&
      context.job.dataset_finished && context.job.dataset_cursor === 50 && users.length === 1 && users[0].count === 50;
    return { ok: row.ok, total_items: emptyRows ? context.job.dataset_cursor : Number(row.total_items), users,
      complete: complete && !discoveryCapped, reason: discoveryCapped ? 'discovery_window_capped' : complete ? null : 'output_incomplete_or_error' };
  } catch { return unavailableSummary(context, 'output_schema_or_identity_invalid'); }
}
export class ApifyReels extends ApifyBase implements ReelProvider {
  kind = 'reel' as const;
  // Resource ID must be the resolved Actor actId, not a different owner/account's opaque ID.
  actorId = required('APIFY_REEL_ACTOR_RESOURCE_ID');
  input(context: Context): Record<string, unknown> {
    const workflow = ['discovery', 'metrics'].includes(context.job.kind);
    if (!Number.isSafeInteger(context.job.results_limit) || context.job.results_limit < 10 || context.job.results_limit > (workflow ? 10000 : 100)) throw new Error('Reels results_limit is outside the supported profile window');
    if (workflow && (context.creators.length !== 1 || !context.job.competitor_run_id)) throw new Error('Durable workflow context required');
    if (context.job.kind === 'metrics' && !boundedMetricsWindow(context.job)) throw new Error('Frozen tracked Reels + 50 metrics window required');
    if (context.job.kind === 'discovery' && !boundedDiscoveryWindow(context.job)) throw new Error('Bounded 50-Reel discovery window required');
    const since = workflow ? context.job.collection_since : null;
    if (since && (!Number.isFinite(Date.parse(since)) || Date.parse(since) > Date.now())) throw new Error('Invalid collection cutoff');
    // The Actor documents an empty selection as ALL fields. Keep complete source
    // details in its dataset; normalize only the fields our application supports.
    return { directUrls: usernames(context), resultsType: 'reels', resultsLimit: context.job.results_limit,
      skipPinnedPosts: !workflow && context.job.kind !== 'backfill' && !(context.job.kind === 'manual' && context.job.results_limit === 100),
      ...(since ? { onlyPostsNewerThan: new Date(since).toISOString() } : {}),
      selectedFields: [] };
  }
  normalize(item: unknown, context: Context): { record?: Normalized; error?: ProfileError } { return normalizeReel(item, context, 'apify:esdrasdw/instagram-reels-scrapy-low-cost'); }
}
function profileInputSetup(): Record<string, unknown> {
  const base = env('PROFILE_INPUT_BASE_JSON').trim();
  const key = env('PROFILE_INPUT_USERNAMES_KEY').trim() || 'usernames';
  const format = env('PROFILE_INPUT_FORMAT').trim() || 'usernames';
  if (key !== 'usernames' || format !== 'usernames') throw new Error('Profile input must use documented usernames');
  return base ? object(JSON.parse(base)) : {};
}
function profileOutputMapping(): Record<string, unknown> {
  const configured = env('PROFILE_OUTPUT_MAPPING_JSON').trim();
  const mapping = object(JSON.parse(configured || '{"username":"username","followers":"followersCount","display_name":"fullName","avatar_url":"profilePicUrl"}'));
  if (typeof mapping.username !== 'string' || typeof mapping.followers !== 'string') throw new Error('Profile output identity/follower mapping missing');
  for (const key of ['username', 'followers', 'display_name', 'avatar_url']) {
    const path = mapping[key];
    if (path === undefined && ['display_name', 'avatar_url'].includes(key)) continue;
    if (typeof path !== 'string' || path.length > 200 || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path) ||
        path.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('Profile output mapping path invalid');
  }
  return mapping;
}
export function profileIdentity(row: Record<string, unknown>, context: Context) {
  return identity(context.job.live ? field(row, String(profileOutputMapping().username)) : row.username, context);
}
export class ApifyProfiles extends ApifyBase implements ProfileProvider {
  kind = 'profile' as const;
  override profile = true;
  actorId = required('APIFY_PROFILE_ACTOR_RESOURCE_ID');
  input(context: Context): Record<string, unknown> {
    if (env('PROFILE_PROVIDER_VALIDATED') !== 'true') throw new Error('Profile mapping blocked');
    const names = usernames(context);
    const base = profileInputSetup();
    // Explicit documented minimal-profile inputs override stale enrichment settings.
    return { proxyConfiguration: base.proxyConfiguration ?? { useApifyProxy: true }, usernames: names, mode: 'profiles', maxResults: names.length,
      includeLatestPosts: false, includeReels: false, includeContactDetails: false,
      includeStats: true, includeDetails: true, includeProfileRecord: true,
      includeVideoViews: false, includeCompatibilityKeys: false };
  }
  normalize(item: unknown, context: Context): { record?: Normalized; error?: ProfileError } {
    const row = object(item);
    const mapping = profileOutputMapping();
    const creator = profileIdentity(row, context), followers = metric(field(row, String(mapping.followers)));
    if (followers.state !== 'known') return { error: { creator_id: creator.id, status: 'failed', message: 'Follower count missing/invalid; no invented denominator' } };
    return { record: { creator_id: creator.id, username: creator.username, followers_count: followers.value, fetched_at: context.job.result_fetched_at ?? context.job.started_at,
      provider: `apify:${this.actorId}`, display_name: typeof mapping.display_name === 'string' && typeof field(row, mapping.display_name) === 'string' ? String(field(row, mapping.display_name)).slice(0, 200) : null,
      avatar_url: typeof mapping.avatar_url === 'string' ? publicUrl(field(row, mapping.avatar_url)) : null } };
  }
}
function initialCarouselWindow(context: Context): boolean {
  const job = context.job;
  if (job.carousel_initial !== true && job.results_limit !== 50) return false;
  const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  // Provenance is supplied by the trusted DB claim. SQL independently binds the
  // durable initial request to this owner/job and its one canonical creator.
  if (job.kind !== 'carousel' || job.results_limit !== 50 || job.carousel_initial !== true || job.carousel_automatic !== true ||
      !uuid(job.id) || !uuid(job.owner_user_id) || !uuid(job.manual_authorized_by) || job.manual_authorized_by !== job.owner_user_id ||
      !uuid(job.carousel_initial_request_id) || job.requested_profiles_count !== 1 || context.creators.length !== 1 || !uuid(context.creators[0].id) ||
      !['ordinary', 'operator_settle'].includes(job.collection_source ?? '') || isCarouselPilotJob(job.id)) {
    throw new Error('Invalid initial carousel collection window');
  }
  usernames(context);
  return true;
}
function initialCarouselCursor(context: Context): number {
  const cursor = context.job.dataset_cursor;
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 50) throw new Error('Initial carousel dataset cursor exceeds the requested window');
  return cursor;
}
export class ApifyCarousels extends ApifyBase implements CarouselProvider {
  kind='carousel' as const;
  actorId=required('APIFY_REEL_ACTOR_RESOURCE_ID');
  input(context: Context): Record<string,unknown> {
    if (env('CAROUSEL_PROVIDER_VALIDATED')!=='true') {
      if (!isCarouselPilotJob(context.job.id)) throw new Error('Carousel mapping blocked');
      validateCarouselPilotSetup(context.job.id);
      if (Number(context.job.reserved_usd)<=0 || Number(context.job.reserved_usd)>.10 || !Number.isFinite(Number(context.job.reserved_usd))) throw new Error('Invalid carousel pilot cap');
    }
    const initial = initialCarouselWindow(context);
    if (context.job.kind!=='carousel' || context.job.results_limit!==(initial ? 50 : 30) || context.creators.length!==1) throw new Error('Invalid carousel collection window');
    if (initial) initialCarouselCursor(context);
    return {directUrls:usernames(context),resultsType:'photos',resultsLimit:initial ? 50 : 30,skipPinnedPosts:initial,selectedFields:[]};
  }
  override async page(context: Context, limit: number): Promise<Page> {
    if (!initialCarouselWindow(context)) return super.page(context, limit);
    const cursor = initialCarouselCursor(context);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid initial carousel dataset page limit');
    const remaining = 50 - cursor;
    if (remaining === 0) return { items: [], next: cursor, finished: true };
    // The initial window bounds raw photo rows, including singles/error rows;
    // never request more history to manufacture 50 accepted carousels.
    const page = await super.page(context, Math.min(limit, remaining));
    return { ...page, finished: page.finished || page.next === 50 };
  }
  override async summary(context: Context, verifiedRun?: Run): Promise<OutputSummary> {
    if (initialCarouselWindow(context)) initialCarouselCursor(context);
    // complete describes exact uncapped OUTPUT/dataset reconciliation, not source
    // exhaustion or a promise of 50 valid carousel records in the photos feed.
    return super.summary(context, verifiedRun);
  }
  normalize(item: unknown, context: Context) { return normalizeCarousel(item,context,'apify:esdrasdw/instagram-reels-scrapy-low-cost'); }
}
async function prepareMockStart(run: Run): Promise<PreparedStart> {
  assertMockSetup();
  let used = false;
  return Object.freeze({ inputDigest: await sha256Body('{}'), inputProjection: Object.freeze({}),
    submit: async (authorize: () => Promise<boolean>): Promise<StartOutcome> => {
      assertMockSetup();
      if (used) return { kind: 'not_authorized' };
      used = true;
      try { return await authorize() === true ? { kind: 'accepted', run } : { kind: 'not_authorized' }; }
      catch { return { kind: 'authorization_unknown' }; }
    } });
}
export class MockReels implements ReelProvider {
  constructor() { assertMockSetup(); }
  kind = 'reel' as const; actorId = 'mock-reels';
  async prepare(context: Context, _maxCharge: number): Promise<PreparedStart> { return prepareMockStart(await this.run(`mock:${context.job.id}`)); }
  async start(context: Context, _maxCharge: number): Promise<Run> { assertMockSetup(); return this.run(`mock:${context.job.id}`); }
  async run(id: string): Promise<Run> { assertMockSetup(); return { id, actorId: this.actorId, userId: 'mock', status: 'SUCCEEDED', defaultDatasetId: null, usageTotalUsd: 0 }; }
  async page(context: Context, limit: number): Promise<Page> {
    assertMockSetup();
    const all = context.creators.map((c) => ({ ownerUsername: c.username, id: null, url: `https://www.instagram.com/reel/mock_${c.id.replaceAll('-', '')}/`, timestamp: context.job.started_at,
      title: 'Synthetic ReelRadar worker fixture — not verified Instagram data', videoPlayCount: 1000, likesCount: -1, commentsCount: 0 }));
    const items = all.slice(context.job.dataset_cursor, context.job.dataset_cursor + limit);
    return { items, next: context.job.dataset_cursor + items.length, finished: context.job.dataset_cursor + items.length >= all.length };
  }
  async summary(context: Context): Promise<OutputSummary> {
    assertMockSetup();
    return { ok: true, total_items: context.job.dataset_cursor, users: context.creators.map((c) => ({ creator_id: c.id, username: c.username, count: 1, error: null })), complete: true, reason: null };
  }
  normalize(item: unknown, context: Context): { record?: Normalized; error?: ProfileError } {
    assertMockSetup();
    const result = normalizeReel(item, context, 'mock:synthetic');
    if (result.record) result.record.reel_url = null;
    return result;
  }
}
export class MockProfiles implements ProfileProvider {
  constructor() { assertMockSetup(); }
  kind = 'profile' as const; actorId = 'mock-profiles';
  async prepare(context: Context, _maxCharge: number): Promise<PreparedStart> { return prepareMockStart(await this.run(`mock:${context.job.id}`)); }
  async start(context: Context, _maxCharge: number): Promise<Run> { assertMockSetup(); return this.run(`mock:${context.job.id}`); }
  async run(id: string): Promise<Run> { assertMockSetup(); return { id, actorId: this.actorId, userId: 'mock', status: 'SUCCEEDED', defaultDatasetId: null, usageTotalUsd: 0 }; }
  async page(context: Context, limit: number): Promise<Page> {
    assertMockSetup();
    const items = context.creators.slice(context.job.dataset_cursor, context.job.dataset_cursor + limit);
    return { items, next: context.job.dataset_cursor + items.length, finished: context.job.dataset_cursor + items.length >= context.creators.length };
  }
  async summary(context: Context): Promise<OutputSummary> {
    assertMockSetup();
    return { ok: true, total_items: context.job.dataset_cursor, users: context.creators.map((c) => ({ creator_id: c.id, username: c.username, count: 1, error: null })), complete: true, reason: null };
  }
  normalize(item: unknown, context: Context): { record?: Normalized; error?: ProfileError } {
    assertMockSetup();
    const row = object(item), creator = identity(row.username, context);
    return { record: { creator_id: creator.id, username: creator.username, followers_count: 100, fetched_at: context.job.result_fetched_at ?? context.job.started_at, provider: 'mock:synthetic' } };
  }
}
export class MockCarousels implements CarouselProvider {
  constructor() { assertMockSetup(); }
  kind='carousel' as const; actorId='mock-carousels';
  async prepare(context: Context, _maxCharge: number): Promise<PreparedStart> { return prepareMockStart(await this.run('mock:'+context.job.id)); }
  async start(context: Context, _maxCharge: number): Promise<Run> { assertMockSetup(); return this.run('mock:'+context.job.id); }
  async run(id: string): Promise<Run> { assertMockSetup(); return {id,actorId:this.actorId,userId:'mock',status:'SUCCEEDED',defaultDatasetId:null,usageTotalUsd:0}; }
  async page(context: Context, limit: number): Promise<Page> {
    assertMockSetup();
    const all=context.creators.map(c=>({ownerUsername:c.username,type:8,productType:'carousel_container',
      url:'https://www.instagram.com/p/mock_'+c.id.replaceAll('-','')+'/',timestamp:context.job.started_at,caption:'Synthetic carousel fixture — not verified Instagram data',
      likesCount:100,commentsCount:0,childPosts:[{type:1},{type:1}]}));
    const items=all.slice(context.job.dataset_cursor,context.job.dataset_cursor+limit);
    return {items,next:context.job.dataset_cursor+items.length,finished:context.job.dataset_cursor+items.length>=all.length};
  }
  async summary(context: Context): Promise<OutputSummary> {
    assertMockSetup(); return {ok:true,total_items:context.job.dataset_cursor,users:context.creators.map(c=>({creator_id:c.id,username:c.username,count:1,error:null})),complete:true,reason:null};
  }
  normalize(item: unknown, context: Context) {
    assertMockSetup(); const result=normalizeCarousel(item,context,'mock:synthetic');
    if (result.record) result.record.reel_url=null; return result;
  }
}
export function provider(kind: string, live = liveMode(), account?: ApifyAccountContext): ReelProvider | ProfileProvider | CarouselProvider {
  if (!['daily', 'weekly', 'backfill', 'profile', 'manual', 'retry', 'discovery', 'metrics', 'carousel'].includes(kind)) throw new Error('Unsupported provider job kind');
  if (kind==='carousel') return live ? new ApifyCarousels(account) : new MockCarousels();
  return live ? kind === 'profile' ? new ApifyProfiles(account) : new ApifyReels(account) : kind === 'profile' ? new MockProfiles() : new MockReels();
}
export function parseAccountUsage(me: unknown, limits: unknown, now = Date.now(), expectedId: string | null = env('APIFY_ACCOUNT_ID') || null): AccountUsage {
  const user = object(object(me).data), account = object(object(limits).data);
  const cycle = object(account.monthlyUsageCycle), current = object(account.current), ceilings = object(account.limits);
  const cycleStart = zonedTimestamp(cycle.startAt), cycleEnd = zonedTimestamp(cycle.endAt);
  const usageUsd = current.monthlyUsageUsd, limitUsd = ceilings.maxMonthlyUsageUsd;
  const userId = readIdentity(me, expectedId);
  if (!cycleStart || !cycleEnd || Date.parse(cycleStart) > now || Date.parse(cycleEnd) <= now || Date.parse(cycleStart) >= Date.parse(cycleEnd) || typeof usageUsd !== 'number' || !Number.isFinite(usageUsd) || usageUsd < 0 || typeof limitUsd !== 'number' || !Number.isFinite(limitUsd) || limitUsd < 0) throw new Error('Current authoritative account usage/limit unavailable');
  const result: AccountUsage = { userId, cycleStart, cycleEnd, usageUsd, limitUsd };
  if (user.plan && typeof user.plan === 'object' && !Array.isArray(user.plan)) {
    const plan = object(user.plan); result.plan = {};
    if (typeof plan.tier === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(plan.tier)) result.plan.tier = plan.tier;
    if (typeof plan.monthlyUsageCreditsUsd === 'number' && Number.isFinite(plan.monthlyUsageCreditsUsd) && plan.monthlyUsageCreditsUsd >= 0) result.plan.monthlyUsageCreditsUsd = plan.monthlyUsageCreditsUsd;
  }
  return result;
}
export async function authoritativeUsage(slot: ApifyAccountSlot = 1, expectedId: string | null = env('APIFY_ACCOUNT_ID') || null, observation?: AccountUsageObservation): Promise<AccountUsage> {
  // Bootstrap explicitly supplies null. Established registry reads must supply their exact ID.
  // Preserve DB timestamp precision and pin the checkpoint BEFORE any provider await.
  const checkpoint = observation ? Object.freeze({ ...observation }) : undefined;
  if (checkpoint && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(checkpoint.observationId) || !zonedTimestamp(checkpoint.observedAt))) throw new Error('Invalid account usage checkpoint');
  const token = required(accountTokenName(slot));
  const me = await readWithToken('/users/me', token);
  readIdentity(me, expectedId);
  const limits = await readWithToken('/users/me/limits', token);
  return { ...parseAccountUsage(me, limits, Date.now(), expectedId), ...checkpoint };
}
export function validateDispatchSetup(): void {
  if (!liveMode()) return;
  liveGate(); required('APIFY_REEL_ACTOR_RESOURCE_ID'); required('APIFY_WEBHOOK_SHARED_SECRET');
  if (env('PROFILE_PROVIDER_VALIDATED') !== 'true') {
    // Reel jobs remain possible; profile jobs are explicitly blocked separately before claiming.
  }
}
export function validateProfileSetup(kind: string): void {
  if (!liveMode()) return;
  if (kind === 'profile') { liveGate(true); required('APIFY_PROFILE_ACTOR_RESOURCE_ID'); profileInputSetup(); profileOutputMapping(); }
  if (kind === 'carousel' && env('CAROUSEL_PROVIDER_VALIDATED')!=='true') throw new Error('Carousel mapping blocked');
}
export function isCarouselPilotJob(jobId: unknown): jobId is string {
  const selected = env('CAROUSEL_PILOT_JOB_ID');
  return typeof jobId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(selected)
    && jobId.toLowerCase() === selected.toLowerCase();
}
export function validateCarouselPilotSetup(jobId: unknown): void {
  if (!liveMode() || !isCarouselPilotJob(jobId)) throw new Error('Carousel pilot job not enabled');
  validateDispatchSetup();
}

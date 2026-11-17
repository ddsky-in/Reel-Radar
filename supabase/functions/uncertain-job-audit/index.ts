const origin = 'https://project.supabase.co';
const owner = '43292213-87a3-4000-8000-9d779fbe6659';
const workspace = 'f9471264-510a-4000-8000-7a66fb73866f';
const expiresAt = Date.parse('2026-11-16T07:30:00Z');
const actor = 'synthetic_88168e63af90';
const pins = [
  { id: 'd8817ff8-10d8-4000-8000-edb3e96298f4', slot: 1, user: 'synthetic_b9f2605e24e3', kind: 'metrics', username: 'synthetic_f05877d0f3cd', nonce: '9ff6f18c-bcae-4000-8000-8449f68cb1a5', started: '2026-11-13T14:23:48.972496Z' },
  { id: 'e02b7054-ffda-4000-8000-b3b4f090c045', slot: 2, user: 'synthetic_68f159e063d2', kind: 'metrics', username: 'synthetic_af88aff3e4b6', nonce: '34c98f8f-5262-4000-8000-b1deb10fa28f', started: '2026-11-15T08:17:38.568660Z' },
  { id: 'e5adbea1-2892-4000-8000-53937ec86da7', slot: 3, user: 'synthetic_9a8eef2b755b', kind: 'carousel', username: 'synthetic_fa5187f9f1bb', nonce: '3233b414-86ea-4000-8000-1d6ff2734f1b', started: '2026-11-15T07:31:00.818521Z' },
] as const;
type Pin = typeof pins[number];
type Row = Record<string, unknown>;
const ids = /^[A-Za-z0-9_-]{1,128}$/;
const statuses = ['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ABORTING', 'ABORTED', 'TIMING-OUT', 'TIMED-OUT'];
const events = ['ACTOR.RUN.CREATED', 'ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED', 'ACTOR.RUN.TIMED_OUT'];
const env = (name: string) => Deno.env.get(name) ?? '';
const object = (value: unknown): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuditError('invalid_metadata');
  return value as Row;
};
const time = (value: unknown): number | null => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const safeId = (value: unknown): value is string => typeof value === 'string' && ids.test(value);
class AuditError extends Error {
  constructor(readonly stage: string, readonly status: number | null = null) { super('Audit unavailable'); }
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
async function authenticated(request: Request): Promise<boolean> {
  const expected = env('INTERNAL_CRON_SECRET'), supplied = request.headers.get('x-internal-secret') ?? '';
  if (request.method !== 'POST' || !expected || !supplied || supplied.length > 1024) return false;
  const encoder = new TextEncoder();
  const hashes = await Promise.all([expected, supplied].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const left = new Uint8Array(hashes[0]), right = new Uint8Array(hashes[1]); let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}
async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > maximum || !response.body) {
    await response.body?.cancel(); throw new AuditError('response_limit');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    length += part.value.length;
    if (length > maximum) { await reader.cancel(); throw new AuditError('response_limit'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AuditError('invalid_json'); }
}
function callbackMatches(value: unknown, pin: Pin): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password && !url.hash && url.pathname === '/functions/v1/apify-webhook' &&
      url.searchParams.getAll('job_id').length === 1 && url.searchParams.get('job_id') === pin.id &&
      url.searchParams.getAll('dispatch_nonce').length === 1 && url.searchParams.get('dispatch_nonce') === pin.nonce &&
      [...url.searchParams.keys()].every(key => ['job_id', 'dispatch_nonce'].includes(key));
  } catch { return false; }
}
function hookRun(hook: Row, pin: Pin): string | null {
  if (hook.userId !== undefined && hook.userId !== pin.user || hook.actionType !== 'HTTP_REQUEST' || !callbackMatches(hook.requestUrl, pin)) return null;
  const condition = hook.condition;
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return null;
  const row = condition as Row;
  if (!safeId(row.actorRunId) || row.actorId != null && row.actorId !== actor || row.actorTaskId != null) return null;
  return row.actorRunId;
}
function receiptRun(receipt: Row, pin: Pin): string | null {
  if (!safeId(receipt.id) || receipt.userId !== pin.user || time(receipt.createdAt) === null || !events.includes(String(receipt.eventType)) ||
      !receipt.webhook || !receipt.eventData) return null;
  const event = object(receipt.eventData), runId = hookRun(object(receipt.webhook), pin);
  return event.actorId === actor && event.actorRunId === runId ? runId : null;
}
function inputProjection(value: unknown, pin: Pin, limit: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { available: false, matches_requested_input: false };
  const row = value as Row;
  const usernames = Array.isArray(row.directUrls) && row.directUrls.length <= 20 ? row.directUrls.map(value => {
    if (typeof value !== 'string') return null;
    if (/^[a-z0-9._]{1,30}$/i.test(value)) return value.toLowerCase();
    try { const url = new URL(value); return ['instagram.com', 'www.instagram.com'].includes(url.hostname) && url.protocol === 'https:' && !url.username && !url.password ? url.pathname.replace(/^\/|\/$/g, '').toLowerCase() : null; } catch { return null; }
  }) : [];
  const usernameMatches = usernames.length === 1 && usernames[0] === pin.username;
  const typeMatches = row.resultsType === (pin.kind === 'carousel' ? 'photos' : 'reels');
  const limitMatches = row.resultsLimit === limit;
  return { available: true, username_matches: usernameMatches, results_type_matches: typeMatches, results_limit_matches: limitMatches,
    matches_requested_input: usernameMatches && typeMatches && limitMatches };
}
export async function handler(request: Request): Promise<Response> {
  if (!await authenticated(request)) return json({ error: 'unauthorized' }, 401);
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) return json({ error: 'audit_expired', read_only: true }, 410);
  let stage = 'request';
  try {
    if (!request.headers.get('content-type')?.includes('application/json')) return json({ error: 'invalid_request' }, 400);
    const input = object(await boundedJson(new Response(request.body), 2048));
    const pin = pins.find(pin => pin.id === input.job_id), mode = input.mode;
    const offset = input.offset === undefined ? 0 : input.offset, limit = mode === 'runs' ? 10 : 100;
    if (!pin || typeof mode !== 'string' || !['runs', 'webhooks', 'receipts', 'callbacks'].includes(mode) ||
        Object.keys(input).some(key => !['job_id', 'mode', 'offset'].includes(key)) || typeof offset !== 'number' || !Number.isSafeInteger(offset) ||
        offset < 0 || offset > 10000 || offset % limit !== 0 || mode === 'callbacks' && offset !== 0) return json({ error: 'invalid_audit_scope' }, 400);
    if (env('SUPABASE_URL') !== origin || env('REELRADAR_OWNER_USER_ID') !== owner || env('PROVIDER_MODE') !== 'apify') throw new AuditError('configuration');
    const deadline = Math.min(expiresAt, Date.now() + 70000); let calls = 0;
    const get = async (url: string, headers: Record<string, string>, label: string, optional = false): Promise<unknown> => {
      stage = label;
      if (Date.now() >= deadline || ++calls > 45) throw new AuditError('audit_bound');
      const response = await fetch(url, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(Math.min(10000, deadline - Date.now())) });
      if (optional && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw new AuditError(label, response.status); }
      return boundedJson(response, 1024 * 1024);
    };
    const key = env('SUPABASE_SERVICE_ROLE_KEY'); if (!key) throw new AuditError('configuration');
    const db = (table: string, query: string) => get(`${origin}/rest/v1/${table}?${query}`, { apikey: key, Authorization: `Bearer ${key}` }, `database_${table}`);
    const memberships = await db('workspace_members', `select=role&workspace_id=eq.${workspace}&user_id=eq.${owner}&role=eq.owner&limit=2`);
    const workspaces = await db('workspaces', `select=id&owner_user_id=eq.${owner}&id=eq.${workspace}&archived_at=is.null&limit=2`);
    if (!Array.isArray(memberships) || memberships.length !== 1 || object(memberships[0]).role !== 'owner' || !Array.isArray(workspaces) || workspaces.length !== 1 || object(workspaces[0]).id !== workspace) throw new AuditError('owner_authorization');
    const jobs = await db('scrape_jobs', `select=id,owner_user_id,live,status,kind,actor_run_id,dispatch_nonce,started_at,expected_actor_id,expected_provider_user_id,apify_account_slot,results_limit&owner_user_id=eq.${owner}&id=eq.${pin.id}&limit=2`);
    if (!Array.isArray(jobs) || jobs.length !== 1) throw new AuditError('job_scope');
    const job = object(jobs[0]);
    if (job.id !== pin.id || job.owner_user_id !== owner || job.live !== true || job.status !== 'uncertain' || job.actor_run_id !== null ||
        job.kind !== pin.kind || job.dispatch_nonce !== pin.nonce || job.expected_actor_id !== actor || job.expected_provider_user_id !== pin.user ||
        job.apify_account_slot !== pin.slot || time(job.started_at) !== time(pin.started)) throw new AuditError('job_pin_changed');
    const accounts = await db('apify_accounts', `select=slot,provider_user_id,authorization_confirmed&owner_id=eq.${owner}&slot=eq.${pin.slot}&limit=2`);
    if (!Array.isArray(accounts) || accounts.length !== 1 || object(accounts[0]).slot !== pin.slot || object(accounts[0]).provider_user_id !== pin.user || object(accounts[0]).authorization_confirmed !== true) throw new AuditError('account_pin_changed');
    const token = env(pin.slot === 1 ? 'APIFY_API_TOKEN' : `APIFY_API_TOKEN_${pin.slot}`);
    if (!token) throw new AuditError('account_token_missing');
    const apify = (path: string, label: string, optional = false) => {
      if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) throw new AuditError('invalid_path');
      return get(`https://api.apify.com/v2${path}`, { Authorization: `Bearer ${token}` }, label, optional);
    };
    const me = object(object(await apify('/users/me', 'account_identity')).data);
    if (me.id !== pin.user) throw new AuditError('account_identity_mismatch');
    const base = { job_id: pin.id, account_slot: pin.slot, account_identity_verified: true, mode, offset, read_only: true, no_start_proven: false };
    const start = Date.parse(pin.started), from = new Date(start - 900000).toISOString(), until = new Date(start + 900000).toISOString();
    if (mode === 'callbacks') {
      const records = await db('scrape_callback_receipts', `select=run_id,state,dispatch_nonce,expected_actor_id,expected_provider_user_id&owner_user_id=eq.${owner}&job_id=eq.${pin.id}&limit=100`);
      if (!Array.isArray(records) || records.length > 100) throw new AuditError('callback_metadata');
      const matching = records.map(object).filter(row => row.dispatch_nonce === pin.nonce && row.expected_actor_id === actor && row.expected_provider_user_id === pin.user && safeId(row.run_id));
      return json({ ...base, complete: records.length < 100, scanned_count: records.length, matching_callbacks: matching.map(row => ({ run_id: row.run_id, state: ['pending','verified','rejected'].includes(String(row.state)) ? row.state : null })) });
    }
    const path = mode === 'runs' ? `/actor-runs?startedAfter=${encodeURIComponent(from)}&startedBefore=${encodeURIComponent(until)}&` : `/${mode === 'webhooks' ? 'webhooks' : 'webhook-dispatches'}?`;
    const data = object(object(await apify(`${path}desc=0&limit=${limit}&offset=${offset}`, `provider_${mode}`)).data);
    if (!Array.isArray(data.items) || data.items.length > limit || data.offset !== offset || data.count !== data.items.length || data.limit !== limit ||
        data.desc !== false || typeof data.total !== 'number' || !Number.isSafeInteger(data.total) || data.total < 0 || data.total < offset + data.items.length && data.items.length > 0 ||
        data.items.length === 0 && data.total > offset) throw new AuditError('pagination_metadata');
    const items = data.items.map(object), complete = offset + items.length >= data.total;
    const summary = { ...base, scanned_count: items.length, total: data.total, complete,
      next_offset: !complete && offset + limit <= 10000 ? offset + limit : null, bound_reached: !complete && offset + limit > 10000 };
    const candidates: Row[] = [], selected = new Map<string, boolean>();
    if (mode === 'runs') {
      for (const row of items) if (row.actId === actor && safeId(row.id) && time(row.startedAt) !== null && Math.abs(Number(time(row.startedAt)) - start) <= 900000) selected.set(row.id, false);
    } else if (mode === 'webhooks') {
      for (const row of items) { const id = hookRun(row, pin); if (id) selected.set(id, true); }
    } else {
      for (const row of items) {
        const id = receiptRun(row, pin); if (!id) continue;
        const detail = object(object(await apify(`/webhook-dispatches/${encodeURIComponent(String(row.id))}`, 'receipt_detail')).data);
        if (detail.id === row.id && receiptRun(detail, pin) === id && detail.eventType === row.eventType && time(detail.createdAt) === time(row.createdAt)) selected.set(id, true);
      }
    }
    if (selected.size > 10) return json({ ...summary, candidates: [], candidate_bound_reached: true });
    for (const [id, correlated] of selected) {
      const run = object(object(await apify(`/actor-runs/${encodeURIComponent(id)}`, 'run_detail')).data);
      const runStart = time(run.startedAt);
      if (run.id !== id || run.actId !== actor || run.userId !== pin.user || !statuses.includes(String(run.status)) || runStart === null || Math.abs(runStart - start) > 900000) throw new AuditError('run_identity_mismatch');
      let exact = correlated;
      if (Array.isArray(run.defaultWebhooks) && run.defaultWebhooks.length <= 10) for (const value of run.defaultWebhooks) {
        const hook = typeof value === 'string' && safeId(value) ? object(object(await apify(`/webhooks/${encodeURIComponent(value)}`, 'run_webhook')).data) : object(value);
        if (hookRun(hook, pin) === id) exact = true;
      }
      let projection: Row = { available: false, matches_requested_input: false };
      if (safeId(run.defaultKeyValueStoreId)) projection = inputProjection(await apify(`/key-value-stores/${encodeURIComponent(run.defaultKeyValueStoreId)}/records/INPUT`, 'run_input', true), pin, job.results_limit);
      candidates.push({ run_id: id, status: run.status, started_at: new Date(runStart).toISOString(), finished_at: time(run.finishedAt) === null ? null : new Date(Number(time(run.finishedAt))).toISOString(),
        starts_before_dispatch: runStart < start, start_delta_ms: runStart - start, exact_job_nonce_webhook: exact, input: projection,
        usage_total_usd: typeof run.usageTotalUsd === 'number' && Number.isFinite(run.usageTotalUsd) && run.usageTotalUsd >= 0 ? run.usageTotalUsd : null,
        terminal: ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(String(run.status)) });
    }
    return json({ ...summary, candidates, exact_matches_in_page: candidates.filter(row => row.exact_job_nonce_webhook).length });
  } catch (error) {
    return json({ error: 'audit_unavailable', stage: error instanceof AuditError ? error.stage : stage,
      upstream_status: error instanceof AuditError ? error.status : null, read_only: true, no_start_proven: false }, 503);
  }
}
Deno.serve(handler);

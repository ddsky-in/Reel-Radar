import type { Job } from '../_shared/model.ts';
import { object, zonedTimestamp } from '../_shared/model.ts';
import { liveMode, required } from '../_shared/providers.ts';
import { authenticate, body, json, rows, validUuid } from '../_shared/worker.ts';

const ownerId = '43292213-87a3-4000-8000-9d779fbe6659';
const jobId = 'd8817ff8-10d8-4000-8000-edb3e96298f4';
const expiresAt = Date.parse('2026-11-15T00:00:00Z');
const resourceId = /^[A-Za-z0-9_-]{1,128}$/;
const statuses = new Set(['READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ABORTING', 'ABORTED', 'TIMING-OUT', 'TIMED-OUT']);

async function apifyRead(path: string): Promise<unknown> {
  if (!path.startsWith('/') || path.includes('://')) throw new Error('Invalid audit read');
  const response = await fetch(`https://api.apify.com/v2${path}`, { method: 'GET', redirect: 'error', headers: {
    Authorization: `Bearer ${required('APIFY_API_TOKEN')}` }, signal: AbortSignal.timeout(12000) });
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1024 * 1024) throw new Error('Audit provider unavailable');
  const reader = response.body?.getReader(); if (!reader) throw new Error('Audit provider unavailable');
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    length += part.value.length;
    if (length > 1024 * 1024) { await reader.cancel(); throw new Error('Audit provider unavailable'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function list(path: string, offset = 0): Promise<{ items: Record<string, unknown>[]; complete: boolean }> {
  const items: Record<string, unknown>[] = [];
  for (let page = 0; page < 3; page++) {
    const response = object(await apifyRead(`${path}${path.includes('?') ? '&' : '?'}desc=1&limit=100&offset=${offset + page * 100}`));
    const data = object(response.data);
    if (!Array.isArray(data.items) || data.items.length > 100) throw new Error('Invalid audit page');
    items.push(...data.items.map(object));
    if (data.items.length < 100) return { items, complete: true };
  }
  return { items, complete: false };
}
function callbackMatches(value: unknown, job: Job, origin: string): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password && !url.hash &&
      url.pathname === '/functions/v1/apify-webhook' && url.searchParams.getAll('job_id').length === 1 &&
      url.searchParams.get('job_id') === job.id && url.searchParams.getAll('dispatch_nonce').length === 1 &&
      url.searchParams.get('dispatch_nonce') === job.dispatch_nonce;
  } catch { return false; }
}
function receiptRunId(receipt: Record<string, unknown>, job: Job, origin: string): string | null {
  if (typeof receipt.id !== 'string' || !resourceId.test(receipt.id) || receipt.userId !== job.expected_provider_user_id ||
      !zonedTimestamp(receipt.createdAt) || !['ACTOR.RUN.SUCCEEDED', 'ACTOR.RUN.FAILED', 'ACTOR.RUN.ABORTED', 'ACTOR.RUN.TIMED_OUT'].includes(String(receipt.eventType)) ||
      !receipt.eventData || typeof receipt.eventData !== 'object' || Array.isArray(receipt.eventData) ||
      !receipt.webhook || typeof receipt.webhook !== 'object' || Array.isArray(receipt.webhook)) return null;
  const event = object(receipt.eventData), webhook = object(receipt.webhook);
  if (event.actorId !== job.expected_actor_id || typeof event.actorRunId !== 'string' || !resourceId.test(event.actorRunId) ||
      webhook.actionType !== 'HTTP_REQUEST' || !callbackMatches(webhook.requestUrl, job, origin) ||
      !webhook.condition || typeof webhook.condition !== 'object' || Array.isArray(webhook.condition)) return null;
  const condition = object(webhook.condition);
  if ((condition.actorRunId != null && condition.actorRunId !== event.actorRunId) ||
      (condition.actorId != null && condition.actorId !== job.expected_actor_id)) return null;
  return event.actorRunId;
}
async function receiptAudit(job: Job, origin: string, start: number, offset: number): Promise<Response> {
  const receipts = await list('/webhook-dispatches', offset);
  const times = receipts.items.flatMap(receipt => {
    const time = zonedTimestamp(receipt.createdAt); return time ? [time] : [];
  }).sort();
  const summary = { job_id: job.id, read_only: true, run_list_complete: false, webhook_list_complete: false,
    receipt_offset: offset, receipt_scanned_count: receipts.items.length, receipt_list_complete: receipts.complete,
    receipt_window: { oldest_at: times[0] ?? null, newest_at: times[times.length - 1] ?? null },
    next_receipt_offset: !receipts.complete && offset + receipts.items.length <= 10000 ? offset + receipts.items.length : null,
    no_start_proven: false };
  const matches = receipts.items.flatMap(receipt => {
    const runId = receiptRunId(receipt, job, origin); return runId ? [{ receipt, runId }] : [];
  });
  if (matches.length > 6) return json({ ...summary, candidates: [], reason: 'candidate_window_exceeded' });
  const evidence = [], confirmed = new Set<string>();
  for (const { receipt, runId } of matches) {
    const detail = object(object(await apifyRead(`/webhook-dispatches/${encodeURIComponent(String(receipt.id))}`)).data);
    if (detail.id !== receipt.id || detail.eventType !== receipt.eventType || zonedTimestamp(detail.createdAt) !== zonedTimestamp(receipt.createdAt) ||
        receiptRunId(detail, job, origin) !== runId || confirmed.has(runId)) continue;
    const run = object(object(await apifyRead(`/actor-runs/${encodeURIComponent(runId)}`)).data);
    if (run.id !== runId || run.actId !== job.expected_actor_id || run.userId !== job.expected_provider_user_id ||
        typeof run.status !== 'string' || !statuses.has(run.status) || !zonedTimestamp(run.startedAt) ||
        Math.abs(Date.parse(String(run.startedAt)) - start) > 300000) continue;
    confirmed.add(runId);
    evidence.push({ run_id: run.id, status: run.status, started_at: zonedTimestamp(run.startedAt), finished_at: zonedTimestamp(run.finishedAt),
      usage_total_usd: typeof run.usageTotalUsd === 'number' && Number.isFinite(run.usageTotalUsd) && run.usageTotalUsd >= 0 ? run.usageTotalUsd : null,
      exact_webhook_match: true });
  }
  // Exhausting even a historical receipt window cannot prove a provider never started.
  return json({ ...summary, candidates: evidence, reason: evidence.length === 1 ? 'exact_run_match' : 'no_exact_run_match' });
}
async function webhookAudit(job: Job, origin: string, start: number, offset: number): Promise<Response> {
  const hooks = await list('/webhooks', offset);
  const times = hooks.items.flatMap(hook => { const time = zonedTimestamp(hook.createdAt); return time ? [time] : []; }).sort();
  const summary = { job_id: job.id, read_only: true, run_list_complete: false, webhook_list_complete: hooks.complete,
    webhook_offset: offset, webhook_scanned_count: hooks.items.length,
    webhook_window: { oldest_at: times[0] ?? null, newest_at: times[times.length - 1] ?? null },
    next_webhook_offset: !hooks.complete && offset + hooks.items.length <= 10000 ? offset + hooks.items.length : null, no_start_proven: false };
  const ids = new Set(hooks.items.filter(hook => hook.userId === job.expected_provider_user_id && hook.actionType === 'HTTP_REQUEST' &&
    callbackMatches(hook.requestUrl, job, origin)).flatMap(hook => {
      const condition = hook.condition;
      if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return [];
      const row = condition as Record<string, unknown>;
      return typeof row.actorRunId === 'string' && resourceId.test(row.actorRunId) &&
        (row.actorId == null || row.actorId === job.expected_actor_id) ? [row.actorRunId] : [];
    }));
  if (ids.size > 6) return json({ ...summary, candidates: [], reason: 'candidate_window_exceeded' });
  const evidence = [];
  for (const id of ids) {
    const run = object(object(await apifyRead(`/actor-runs/${encodeURIComponent(id)}`)).data);
    if (run.id !== id || run.actId !== job.expected_actor_id || run.userId !== job.expected_provider_user_id ||
        typeof run.status !== 'string' || !statuses.has(run.status) || !zonedTimestamp(run.startedAt) ||
        Math.abs(Date.parse(String(run.startedAt)) - start) > 300000) continue;
    evidence.push({ run_id: run.id, status: run.status, started_at: zonedTimestamp(run.startedAt), finished_at: zonedTimestamp(run.finishedAt),
      usage_total_usd: typeof run.usageTotalUsd === 'number' && Number.isFinite(run.usageTotalUsd) && run.usageTotalUsd >= 0 ? run.usageTotalUsd : null,
      exact_webhook_match: true });
  }
  return json({ ...summary, candidates: evidence, reason: evidence.length === 1 ? 'exact_run_match' : 'no_exact_run_match' });
}
export async function handler(request: Request): Promise<Response> {
  if (!await authenticate(request)) return json({ error: 'unauthorized' }, 401);
  if (Date.now() >= expiresAt) return json({ error: 'audit_expired' }, 410);
  try {
    const input = await body(request);
    const offsets = ['receipt_offset', 'webhook_offset'] as const;
    if (input.job_id !== jobId || Object.keys(input).some(key => key !== 'job_id' && !offsets.includes(key as typeof offsets[number])) ||
        offsets.every(key => key in input) || offsets.some(key => key in input && (typeof input[key] !== 'number' ||
          !Number.isInteger(input[key]) || Number(input[key]) < 0 || Number(input[key]) > 10000 || Number(input[key]) % 100 !== 0))) return json({ error: 'invalid_audit_job' }, 400);
    if (required('REELRADAR_OWNER_USER_ID') !== ownerId || !liveMode()) throw new Error('Audit configuration unavailable');
    const base = new URL(required('SUPABASE_URL'));
    if (base.protocol !== 'https:' || base.username || base.password || base.port || base.pathname !== '/' || base.search || base.hash ||
        !/^[a-z0-9-]+\.supabase\.co$/i.test(base.hostname)) throw new Error('Audit configuration unavailable');
    const [job] = await rows<Job>('scrape_jobs', `owner_user_id=eq.${ownerId}&id=eq.${jobId}&live=eq.true&limit=1`);
    if (!job || job.id !== jobId || job.owner_user_id !== ownerId || !job.live || job.status !== 'uncertain' || job.actor_run_id !== null ||
        !validUuid(job.dispatch_nonce) || !resourceId.test(job.expected_actor_id) ||
        job.expected_provider_user_id !== required('APIFY_ACCOUNT_ID')) return json({ error: 'audit_job_unavailable' }, 409);
    const started = zonedTimestamp(job.started_at);
    if (!started) throw new Error('Audit start unavailable');
    const associations = await rows<{ creators: { id: string; username: string } }>('scrape_job_creators', `select=creators(id,username)&job_id=eq.${job.id}&limit=2`);
    if (associations.length !== 1 || !validUuid(associations[0].creators.id) || !/^[a-z0-9._]{1,30}$/.test(associations[0].creators.username)) throw new Error('Audit creator unavailable');
    const start = Date.parse(started);
    // Historical receipt pagination is explicitly opted into and skips approximate/global lists.
    if (typeof input.receipt_offset === 'number') return await receiptAudit(job, base.origin, start, input.receipt_offset);
    if (typeof input.webhook_offset === 'number') return await webhookAudit(job, base.origin, start, input.webhook_offset);
    const from = new Date(start - 300000).toISOString(), until = new Date(start + 300000).toISOString();
    const runs = await list(`/acts/${encodeURIComponent(job.expected_actor_id)}/runs?startedAfter=${encodeURIComponent(from)}&startedBefore=${encodeURIComponent(until)}`);
    const candidates = runs.items.filter(run => typeof run.id === 'string' && resourceId.test(run.id) && typeof run.startedAt === 'string' &&
      zonedTimestamp(run.startedAt) && Math.abs(Date.parse(run.startedAt) - start) <= 300000);
    const webhooks = await list('/webhooks');
    const matches = webhooks.items.filter(webhook => callbackMatches(webhook.requestUrl, job, base.origin));
    const exactIds = new Set(matches.flatMap(webhook => {
      if (!webhook.condition || typeof webhook.condition !== 'object' || Array.isArray(webhook.condition)) return [];
      const id = (webhook.condition as Record<string, unknown>).actorRunId;
      return typeof id === 'string' && resourceId.test(id) ? [id] : [];
    }));
    const selected = exactIds.size ? candidates.filter(run => exactIds.has(String(run.id))) : candidates;
    if (selected.length > 6) return json({ job_id: job.id, read_only: true, run_list_complete: runs.complete, webhook_list_complete: webhooks.complete,
      candidates: [], reason: 'candidate_window_exceeded', no_start_proven: false });
    const evidence = [];
    for (const candidate of selected) {
      const run = object(object(await apifyRead(`/actor-runs/${encodeURIComponent(String(candidate.id))}`)).data);
      if (run.id !== candidate.id || run.actId !== job.expected_actor_id || run.userId !== job.expected_provider_user_id ||
          typeof run.status !== 'string' || !statuses.has(run.status) || !zonedTimestamp(run.startedAt) ||
          Math.abs(Date.parse(String(run.startedAt)) - start) > 300000) continue;
      const exact = matches.some(webhook => {
        if (!webhook.condition || typeof webhook.condition !== 'object' || Array.isArray(webhook.condition)) return false;
        return (webhook.condition as Record<string, unknown>).actorRunId === run.id;
      });
      evidence.push({ run_id: run.id, status: run.status, started_at: zonedTimestamp(run.startedAt), finished_at: zonedTimestamp(run.finishedAt),
        usage_total_usd: typeof run.usageTotalUsd === 'number' && Number.isFinite(run.usageTotalUsd) && run.usageTotalUsd >= 0 ? run.usageTotalUsd : null,
        exact_webhook_match: exact });
    }
    // No read result is proof of non-start. This endpoint never changes holds or attaches runs.
    return json({ job_id: job.id, read_only: true, run_list_complete: runs.complete, webhook_list_complete: webhooks.complete, candidates: evidence,
      reason: evidence.filter(run => run.exact_webhook_match).length === 1 ? 'exact_run_match' : 'no_exact_run_match', no_start_proven: false });
  } catch { return json({ error: 'audit_unavailable', read_only: true, no_start_proven: false }, 503); }
}
Deno.serve(handler);

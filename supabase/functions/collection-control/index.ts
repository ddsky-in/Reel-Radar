import { authenticate, body, json, rpc, validUuid } from '../_shared/worker.ts';
import { env, required } from '../_shared/providers.ts';

const CONTROL_OWNER = '43292213-87a3-4000-8000-9d779fbe6659';

const ORIGINAL_JOBS = Object.freeze([
  { id: 'd8817ff8-10d8-4000-8000-edb3e96298f4', nonce: '9ff6f18c-bcae-4000-8000-8449f68cb1a5', started: '2026-11-13T14:23:48.972496Z' },
  { id: 'e02b7054-ffda-4000-8000-b3b4f090c045', nonce: '34c98f8f-5262-4000-8000-b1deb10fa28f', started: '2026-11-15T08:17:38.568660Z' },
  { id: 'e5adbea1-2892-4000-8000-53937ec86da7', nonce: '3233b414-86ea-4000-8000-1d6ff2734f1b', started: '2026-11-15T07:31:00.818521Z' },
]);
/** Service-only control. No dispatch, recovery, provider requests or generic wake. */
export async function handler(request: Request): Promise<Response> {
  if (!await authenticate(request)) return json({ error: 'unauthorized' }, 401);
  try {
    const expires = env('COLLECTION_CONTROL_EXPIRES_AT'), deadline = Date.parse(expires);
    if (!expires || !/(?:Z|[+-]\d\d:\d\d)$/.test(expires) || !Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 3600000) return json({ error: 'collection_control_expired' }, 410);
    const input = await body(request), owner = required('REELRADAR_OWNER_USER_ID');
    if (!validUuid(owner) || owner !== CONTROL_OWNER) throw new Error('Owner unavailable');
    if (input.action === 'set_start_gate') {
      if (input.gated !== true || Object.keys(input).some(key => !['action','gated'].includes(key))) return json({ error: 'invalid_control' }, 400);
      const gate = await rpc<{ paid_starts_gated: boolean }>('worker_set_collection_start_gate', { p_owner_user_id: owner, p_gated: input.gated });
      if (!gate || gate.paid_starts_gated !== input.gated) throw new Error('Gate unavailable');
      return json({ gated: gate.paid_starts_gated, paidStarts: 0 });
    }
    if (input.action !== 'risk_release' || Object.keys(input).some(key => !['action','request_key','reason','evidence_reference','expected'].includes(key)) ||
        !validUuid(input.request_key) || typeof input.reason !== 'string' || input.reason.length < 8 || input.reason.length > 500 ||
        typeof input.evidence_reference !== 'string' || !/^[A-Za-z0-9._:/-]{8,200}$/.test(input.evidence_reference) ||
        !Array.isArray(input.expected) || input.expected.length !== 3) return json({ error: 'invalid_control' }, 400);
    const seen = new Set<string>();
    const expected = input.expected.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid expected pins');
      const row = value as Record<string, unknown>, pin = ORIGINAL_JOBS.find(pin => pin.id === row.job_id);
      if (!pin || seen.has(pin.id) || Object.keys(row).some(key => !['job_id','expected_version','dispatch_nonce','started_at'].includes(key)) ||
          row.dispatch_nonce !== pin.nonce || row.started_at !== pin.started || !Number.isSafeInteger(row.expected_version) || Number(row.expected_version) < 0) throw new Error('Invalid expected pins');
      seen.add(pin.id);
      return { job_id: pin.id, expected_version: row.expected_version, dispatch_nonce: pin.nonce, started_at: pin.started };
    });
    // Atomic SQL wrapper rechecks authorized owner/workspace and immutable saved
    // run/account pins, live gate, phase/version, callback/journal races and
    // idempotency. Original manifest actor/account/amount pins require the
    // operator's read-only preflight before invoking this narrowly pinned batch.
    // This is a risk acknowledgement, NEVER no-start or zero-cost proof.
    const released = await rpc<{ items?: { id: string }[]; replayed?: boolean }>('worker_risk_release_collection_jobs', {
      p_owner_user_id: owner, p_job_ids: ORIGINAL_JOBS.map(pin => pin.id), p_request_key: input.request_key,
      p_reason: input.reason, p_evidence_reference: input.evidence_reference, p_expected: expected,
    });
    const ids = released?.items?.map(item => item.id);
    if (!Array.isArray(ids) || ids.length !== 3 || new Set(ids).size !== 3 || ids.some(id => !ORIGINAL_JOBS.some(pin => pin.id === id))) throw new Error('Release unavailable');
    return json({ releasedJobIds: ids, replayed: released.replayed === true, actualCostUsd: null, unknownRiskAcknowledged: true, paidStarts: 0 });
  } catch { return json({ error: 'collection_control_unavailable' }, 503); }
}
Deno.serve(handler);

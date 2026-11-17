import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mp4Fixture } from './mp4-fixture';

// Every transport is mocked. These fixtures never read account secrets or call providers.
const worker = await import('../supabase/functions/_shared/transcription-worker.ts' as string);
const speechUrl = 'https://api.elevenlabs.io/v1/speech-to-text';
const firstJob = {
  id: '11111111-1111-4111-8111-111111111111',
  reel_id: '22222222-2222-4222-8222-222222222222',
  attempt_id: '33333333-3333-4333-8333-333333333333',
  lease_token: '44444444-4444-4444-8444-444444444444',
  source_url: 'https://scontent.cdninstagram.com/first.mp4',
  candidates: [] as string[], has_audio: null, duration_seconds: 12,
  model: 'scribe_v2', options_version: 1, reservation_usd: .08,
  max_duration_seconds: 180, max_media_bytes: 26214400,
};
const secondJob = {
  ...firstJob,
  id: '55555555-5555-4555-8555-555555555555',
  reel_id: '66666666-6666-4666-8666-666666666666',
  attempt_id: '77777777-7777-4777-8777-777777777777',
  lease_token: '88888888-8888-4888-8888-888888888888',
  source_url: 'https://scontent.cdninstagram.com/second.mp4',
};
type FixtureJob = typeof firstJob;
type FixtureOptions = {
  phase?: 'pilot' | 'automatic';
  gate?: (job: FixtureJob) => { allow: boolean; reason?: string } | Promise<{ allow: boolean; reason?: string }>;
  media?: (job: FixtureJob) => Promise<void>;
  submit?: (job: FixtureJob) => Response | Promise<Response>;
  release?: (job: FixtureJob) => boolean;
};
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}
function rpcCalls(name: string) {
  return fetcher.mock.calls.filter(([url]) => String(url).endsWith(`/${name}`))
    .map(([, options]) => JSON.parse(String(options?.body)) as Record<string, unknown>);
}
function paidAttempts() {
  return fetcher.mock.calls.filter(([url]) => String(url) === speechUrl).map(([, options]) => {
    const body = options?.body as FormData;
    return (JSON.parse(String(body.get('webhook_metadata'))) as { attempt_id: string }).attempt_id;
  });
}
function installFixture({ phase = 'automatic', gate, media, submit, release }: FixtureOptions = {}) {
  const jobs = phase === 'pilot' ? [firstJob] : [firstJob, secondJob];
  fetcher.mockImplementation(async (input, options) => {
    const url = String(input);
    if (url.endsWith('/worker_transcription_config')) {
      return json({ enabled: true, paused: false, key_validated: true, contract_validated: true, phase, concurrency: 2 });
    }
    if (url.endsWith('/worker_transcription_claim')) return json({ jobs });
    const mediaJob = jobs.find(job => job.source_url === url);
    if (mediaJob) {
      await media?.(mediaJob);
      return new Response(mp4Fixture().slice().buffer, { headers: { 'content-type': 'video/mp4' } });
    }
    if (url === speechUrl) {
      const metadata = JSON.parse(String((options?.body as FormData).get('webhook_metadata'))) as { attempt_id: string };
      const job = jobs.find(job => job.attempt_id === metadata.attempt_id);
      if (!job) throw new Error('Unexpected fixture attempt');
      return submit ? await submit(job) : json({ message: 'accepted', request_id: `request_${job.id}`, transcription_id: `transcript_${job.id}` });
    }
    const args = JSON.parse(String(options?.body)) as { p_attempt_id?: string };
    const job = jobs.find(job => job.attempt_id === args.p_attempt_id);
    if (!job) throw new Error('Unexpected fixture RPC identity');
    if (url.endsWith('/worker_transcription_before_submit')) return json(gate ? await gate(job) : { allow: true });
    if (url.endsWith('/worker_transcription_select_media')) return json({ selected: true });
    if (url.endsWith('/worker_transcription_attach')) return json({ status: 'processing' });
    if (url.endsWith('/worker_transcription_cancel_not_started')) return json({ status: 'not_started' });
    if (url.endsWith('/worker_transcription_fail')) return json({ status: 'uncertain' });
    if (url.endsWith('/worker_transcription_release_unsubmitted')) return json({ released: release?.(job) ?? false });
    throw new Error('Unexpected fixture transport');
  });
}

beforeEach(() => {
  const environment: Record<string, string> = {
    ENVIRONMENT: 'test', SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-secret', INTERNAL_CRON_SECRET: 'fixture-internal-secret',
    ELEVENLABS_API_KEY: 'fixture-api-secret', ELEVENLABS_WEBHOOK_ID: 'fixture-webhook-id',
    ELEVENLABS_WEBHOOK_SECRET: 'fixture-hmac-secret', TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_PROVIDER_VALIDATED: 'true',
  };
  vi.stubGlobal('Deno', { env: { get: (name: string) => environment[name] }, serve: vi.fn() });
  fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('Network forbidden outside explicit fixtures'));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('bounded automatic transcription throughput', () => {
  it('reserves two automatic attempts but holds only one video in memory at a time', async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>(resolve => { releaseFirst = resolve; });
    const probes: string[] = [];
    installFixture({ media: async job => {
      probes.push(job.id);
      if (job.id === firstJob.id) await firstPending;
    } });
    const dispatched = worker.dispatchTranscripts();
    try {
      await vi.waitFor(() => expect(probes).toEqual([firstJob.id]), { timeout: 1000 });
      expect(paidAttempts()).toHaveLength(0);
    } finally { releaseFirst(); }
    expect(await dispatched).toEqual(expect.arrayContaining([
      { job_id: firstJob.id, status: 'submitted' }, { job_id: secondJob.id, status: 'submitted' },
    ]));
    expect(rpcCalls('worker_transcription_claim')).toEqual([{ p_limit: 2 }]);
    expect(probes).toEqual([firstJob.id, secondJob.id]);
    expect(paidAttempts()).toHaveLength(2);
  });

  it('keeps pilot dispatch to a single claimed attempt', async () => {
    installFixture({ phase: 'pilot' });
    expect(await worker.dispatchTranscripts()).toEqual([{ job_id: firstJob.id, status: 'submitted' }]);
    expect(rpcCalls('worker_transcription_claim')).toEqual([{ p_limit: 1 }]);
    expect(paidAttempts()).toEqual([firstJob.attempt_id]);
  });

  it('rechecks each attempt immediately before paid work and cancels only an explicitly denied sibling', async () => {
    installFixture({ gate: job => job.id === secondJob.id ? { allow: false, reason: 'paused' } : { allow: true } });
    expect(await worker.dispatchTranscripts()).toEqual(expect.arrayContaining([
      { job_id: firstJob.id, status: 'submitted' }, { job_id: secondJob.id, status: 'not_started' },
    ]));
    expect(rpcCalls('worker_transcription_before_submit').map(call => call.p_attempt_id).sort())
      .toEqual([firstJob.attempt_id, secondJob.attempt_id].sort());
    expect(paidAttempts()).toEqual([firstJob.attempt_id]);
    expect(rpcCalls('worker_transcription_cancel_not_started')).toEqual([
      { p_attempt_id: secondJob.attempt_id, p_lease_token: secondJob.lease_token },
    ]);
  });

  it('does not abandon a claimed sibling when one submission gate cannot be reached', async () => {
    installFixture({ gate: job => {
      if (job.id === firstJob.id) throw new Error('Fixture database gate unavailable');
      return { allow: true };
    } });
    const outcomes = await worker.dispatchTranscripts();
    expect(outcomes).toEqual(expect.arrayContaining([{ job_id: secondJob.id, status: 'submitted' }]));
    expect(paidAttempts()).toEqual([secondJob.attempt_id]);
    expect(rpcCalls('worker_transcription_cancel_not_started')).toEqual([]);
    expect(rpcCalls('worker_transcription_claim')).toHaveLength(1);
  });

  it('never retries an uncertain paid POST while allowing the independently gated sibling to finish', async () => {
    installFixture({ submit: job => {
      if (job.id === firstJob.id) throw new Error('Fixture paid submission timed out');
      return json({ message: 'accepted', request_id: 'request_second', transcription_id: 'transcript_second' });
    } });
    expect(await worker.dispatchTranscripts()).toEqual(expect.arrayContaining([
      { job_id: firstJob.id, status: 'uncertain' }, { job_id: secondJob.id, status: 'submitted' },
    ]));
    expect(paidAttempts().sort()).toEqual([firstJob.attempt_id, secondJob.attempt_id].sort());
    expect(rpcCalls('worker_transcription_fail')).toEqual([
      expect.objectContaining({ p_attempt_id: firstJob.attempt_id, p_lease_token: firstJob.lease_token, p_status: 'uncertain' }),
    ]);
    expect(rpcCalls('worker_transcription_fail')[0]).not.toHaveProperty('p_actual_cost_usd');
    expect(rpcCalls('worker_transcription_cancel_not_started')).toEqual([]);
  });
  it.each([true, false])('uses database proof to release an unreachable pre-submit gate: released=%s', async released => {
    installFixture({ phase: 'pilot', gate: () => { throw new Error('Gate transport unavailable'); }, release: () => released });
    expect(await worker.dispatchTranscripts()).toEqual([{ job_id: firstJob.id, status: released ? 'not_started' : 'unresolved' }]);
    expect(paidAttempts()).toEqual([]);
    expect(rpcCalls('worker_transcription_release_unsubmitted')).toEqual([{ p_attempt_id: firstJob.attempt_id, p_lease_token: firstJob.lease_token }]);
  });

  it('finishes one bounded batch without claiming again or calling another Edge invocation', async () => {
    installFixture();
    await worker.dispatchTranscripts();
    expect(rpcCalls('worker_transcription_claim')).toEqual([{ p_limit: 2 }]);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/functions/v1/'))).toBe(false);
    expect(paidAttempts()).toHaveLength(2);
  });
});

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const db = new PGlite();
const owner = 'f1000000-0000-4000-8000-000000000001';
const stranger = 'f1000000-0000-4000-8000-000000000002';
let workspace: string, creator: string, sequence = 0;
type Claim = { jobs: { id: string; attempt_id: string; lease_token: string }[]; reason: string | null };

async function value<T>(sql: string, args: unknown[] = []): Promise<T> {
  return (await db.query<{ value: T }>(sql, args)).rows[0].value;
}
async function rpc<T = Record<string, unknown>>(name: string, args: unknown[] = []): Promise<T> {
  return value<T>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) value`, args);
}
async function identity(role = 'postgres', sub = owner) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role, sub })]);
  if (role !== 'postgres') await db.exec(`set role ${role}`);
}
async function settings(patch: unknown) {
  await identity('authenticated');
  return rpc('update_transcription_settings', [JSON.stringify(patch)]);
}
async function reel(source = true) {
  await identity();
  const id = await value<string>("insert into public.reels(creator_id,shortcode,reel_url,published_at,duration_seconds,latest_fetched_at,provider,latest_views,views_state) values($1,$2,'https://www.instagram.com/reel/fixture/','2026-08-01T00:00:00Z',60,now(),'fixture',123,'known') returning id value", [creator, `SPEND_${++sequence}`]);
  await identity('service_role');
  await rpc('worker_observe_reel_media', [id, source ? 'https://scontent.cdninstagram.com/fixture.mp4' : null, '[]', true, new Date().toISOString()]);
  // Spending fixtures represent already-requested work.
  await identity();
  await db.query('update public.transcript_jobs set priority_requested_at=now() where reel_id=$1', [id]);
  await identity('service_role');
  return id;
}
async function activate() {
  await identity('service_role');
  await rpc('worker_transcription_configure', [true, false, 'pilot', 5, .25, true]);
  await rpc('worker_transcription_validate_account', [.22, .08]);
  await identity();
  const secret = await value<string>("select vault.create_secret('inert-fixture-key','reelradar_transcription_webhook_hmac_v1','fixture') value");
  await db.query("update public.transcription_webhook_setup set status='configured',webhook_id='fixture_hook',secret_id=$1 where singleton", [secret]);
  await db.query("update public.app_settings set scraping_enabled=true,paused=false,max_run_charge_usd=.10,provider_account_id='fixture_account',provider_usage_checked_at=now(),provider_cycle_start_at=date_trunc('month',now()),provider_cycle_end_at=date_trunc('month',now())+interval '1 month',provider_cycle_usage_usd=0,provider_cycle_limit_usd=100 where owner_user_id=$1", [owner]);
  await identity('service_role');
  await rpc('worker_configure_apify_account', [owner, 1, 'fixture_account', true, true]);
  await db.query("select public.worker_record_account_usage($1,1,'fixture_account',date_trunc('month',now()),date_trunc('month',now())+interval '1 month',0,100)", [owner]);
  await rpc('worker_transcription_activate', ['pilot']);
}
async function claim() {
  await identity('service_role');
  return rpc<Claim>('worker_transcription_claim', [2]);
}
async function normalJob() {
  await identity();
  const id = await value<string>("insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,manual_authorized_by,scheduled_for) values($1,'manual',1,10,$1,now()) returning id value", [owner]);
  await db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [id, creator]);
  return id;
}
async function recoverMedia(reelId: string | null, overrides: Record<string, unknown> = {}) {
  await identity('service_role');
  const refresh = await rpc<{ refresh_id: string; job_id: string; target_count: number }>('worker_transcription_media_enqueue', [creator]);
  const context = await rpc<{ job: { dispatch_nonce: string } }>('worker_transcription_media_claim', [refresh.job_id, 'fixture_actor']);
  await rpc('worker_attach_run', [refresh.job_id, context.job.dispatch_nonce, `run_${refresh.job_id}`, 'fixture_actor', 'fixture_account', 'fixture_dataset']);
  await rpc('worker_reconcile_run', [refresh.job_id, `run_${refresh.job_id}`, 'fixture_actor', 'fixture_account', 'SUCCEEDED', 'fixture_dataset', .005]);
  const processing = await rpc<{ job: { lease_token: string } }>('worker_claim_processing', [refresh.job_id]);
  const rows: unknown[] = [];
  if (reelId) {
    await identity();
    const shortcode = await value<string>('select shortcode value from public.reels where id=$1', [reelId]);
    rows.push({ creator_id: creator, username: 'spending_fixture', shortcode, fetched_at: new Date().toISOString(), duration_seconds: 60, media_source_url: 'https://scontent.cdninstagram.com/recovered.mp4', media_candidates: [], has_audio: true, ...overrides });
  }
  await identity('service_role');
  await rpc('worker_ingest_page', [refresh.job_id, processing.job.lease_token, 0, JSON.stringify(rows), '[]', rows.length, true, JSON.stringify({ [creator]: rows.length })]);
  await rpc('worker_finish_processing', [refresh.job_id, processing.job.lease_token]);
  await rpc('worker_transcription_media_reconcile', [refresh.job_id]);
  return refresh;
}
async function automaticFixture() {
  const original = await reel(false);
  await identity('service_role'); await rpc('worker_transcription_manifest', [41]);
  await activate();
  const refresh = await recoverMedia(original);
  const attempt = (await claim()).jobs[0];
  expect(attempt).toBeDefined();
  await rpc('worker_transcription_before_submit', [attempt.attempt_id, attempt.lease_token]);
  await rpc('worker_transcription_attach', [attempt.attempt_id, attempt.lease_token, 'fixture_speech', 'fixture_transcript']);
  await rpc('worker_transcription_complete', [attempt.attempt_id, attempt.lease_token, 'Local fixture speech', 'en', '[]', false, null]);
  expect(await rpc('worker_transcription_activate', ['automatic'])).toMatchObject({ enabled: true, phase: 'automatic', pilot_verified: true });
  return { original, refresh };
}

beforeAll(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    grant usage on schema auth,public to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
    -- Hosted facilities remain inert local fixtures, with no network implementation.
    create schema vault; create schema cron; create schema net;
    create table vault.secrets(id uuid primary key default gen_random_uuid(),name text,secret text);
    create view vault.decrypted_secrets as select id,name,secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(value text,label text,description text) returns uuid language sql as $$ insert into vault.secrets(name,secret) values(label,value) returning id $$;
    create table cron.job(jobid bigint generated always as identity primary key,jobname text unique,schedule text,command text,active boolean default true);
    create function cron.schedule(label text,schedule text,command text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values(label,schedule,command) returning jobid $$;
    create table net.requests(id bigint generated always as identity,url text,headers jsonb,body jsonb);
    create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as $$ insert into net.requests(url,headers,body) values(url,headers,body) returning id $$;
  `);
  const migrations = join(process.cwd(), 'supabase/migrations');
  for (const file of readdirSync(migrations).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrations, file), 'utf8').replace(/^create extension[^;]+;\s*/gm, ''));
  }
  await db.query('insert into auth.users values($1),($2)', [owner, stranger]);
  await identity('service_role'); await rpc('provision_owner', [owner]);
  await identity('authenticated'); workspace = (await rpc<{ id: string }>('create_workspace', ['Spending fixture'])).id;
  await identity();
  creator = await value<string>("insert into public.creators(username,status) values('spending_fixture','active') returning id value");
  await db.query('insert into public.workspace_creators(workspace_id,creator_id) values($1,$2)', [workspace, creator]);
}, 60000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await identity();
  await db.exec('truncate public.transcription_media_targets,public.transcription_media_refreshes,public.transcript_jobs,public.transcript_attempts,public.reel_transcripts,public.reel_media_sources,public.reels,public.scrape_jobs,public.creator_initializations,public.budget_envelopes cascade');
  await db.exec("update public.transcription_settings set enabled=false,paused=true,key_validated=false,contract_validated=false,phase='pilot',monthly_budget_usd=5,pilot_limit_usd=.25,budget_warning_pct=80,manifest_seeded=false,media_recovery_enabled=false,pilot_verified=false,account_pricing_validated=false; update public.transcription_webhook_setup set status='idle',webhook_id=null,secret_id=null; delete from vault.secrets");
  await db.query('update public.app_settings set scraping_enabled=false,paused=true,monthly_budget_usd=4,max_run_charge_usd=.10,capacity=120 where owner_user_id=$1', [owner]);
  await db.query('update public.apify_accounts set enabled=false where owner_id=$1 and slot>1', [owner]);
  await db.exec('truncate net.requests');
});

describe('authorized Reel detail and on-demand transcript', () => {
  async function detail(id: string, request = false, scope = workspace) {
    return rpc<import('../src/lib/types').ReelDetail>(request ? 'request_reel_transcript' : 'get_reel_detail', [scope, id]);
  }
  async function automaticReady() {
    await activate();
    await identity();
    await db.exec("update public.transcription_settings set phase='automatic',pilot_verified=true,media_recovery_enabled=true");
  }
  it('keeps the public contracts invoker-only and private tables inaccessible', async () => {
    expect(await value<boolean>("select bool_or(prosecdef) value from pg_proc where oid in ('public.get_reel_detail(uuid,uuid)'::regprocedure,'public.request_reel_transcript(uuid,uuid)'::regprocedure)")).toBe(false);
    await identity('authenticated');
    await expect(db.exec('select * from public.reel_media_sources')).rejects.toThrow(/permission denied/);
  });
  it('rejects foreign workspace, anonymous, stranger, removed links and archived scopes', async () => {
    const id = await reel();
    await identity('authenticated');
    const foreign = (await rpc<{ id: string }>('create_workspace', ['Detail foreign'])).id;
    await expect(detail(id, false, foreign)).rejects.toThrow(/reel_not_in_workspace/);
    await expect(detail(id, true, foreign)).rejects.toThrow(/reel_not_in_workspace/);
    await identity('anon');
    await expect(detail(id)).rejects.toThrow(/permission denied/);
    await identity('authenticated', stranger);
    await expect(detail(id)).rejects.toThrow(/forbidden/);
    await expect(detail(id, true)).rejects.toThrow(/forbidden/);
    await expect(db.query('select reel_detail_private.read_detail($1,$2)', [workspace, id])).rejects.toThrow(/forbidden/);
    await identity(); await db.query('update public.workspace_creators set active=false where workspace_id=$1 and creator_id=$2', [workspace, creator]);
    await identity('authenticated'); await expect(detail(id)).rejects.toThrow(/reel_not_in_workspace/);
    await identity(); await db.query('update public.workspace_creators set active=true where workspace_id=$1 and creator_id=$2', [workspace, creator]);
    await db.query('update public.workspaces set archived_at=now() where id=$1', [workspace]);
    await identity('authenticated'); await expect(detail(id, true)).rejects.toThrow(/reel_not_in_workspace/);
    await identity(); await db.query('update public.workspaces set archived_at=null where id=$1', [workspace]);
  });
  it('reads stored media and summary without starting jobs or exposing private pipeline fields', async () => {
    const id = await reel();
    await identity(); await db.query('delete from public.transcript_jobs where reel_id=$1', [id]);
    await db.query("update public.reel_media_sources set candidates=array['https://evil.test/internal','https://video.fbcdn.net/backup.mp4'] where reel_id=$1", [id]);
    await identity('authenticated'); const data = await detail(id);
    expect(data.media.urls).toEqual(['https://scontent.cdninstagram.com/fixture.mp4', 'https://video.fbcdn.net/backup.mp4']);
    expect(data.reel.latest_views).toBe(123); expect(data.transcript.status).toBe('not_requested');
    expect(data.processing).toMatchObject({ request_allowed: false, reason: 'setup_required', estimate: null });
    expect(JSON.stringify(data)).not.toMatch(/evil|lease_token|provider_job_id|reservation_usd|api_key/);
    await identity(); expect(await value<number>('select count(*)::int value from public.transcript_jobs')).toBe(0);
    expect(await value<number>('select count(*)::int value from net.requests')).toBe(0);
  });
  it('serializes repeated clicks into one queue job and reserves only when a worker claims', async () => {
    const id = await reel();
    await identity(); await db.query('delete from public.transcript_jobs where reel_id=$1', [id]);
    await automaticReady();
    await identity('authenticated');
    expect((await detail(id, true)).transcript.status).toBe('queued');
    expect((await detail(id, true)).transcript.status).toBe('queued');
    await identity();
    expect(await value<number>('select count(*)::int value from public.transcript_jobs where reel_id=$1', [id])).toBe(1);
    expect(await value<number>('select count(*)::int value from public.transcript_attempts')).toBe(0);
    const claimed = await claim(); expect(claimed.jobs).toHaveLength(1);
    await identity('authenticated'); expect((await detail(id, true)).transcript.status).toBe('submitting');
    await identity(); expect(await value<number>('select count(*)::int value from public.transcript_attempts')).toBe(1);
  });
  it('queues missing media for existing authorized recovery and leaves failed/uncertain outcomes intact', async () => {
    const id = await reel(false);
    await automaticReady(); await identity('authenticated');
    expect((await detail(id, true)).transcript.status).toBe('awaiting_media');
    await identity(); await db.query("update public.transcript_jobs set status='failed',error_message='fixture failure' where reel_id=$1", [id]);
    await identity('authenticated'); const failed = await detail(id, true);
    expect(failed.transcript.status).toBe('failed'); expect(failed.processing.reason).toBe('review_required');
    await identity(); await db.query("update public.transcript_jobs set status='uncertain' where reel_id=$1", [id]);
    await identity('authenticated'); expect((await detail(id, true)).transcript.status).toBe('uncertain');
    await identity(); expect(await value<number>('select count(*)::int value from public.transcript_attempts')).toBe(0);
  });
  it('allows free priority enqueue while pause and exhausted budgets still prevent paid claims', async () => {
    const id = await reel(); await automaticReady();
    await identity(); await db.query('delete from public.transcript_jobs where reel_id=$1', [id]);
    await db.exec('update public.transcription_settings set paused=true');
    await identity('authenticated'); expect((await detail(id, true)).processing.reason).toBe('paused');
    await identity(); await db.exec('update public.transcription_settings set paused=false,monthly_budget_usd=0');
    await identity('authenticated'); expect((await detail(id, true)).processing.reason).toBe('budget_paused');
    expect((await claim()).jobs).toHaveLength(0);
    await identity(); expect(await value<number>('select count(*)::int value from public.transcript_jobs')).toBe(1);
    expect(await value<number>('select count(*)::int value from public.transcript_attempts')).toBe(0);
    expect(await value<number>('select priority value from public.transcript_jobs where reel_id=$1', [id])).toBe(100);
  });
  it('permits an explicit bounded retry of media rejected before submission and reserves only on claim', async () => {
    const id = await reel(); await automaticReady();
    const attempt = (await claim()).jobs[0];
    await rpc('worker_transcription_fail', [attempt.attempt_id, attempt.lease_token, 'media_unavailable', null, null]);
    await identity('authenticated');
    expect((await detail(id)).processing).toMatchObject({ request_allowed: true, reason: null });
    expect((await detail(id, true)).transcript.status).toBe('queued');
    expect((await detail(id, true)).transcript.status).toBe('queued');
    await identity(); expect(await value<number>('select count(*)::int value from public.transcript_attempts')).toBe(1);
    const retry = (await claim()).jobs[0]; expect(retry.id).toBe(attempt.id); expect(retry.attempt_id).not.toBe(attempt.attempt_id);
    await identity(); expect(await value<number>('select count(*)::int value from public.transcript_attempts')).toBe(2);
  });
  it('denies media retries after any authorized paid submission, uncertainty, exhausted attempts or duration limit', async () => {
    const id = await reel(); await automaticReady();
    const attempt = (await claim()).jobs[0];
    await rpc('worker_transcription_before_submit', [attempt.attempt_id, attempt.lease_token]);
    await rpc('worker_transcription_fail', [attempt.attempt_id, attempt.lease_token, 'media_unavailable', null, null]);
    await identity('authenticated'); expect((await detail(id, true)).processing.request_allowed).toBe(false);
    await identity(); await db.query('update public.transcript_attempts set submit_authorized=false where id=$1', [attempt.attempt_id]);
    await db.query('update public.transcript_jobs set attempt_count=3 where reel_id=$1', [id]);
    await identity('authenticated'); expect((await detail(id, true)).transcript.status).toBe('media_unavailable');
    await identity(); await db.query('update public.transcript_jobs set attempt_count=1 where reel_id=$1', [id]);
    await db.query('update public.reels set duration_seconds=181 where id=$1', [id]);
    await identity('authenticated'); expect((await detail(id)).processing.request_allowed).toBe(false);
    await identity(); await db.query('update public.reels set duration_seconds=60 where id=$1', [id]);
    await db.query("update public.transcript_attempts set status='uncertain' where id=$1", [attempt.attempt_id]);
    await identity('authenticated'); expect((await detail(id, true)).processing.request_allowed).toBe(false);
  });
  it('does not turn a provider audio hint into a no-speech transcript', async () => {
    const id = await reel(); await automaticReady(); await identity();
    await db.query('update public.reel_media_sources set has_audio=false where reel_id=$1', [id]);
    const attempt = (await claim()).jobs[0]; expect(attempt.id).toBeDefined();
    await identity(); expect(await value<number>('select count(*)::int value from public.reel_transcripts')).toBe(0);
    await identity('authenticated'); expect((await detail(id)).transcript.status).toBe('submitting');
  });
  it('blocks an otherwise safe media retry while another uncertain paid submission still has a live lease', async () => {
    const id = await reel(); await automaticReady();
    const failed = (await claim()).jobs[0];
    await rpc('worker_transcription_fail', [failed.attempt_id, failed.lease_token, 'media_unavailable', null, null]);
    await reel(); const other = (await claim()).jobs[0];
    await rpc('worker_transcription_before_submit', [other.attempt_id, other.lease_token]);
    await rpc('worker_transcription_fail', [other.attempt_id, other.lease_token, 'uncertain', null, null]);
    await identity();
    await db.query("update public.transcript_attempts set lease_expires_at=now()+interval '5 minutes' where id=$1", [other.attempt_id]);
    await identity('authenticated');
    expect((await detail(id, true)).processing).toMatchObject({ request_allowed: false, reason: 'review_required' });
    expect((await detail(id)).transcript.status).toBe('media_unavailable');
  });
  it('uses sufficient recent completed attempts for a bounded estimate, including queue wait', async () => {
    const id = await reel(); await automaticReady();
    await identity('authenticated'); expect((await detail(id)).processing.estimate).toBeNull();
    for (let i=0; i<5; i++) {
      const sample = await reel(); await identity();
      const job = await value<string>('select id value from public.transcript_jobs where reel_id=$1', [sample]);
      await db.query("update public.transcript_jobs set status='ready' where id=$1", [job]);
      await db.query("insert into public.transcript_attempts(job_id,attempt_number,lease_expires_at,status,phase,billing_month,reserved_usd,created_at,completed_at) values($1,1,now()+interval '1 minute','ready','automatic',date_trunc('month',now())::date,0,now()-interval '2 minutes',now()-interval '1 minute')", [job]);
    }
    await identity('authenticated'); const estimate = (await detail(id)).processing.estimate;
    expect(estimate).toMatchObject({ min_seconds: 60, max_seconds: 60, sample_count: 5 });
    await identity(); await db.query("update public.transcript_jobs set next_attempt_at=now()+interval '2 minutes' where reel_id=$1", [id]);
    await identity('authenticated'); expect((await detail(id)).processing.estimate!.max_seconds).toBeGreaterThanOrEqual(179);
    await identity(); await db.exec("update public.transcript_attempts set completed_at=now()-interval '8 days',created_at=now()-interval '8 days 1 minute'");
    await identity('authenticated'); expect((await detail(id)).processing.estimate).toBeNull();
  });
});

describe('full source caption ingestion through the real migration chain', () => {
  async function captionPage(id: string, patch: Record<string, unknown>) {
    const job = await normalJob();
    const lease = 'f3000000-0000-4000-8000-000000000001';
    await db.query("update public.scrape_jobs set status='processing',lease_token=$2,lease_expires_at=now()+interval '5 minutes' where id=$1", [job, lease]);
    const shortcode = await value<string>('select shortcode value from public.reels where id=$1', [id]);
    const record: Record<string, unknown> = { creator_id: creator, username: 'spending_fixture', shortcode, fetched_at: new Date().toISOString(), caption_preview: 'Short title…', published_at: '2026-08-01T00:00:00Z', provider: 'fixture', duration_seconds: 60, views: 123, likes: 10, comments: 2, views_state: 'known', likes_state: 'known', comments_state: 'known', ...patch };
    await identity('service_role');
    return { job, lease, record, ingest: () => rpc('worker_ingest_page', [job, lease, 0, JSON.stringify([record]), '[]', 1, true, JSON.stringify({ [creator]: 1 })]) };
  }
  it('stores the complete caption independently of the title and preserves it across missing and older payloads', async () => {
    const id = await reel(); const full = 'Full first paragraph.\n\n' + 'Source caption words '.repeat(75);
    const page = await captionPage(id, { caption_full: full }); await page.ingest();
    await identity('authenticated');
    const detail = await rpc<import('../src/lib/types').ReelDetail>('get_reel_detail', [workspace, id]);
    expect(detail.caption_full).toBe(full); expect(detail.reel.caption_preview).toBe('Short title…');
    const missing = await captionPage(id, { caption_full: null }); await missing.ingest();
    const older = await captionPage(id, { caption_full: 'Older caption', fetched_at: '2026-07-01T00:00:00Z' }); await older.ingest();
    await identity('authenticated'); expect((await rpc<import('../src/lib/types').ReelDetail>('get_reel_detail', [workspace, id])).caption_full).toBe(full);
    await identity('service_role'); page.record.caption_full = 'Duplicate replacement'; await page.ingest();
    await identity(); expect(await value<string>('select caption_full value from public.reels where id=$1', [id])).toBe(full);
  });
  it('rolls back a whole invalid caption page and never exposes the ingestion core to browser roles', async () => {
    const id = await reel(); const page = await captionPage(id, { caption_full: 'x'.repeat(20001) });
    await expect(page.ingest()).rejects.toThrow(/invalid_full_caption/);
    await identity(); expect(await value<number>('select dataset_cursor value from public.scrape_jobs where id=$1', [page.job])).toBe(0);
    expect(await value<string | null>('select caption_full value from public.reels where id=$1', [id])).toBeNull();
    for (const role of ['anon', 'authenticated', 'service_role']) expect(await value<boolean>("select has_function_privilege($1,'public.worker_ingest_page_pre_caption(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb)','execute') value", [role])).toBe(false);
  });
  it('accepts a full caption on a frozen media recovery target without rewriting its metrics', async () => {
    const id = await reel(false); await activate();
    await identity(); await db.exec("update public.transcription_settings set phase='automatic',pilot_verified=true,media_recovery_enabled=true");
    await recoverMedia(id, { caption_full: 'Recovered full caption.\n\nHashtags and all paragraphs.' });
    await identity('authenticated'); const detail = await rpc<import('../src/lib/types').ReelDetail>('get_reel_detail', [workspace, id]);
    expect(detail.caption_full).toContain('Hashtags and all paragraphs.'); expect(detail.reel.latest_views).toBe(123);
  });
  it('freezes and deduplicates an operator source repair while leaving completed/uncertain transcripts intact', async () => {
    const ready = await reel(); const uncertain = await reel(); await activate();
    await identity(); await db.exec("update public.transcription_settings set phase='automatic',pilot_verified=true,media_recovery_enabled=true");
    await db.query("update public.transcript_jobs set status='ready' where reel_id=$1", [ready]);
    await db.query("insert into public.reel_transcripts(reel_id,model,options_version,status,text,language) values($1,'scribe_v2',1,'ready','Existing speech','en')", [ready]);
    await db.query("update public.transcript_jobs set status='uncertain' where reel_id=$1", [uncertain]);
    await identity('authenticated'); await expect(rpc('worker_transcription_source_refresh_enqueue', [creator])).rejects.toThrow(/permission denied/);
    await identity('service_role'); const refresh = await rpc<{ job_id: string; target_count: number }>('worker_transcription_source_refresh_enqueue', [creator]);
    expect(refresh.target_count).toBe(2);
    expect((await rpc<{ job_id: string }>('worker_transcription_source_refresh_enqueue', [creator])).job_id).toBe(refresh.job_id);
    await identity(); expect(await value<number>('select count(*)::int value from public.transcription_media_refreshes')).toBe(1);
    expect(await value<number>('select reserved_usd::double precision value from public.transcription_media_refreshes')).toBe(0);
    expect(await value<string>('select status value from public.transcript_jobs where reel_id=$1', [uncertain])).toBe('uncertain');
    expect(await value<string>('select text value from public.reel_transcripts where reel_id=$1', [ready])).toBe('Existing speech');
  });
});

async function wakeFixture() {
  await automaticFixture();
  await identity();
  await db.query("select vault.create_secret($1,'reelradar_transcription_maintenance_v1','inert fixture')", ['a'.repeat(64)]);
  await db.exec("insert into vault.secrets(name,secret) values('reelradar_edge_url','https://project.supabase.co')");
  await db.exec('truncate net.requests');
}

describe('complete source refresh coverage and recovery', () => {
  async function automatic() {
    await activate(); await identity();
    await db.exec("update public.transcription_settings set phase='automatic',pilot_verified=true,media_recovery_enabled=true");
  }
  async function start() {
    await identity('authenticated');
    const queued = await rpc<{ job_id: string; refresh_id: string; target_count: number }>('request_creator_source_refresh', [workspace, creator]);
    await identity('service_role');
    const claimed = await rpc<{ job: { dispatch_nonce: string } }>('worker_transcription_media_claim', [queued.job_id, 'fixture_actor']);
    await rpc('worker_attach_run', [queued.job_id, claimed.job.dispatch_nonce, `run_${queued.job_id}`, 'fixture_actor', 'fixture_account', 'fixture_dataset']);
    await rpc('worker_reconcile_run', [queued.job_id, `run_${queued.job_id}`, 'fixture_actor', 'fixture_account', 'SUCCEEDED', 'fixture_dataset', .005]);
    const processing = await rpc<{ job: { lease_token: string } }>('worker_claim_processing', [queued.job_id]);
    return { ...queued, lease: processing.job.lease_token };
  }
  async function record(id: string | null, patch: Record<string, unknown> = {}) {
    await identity();
    const shortcode = id ? await value<string>('select shortcode value from public.reels where id=$1', [id]) : `MISSED_${++sequence}`;
    return { creator_id: creator, username: 'spending_fixture', shortcode, reel_url: `https://www.instagram.com/reel/${shortcode}/`,
      fetched_at: new Date().toISOString(), published_at: '2026-08-01T00:00:00Z', provider: 'fixture', caption_preview: 'Full source title',
      caption_full: 'Complete source caption.\n\nSecond paragraph. #source', duration_seconds: 60,
      views: 456, likes: 10, comments: 2, views_state: 'known', likes_state: 'known', comments_state: 'known',
      media_source_url: 'https://scontent.cdninstagram.com/fresh.mp4', media_candidates: [], has_audio: true, ...patch };
  }
  async function ingest(job: Awaited<ReturnType<typeof start>>, records: Record<string, unknown>[]) {
    await identity('service_role');
    const args = [job.job_id, job.lease, 0, JSON.stringify(records), '[]', records.length, true, JSON.stringify({ [creator]: records.length })];
    const result = await rpc('worker_ingest_page', args);
    expect(await rpc('worker_ingest_page', args)).toMatchObject({ duplicate: true });
    await rpc('worker_record_output_summary', [job.job_id, job.lease, JSON.stringify({ ok: true, total_items: records.length,
      users: [{ creator_id: creator, username: 'spending_fixture', count: records.length, error: null }], complete: true, reason: null })]);
    await rpc('worker_finish_processing', [job.job_id, job.lease]);
    await rpc('worker_transcription_media_reconcile', [job.job_id]);
    return result;
  }
  it('refreshes every existing Reel, imports previously skipped Reels, and records complete captions once', async () => {
    const id = await reel(); await automatic();
    await identity(); await db.query("update public.reels set caption_full='Existing caption',caption_observed_at=now()-interval '1 day' where id=$1", [id]);
    const job = await start(); expect(job.target_count).toBe(1);
    const records = [await record(id), await record(null)]; await ingest(job, records);
    await identity('authenticated');
    const report = await rpc<import('../src/lib/types').CreatorSourceRefresh>('get_creator_source_refresh', [workspace, creator]);
    expect(report).toMatchObject({ status: 'succeeded', source_refresh: true, returned_reels: 2, expected_reels: 1, missing_reels: 0, missing_captions: 0, missing_media: 0, missing: [] });
    await identity();
    expect(await value<number>('select count(*)::int value from public.reels')).toBe(2);
    expect(await value<number>('select count(*)::int value from public.reel_fetch_observations')).toBe(2);
    expect(await value<string>('select caption_full value from public.reels where shortcode=$1', [records[1].shortcode])).toContain('Second paragraph.');
  });
  it('marks omitted Reels and incomplete fields as partial and preserves older valid values', async () => {
    const returned = await reel(); const omitted = await reel(); await automatic();
    await identity(); await db.query("update public.reels set thumbnail_url='https://images.example.test/old.jpg',caption_preview='Saved title',caption_full='Saved caption',caption_observed_at=now()-interval '1 day' where id=$1", [returned]);
    const job = await start();
    await ingest(job, [await record(returned, { caption_full: null, caption_preview: '', thumbnail_url: null, duration_seconds: null, views: null, views_state: 'not_fetched', media_source_url: null })]);
    await identity('authenticated');
    const report = await rpc<import('../src/lib/types').CreatorSourceRefresh>('get_creator_source_refresh', [workspace, creator]);
    expect(report).toMatchObject({ status: 'partial', expected_reels: 2, returned_reels: 1, missing_reels: 1, missing_captions: 1, missing_media: 1 });
    expect(report.missing).toEqual(expect.arrayContaining([expect.objectContaining({ reel_id: omitted, not_returned: true }), expect.objectContaining({ reel_id: returned, caption_missing: true, media_missing: true })]));
    const detail = await rpc<import('../src/lib/types').ReelDetail>('get_reel_detail', [workspace, returned]);
    expect(detail).toMatchObject({ caption_full: 'Saved caption', reel: { caption_preview: 'Saved title', latest_views: 123, duration_seconds: 60, thumbnail_url: 'https://images.example.test/old.jpg' } });
    await identity(); expect(await value<string>('select status value from public.transcription_media_refreshes where id=$1', [job.refresh_id])).toBe('settled');
  });
  it('retries only fresh, explicitly requested pre-submit media failures and preserves ready/uncertain jobs', async () => {
    const failed = await reel(); const ready = await reel(); const uncertain = await reel(); await automatic();
    await identity();
    await db.query("update public.transcript_jobs set status='media_unavailable',completed_at=now() where reel_id=$1", [failed]);
    await db.query("update public.transcript_jobs set status='ready' where reel_id=$1", [ready]);
    await db.query("insert into public.reel_transcripts(reel_id,model,options_version,status,text,language) values($1,'scribe_v2',1,'ready','Saved transcript','en')", [ready]);
    await db.query("update public.transcript_jobs set status='uncertain' where reel_id=$1", [uncertain]);
    const job = await start(); await ingest(job, [await record(failed), await record(ready), await record(uncertain)]);
    await identity();
    expect(await value<string>('select status value from public.transcript_jobs where reel_id=$1', [failed])).toBe('queued');
    expect(await value<string>('select status value from public.transcript_jobs where reel_id=$1', [uncertain])).toBe('uncertain');
    expect(await value<string>('select text value from public.reel_transcripts where reel_id=$1', [ready])).toBe('Saved transcript');
  });
  it('checks workspace ownership, denies direct helpers and deduplicates concurrent repair requests', async () => {
    await reel(); await automatic(); await identity('authenticated');
    const first = await rpc<{ job_id: string }>('request_creator_source_refresh', [workspace, creator]);
    expect(await rpc('request_creator_source_refresh', [workspace, creator])).toMatchObject({ job_id: first.job_id, reason: 'already_queued' });
    await expect(rpc('worker_transcription_source_refresh_enqueue', [creator])).rejects.toThrow(/permission denied/);
    await expect(db.exec('select * from public.reel_fetch_observations')).rejects.toThrow(/permission denied/);
    await identity('authenticated', stranger);
    for (const name of ['get_creator_source_refresh', 'request_creator_source_refresh']) await expect(rpc(name, [workspace, creator])).rejects.toThrow(/forbidden|not_authorized/);
    await identity(); expect(await value<number>('select count(*)::int value from public.transcription_media_refreshes')).toBe(1);
    expect(await value<number>('select sum(reserved_usd)::float8 value from public.transcription_media_refreshes')).toBe(0);
  });
  it('selects a verified audio candidate for playback without changing newer URLs or submitting speech', async () => {
    const id = await reel(); await automatic();
    const alternate = 'https://video.fbcdn.net/with-audio.mp4';
    await identity('service_role');
    await rpc('worker_observe_reel_media', [id, 'https://scontent.cdninstagram.com/fixture.mp4', JSON.stringify([alternate]), false, new Date().toISOString()]);
    const attempt = (await claim()).jobs[0];
    expect(await rpc('worker_transcription_select_media', [attempt.attempt_id, attempt.lease_token, 'https://video.fbcdn.net/unknown.mp4'])).toMatchObject({ selected: false });
    expect(await rpc('worker_transcription_select_media', [attempt.attempt_id, attempt.lease_token, alternate])).toEqual({ selected: true });
    await identity();
    expect(await value('select jsonb_build_object(\'source_url\',source_url,\'has_audio\',has_audio) value from public.reel_media_sources where reel_id=$1', [id])).toEqual({ source_url: alternate, has_audio: true });
    expect(await value<boolean>('select submit_authorized value from public.transcript_attempts where id=$1', [attempt.attempt_id])).toBe(false);
    await identity('authenticated'); await expect(rpc('worker_transcription_select_media', [attempt.attempt_id, attempt.lease_token, alternate])).rejects.toThrow(/permission denied/);
  });
  it('uses the existing full backfill for an empty competitor and never silently truncates more than 100 known targets', async () => {
    await automatic(); await identity('authenticated');
    const empty = await rpc<{ job_ids: string[] }>('request_creator_source_refresh', [workspace, creator]);
    expect(empty.job_ids).toHaveLength(1);
    await identity(); expect(await value<number>('select results_limit value from public.scrape_jobs where id=$1', [empty.job_ids[0]])).toBe(100);
    await db.query("update public.scrape_jobs set status='failed' where id=$1", [empty.job_ids[0]]);
    await db.query("insert into public.reels(creator_id,shortcode,reel_url,published_at,latest_fetched_at,provider) select $1,'OVER_'||i,'https://www.instagram.com/reel/OVER_'||i||'/','2026-08-01T00:00:00Z',now(),'fixture' from generate_series(1,101) i", [creator]);
    await identity('authenticated');
    expect(await rpc('request_creator_source_refresh', [workspace, creator])).toMatchObject({ job_id: null, reason: 'source_coverage_limit', target_count: 101 });
  });
});

describe('immediate automatic transcription dispatch in actual PostgreSQL', () => {
  it('claims two automatic attempts and fences a competing claim at the configured concurrency', async () => {
    await wakeFixture(); await reel(); await reel(); await reel();
    const first = await claim();
    expect(first.jobs).toHaveLength(2);
    expect(new Set(first.jobs.map(job => job.attempt_id)).size).toBe(2);
    expect(await claim()).toMatchObject({ jobs: [], reason: 'concurrency' });
    await identity();
    expect(await value<number>('select sum(reserved_usd)::float8 value from public.transcript_attempts')).toBe(.16);
  });

  it('keeps pilot claims bounded to one even when the caller requests two', async () => {
    await activate(); await reel(); await reel();
    expect((await claim()).jobs).toHaveLength(1);
  });

  it('coalesces a bulk ingestion transaction into one private dispatch request', async () => {
    await wakeFixture();
    await db.exec('begin');
    try { await reel(); await reel(); await reel(); await db.exec('commit'); }
    catch (error) { await db.exec('rollback'); throw error; }
    await identity();
    const requests = (await db.query<{ url: string; body: unknown; headers: Record<string, string> }>('select url,body,headers from net.requests')).rows;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: 'https://project.supabase.co/functions/v1/transcript-dispatch', body: { action: 'dispatch' } });
    expect(requests[0].headers['x-internal-secret']).toBe('a'.repeat(64));
    expect(JSON.stringify(requests[0].body)).not.toMatch(/secret|source_url|lease_token/);
  });

  it('rolls back both ingestion and its wake when the transaction rolls back', async () => {
    await wakeFixture(); await db.exec('begin');
    const id = await reel(); await db.exec('rollback'); await identity();
    expect(await value<number>('select count(*)::int value from net.requests')).toBe(0);
    expect(await value<number>('select count(*)::int value from public.reels where id=$1', [id])).toBe(0);
  });

  it('refills a free slot after completion and ignores a duplicate callback', async () => {
    await wakeFixture(); await reel(); await reel(); await reel();
    const first = (await claim()).jobs[0];
    await rpc('worker_transcription_before_submit', [first.attempt_id, first.lease_token]);
    await rpc('worker_transcription_attach', [first.attempt_id, first.lease_token, 'fixture_ready', 'fixture_ready_transcript']);
    await identity(); await db.exec('truncate net.requests'); await identity('service_role');
    expect(await rpc('worker_transcription_complete', [first.attempt_id, first.lease_token, 'Completed fixture', 'en', '[]', false, null])).toMatchObject({ status: 'ready', duplicate: false });
    expect(await rpc('worker_transcription_complete', [first.attempt_id, first.lease_token, 'Completed fixture', 'en', '[]', false, null])).toMatchObject({ status: 'ready', duplicate: true });
    await identity();
    expect(await value<number>('select count(*)::int value from net.requests')).toBe(1);
    expect((await claim()).jobs).toHaveLength(1);
  });

  it('does not wake paused automation and wakes once when the owner resumes it', async () => {
    await wakeFixture(); await settings({ paused: true }); await reel(); await identity();
    expect(await value<number>('select count(*)::int value from net.requests')).toBe(0);
    await settings({ paused: false }); await identity();
    expect((await db.query('select body from net.requests')).rows).toEqual([{ body: { action: 'maintenance' } }]);
  });

  it('does not invoke the dispatcher without a unique valid maintenance secret', async () => {
    await wakeFixture(); await identity();
    await db.exec("delete from vault.secrets where name='reelradar_transcription_maintenance_v1'");
    await reel(); await identity();
    expect(await value<number>('select count(*)::int value from net.requests')).toBe(0);
    await db.exec("insert into vault.secrets(name,secret) values('reelradar_transcription_maintenance_v1','malformed')");
    await reel(); await identity();
    expect(await value<number>('select count(*)::int value from net.requests')).toBe(0);
  });

  it('wakes missing-media recovery after an explicit request and continues after settlement', async () => {
    await wakeFixture(); const id = await reel(false); await identity();
    expect((await db.query('select body from net.requests')).rows).toEqual([]);
    await identity('authenticated'); await rpc('request_reel_transcript', [workspace, id]); await identity();
    expect((await db.query('select body from net.requests')).rows).toEqual([{ body: { action: 'maintenance' } }]);
    await db.exec('truncate net.requests');
    await recoverMedia(id); await identity();
    expect((await db.query('select body from net.requests')).rows).toContainEqual({ body: { action: 'maintenance' } });
    expect((await claim()).jobs).toHaveLength(1);
  });

  it('does not expose any wake helper as an anonymous, authenticated, or service RPC', async () => {
    await identity();
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const signature of ['public.transcription_request_wake(text)', 'public.transcription_job_wake()', 'public.transcription_media_settled_wake()', 'public.transcription_settings_wake()']) {
        expect(await value<boolean>('select has_function_privilege($1,$2,\'EXECUTE\') value', [role, signature])).toBe(false);
      }
    }
  });
});

describe('owner-only personal spending settings in actual PostgreSQL', () => {
  it('accepts owner ceilings above the former $4/$5 caps and research capacity up to 1000', async () => {
    expect(await settings({ monthly_budget_usd: 10000, budget_warning_pct: 90 })).toMatchObject({ monthly_budget_usd: 10000, budget_warning_pct: 90, enabled: false, paused: true });
    expect(await rpc('update_settings', [JSON.stringify({ monthly_budget_usd: 10000, capacity: 1000 })])).toMatchObject({ monthly_budget_usd: 10000, capacity: 1000 });
    expect(await settings({ monthly_budget_usd: .000001 })).toMatchObject({ monthly_budget_usd: .000001 });
  });

  it('denies anonymous, non-owner and service-role preference updates', async () => {
    for (const [role, sub] of [['anon', owner], ['authenticated', stranger], ['service_role', owner]]) {
      await identity(role, sub);
      await expect(rpc('update_transcription_settings', ['{"monthly_budget_usd":25}'])).rejects.toThrow(/permission denied|forbidden/);
    }
    await identity();
    expect(await value<number>('select monthly_budget_usd::float8 value from public.transcription_settings')).toBe(5);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(await value<boolean>("select has_table_privilege($1,'public.transcription_settings','insert,update,delete') value", [role])).toBe(false);
    }
  });

  it('rejects invalid JSON fields and numeric precision before any settings change', async () => {
    await identity('authenticated');
    for (const patch of [
      'null', '[]', '{}', '{"paused":null}', '{"paused":"false"}', '{"monthly_budget_usd":null}',
      '{"monthly_budget_usd":"25"}', '{"monthly_budget_usd":-1}', '{"monthly_budget_usd":10000.000001}',
      '{"monthly_budget_usd":0.0000001}', '{"monthly_budget_usd":1e-100}', '{"monthly_budget_usd":20.1234567}',
      '{"budget_warning_pct":0}', '{"budget_warning_pct":101}', '{"budget_warning_pct":80.5}',
      '{"budget_warning_pct":"80"}', '{"budget_warning_pct":null}', '{"paused":false,"unknown":1}',
    ]) await expect(rpc('update_transcription_settings', [patch])).rejects.toThrow();
    expect(await rpc('get_transcription_overview')).toMatchObject({ monthly_budget_usd: 5, budget_warning_pct: 80, paused: true });
  });

  it('cannot activate processing or change the pilot, credentials or worker guards', async () => {
    await identity('authenticated');
    for (const key of ['enabled', 'phase', 'pilot_limit_usd', 'pilot_verified', 'key_validated', 'contract_validated', 'account_pricing_validated', 'max_starts', 'concurrency', 'reservation_usd', 'max_duration_seconds', 'max_media_bytes', 'media_recovery_enabled']) {
      await expect(rpc('update_transcription_settings', [JSON.stringify({ paused: false, monthly_budget_usd: 25, [key]: true })])).rejects.toThrow();
    }
    expect(await settings({ paused: false, monthly_budget_usd: 25 })).toMatchObject({ enabled: false, paused: false, phase: 'pilot', processing_ready: false });
    await identity('service_role');
    await expect(rpc('worker_transcription_configure', [true, true, 'pilot', 25, .25, true])).rejects.toThrow(/use_transcription_activate/);
    await expect(rpc('worker_transcription_activate', ['automatic'])).rejects.toThrow(/activation_unvalidated|pilot_unverified/);
    await expect(rpc('worker_transcription_validate_account', [.23, .08])).rejects.toThrow(/pricing_bounds_exceeded/);
    expect(await claim()).toMatchObject({ jobs: [], reason: 'disabled' });
  });

  it('serializes concurrent partial preferences and retains pause-only compatibility', async () => {
    await identity('authenticated');
    await Promise.all([
      rpc('update_transcription_settings', ['{"monthly_budget_usd":75}']),
      rpc('update_transcription_settings', ['{"budget_warning_pct":95}']),
      rpc('update_transcription_preferences', [false]),
    ]);
    expect(await rpc('get_transcription_overview')).toMatchObject({ monthly_budget_usd: 75, budget_warning_pct: 95, paused: false, enabled: false });
  });

  it('preserves an owner ceiling when operator disable/configure arguments omit budgets', async () => {
    await settings({ monthly_budget_usd: 75, budget_warning_pct: 90 });
    await identity('service_role');
    await rpc('worker_transcription_configure', [false]);
    await identity('authenticated');
    expect(await rpc('get_transcription_overview')).toMatchObject({ monthly_budget_usd: 75, budget_warning_pct: 90, enabled: false, pilot_limit_usd: .25 });
  });
});

describe('transactional ceilings and private combined accounting', () => {
  it('ignores exhausted historical envelopes and the legacy run cap without deleting their audit links', async () => {
    await activate();
    const pending = await normalJob();
    await identity();
    const envelope = await value<string>('insert into public.budget_envelopes(owner_user_id,limit_usd,active,deactivated_at) values($1,.25,false,now()) returning id value', [owner]);
    await db.query("insert into public.scrape_jobs(owner_user_id,kind,status,requested_profiles_count,results_limit,live,apify_account_slot,expected_provider_user_id,actual_cost_usd,billing_month,billing_reconciled_at,envelope_id) values($1,'manual','succeeded',1,10,true,1,'fixture_account',.25,date_trunc('month',now())::date,now()-interval '1 minute',$2)", [owner, envelope]);
    await db.query('update public.scrape_jobs set envelope_id=$1 where id=$2', [envelope, pending]);
    await db.query('update public.app_settings set monthly_budget_usd=50,max_run_charge_usd=.000001 where owner_user_id=$1', [owner]);
    await identity('service_role');
    expect(await rpc('worker_claim_dispatch', [owner, true, 'fixture_actor', 'manual'])).toMatchObject({ job: { id: pending, envelope_id: envelope, reserved_usd: .1 }, max_total_charge_usd: .1 });
    await expect(rpc('worker_configure_budget_envelope', [owner, .25])).rejects.toThrow(/use_monthly_collection_budget/);
  });

  it('shares fractional monthly headroom across concurrent collection claims without exceeding it', async () => {
    await activate(); await normalJob(); await normalJob(); await normalJob();
    await identity('service_role');
    // Two simultaneous paid claims require two independently verified accounts.
    await rpc('worker_configure_apify_account', [owner, 2, 'fixture_secondary', true, true]);
    await db.query("select public.worker_record_account_usage($1,2,'fixture_secondary',date_trunc('month',now()),date_trunc('month',now())+interval '1 month',0,100)", [owner]);
    await identity('authenticated'); await rpc('update_settings', ['{"monthly_budget_usd":1.000001}']);
    await identity('service_role');
    const claims = await Promise.all([rpc<{ job: { id: string; apify_account_slot: number; reserved_usd: number } }>('worker_claim_dispatch', [owner, true, 'fixture_actor', 'manual']), rpc<{ job: { id: string; apify_account_slot: number; reserved_usd: number } }>('worker_claim_dispatch', [owner, true, 'fixture_actor', 'manual'])]);
    expect(claims.map(c => c.job.reserved_usd)).toEqual([.1, .1]);
    expect(claims.map(c => c.job.apify_account_slot)).toEqual([1, 2]);
    expect(new Set(claims.map(c => c.job.id)).size).toBe(2);
    expect(await rpc('worker_claim_dispatch', [owner, true, 'fixture_actor', 'manual'])).toMatchObject({ reason: 'concurrency_limit' });
    await identity('authenticated'); await rpc('update_settings', ['{"monthly_budget_usd":0}']);
    const bootstrap = await rpc<{ usage: { reserved_usd: number; remaining_allowance: number } }>('get_bootstrap');
    expect(bootstrap.usage).toMatchObject({ reserved_usd: .2, remaining_allowance: 0 });
  });

  it('charges media recovery only to collection even when the transcription monthly budget is zero', async () => {
    await automaticFixture(); await reel(false);
    await settings({ monthly_budget_usd: 0 });
    await identity('authenticated'); await rpc('update_settings', ['{"monthly_budget_usd":0.035}']);
    await identity('service_role');
    const refresh = await rpc<{ job_id: string; refresh_id: string }>('worker_transcription_media_enqueue', [creator]);
    expect(refresh.job_id).toBeTruthy();
    const context = await rpc<{ job: { dispatch_nonce: string; reserved_usd: number } }>('worker_transcription_media_claim', [refresh.job_id, 'fixture_actor']);
    // The fixture's earlier recovery cost .005; the remaining .030 belongs only to collection.
    expect(context.job.reserved_usd).toBe(.03);
    await rpc('worker_attach_run', [refresh.job_id, context.job.dispatch_nonce, 'budget_media', 'fixture_actor', 'fixture_account', 'budget_dataset']);
    await rpc('worker_reconcile_run', [refresh.job_id, 'budget_media', 'fixture_actor', 'fixture_account', 'SUCCEEDED', 'budget_dataset', .02]);
    await identity('authenticated');
    expect(await rpc('get_transcription_overview')).toMatchObject({ monthly_budget_usd: 0, reserved_usd: 0, accounted_month_spend: .08, actual_month_spend: null });
    expect((await rpc<{ usage: Record<string, unknown> }>('get_bootstrap')).usage).toMatchObject({ actual_month_spend: .025, reserved_usd: 0, remaining_allowance: .01 });
  });

  it('uses the monthly transcription budget even when the legacy pilot money cap is zero', async () => {
    await activate(); await reel();
    await identity(); await db.exec('update public.transcription_settings set pilot_limit_usd=0');
    expect((await claim()).jobs).toHaveLength(1);
    await identity('authenticated');
    expect(await rpc('get_transcription_overview')).toMatchObject({ reserved_usd: .08, monthly_budget_usd: 5 });
  });

  it('blocks new paid claims at zero without altering activation state', async () => {
    await activate(); await reel(); await settings({ monthly_budget_usd: 0 });
    expect(await claim()).toMatchObject({ jobs: [], reason: 'budget_paused' });
    await identity('authenticated');
    expect(await rpc('get_transcription_overview')).toMatchObject({ monthly_budget_usd: 0, enabled: true, reserved_usd: 0, actual_month_spend: null });
  });

  it('reports pilot processing blocked after three cancelled starts even with unused money', async () => {
    await activate(); await reel();
    for (let i = 0; i < 3; i++) {
      const attempt = (await claim()).jobs[0]; expect(attempt).toBeDefined();
      await settings({ paused: true });
      await identity('service_role');
      expect(await rpc('worker_transcription_before_submit', [attempt.attempt_id, attempt.lease_token])).toMatchObject({ allow: false, reason: 'paused' });
      await rpc('worker_transcription_cancel_not_started', [attempt.attempt_id, attempt.lease_token]);
      await settings({ paused: false });
    }
    await identity('authenticated');
    expect(await rpc('get_transcription_overview')).toMatchObject({ enabled: true, paused: false, reserved_usd: 0, accounted_month_spend: 0, processing_ready: false });
    await identity();
    expect(await value<number>('select count(*)::int value from public.transcript_attempts')).toBe(3);
  });

  it('retains existing holds when a ceiling is lowered and serializes new reservations', async () => {
    await activate(); await reel(); await reel(); await reel(); await settings({ monthly_budget_usd: .09 });
    await identity('service_role');
    const claims = await Promise.all([rpc<Claim>('worker_transcription_claim', [2]), rpc<Claim>('worker_transcription_claim', [2])]);
    expect(claims.flatMap(claim => claim.jobs)).toHaveLength(1);
    await settings({ monthly_budget_usd: .01 });
    expect(await claim()).toMatchObject({ jobs: [], reason: 'budget_paused' });
    await identity('authenticated');
    expect(await rpc('get_transcription_overview')).toMatchObject({ monthly_budget_usd: .01, reserved_usd: .08, actual_month_spend: null, spending_warning: true });
    await identity();
    expect(await value<number>('select count(*)::int value from public.transcript_attempts')).toBe(1);
  });

  it('includes older-month speech holds without charging media to the transcription budget', async () => {
    await activate(); const mediaReel = await reel(false); await reel(); await reel();
    await identity('service_role'); await rpc('worker_transcription_manifest', [41]);
    const media = await rpc<{ refresh_id: string }>('worker_transcription_media_enqueue', [creator]);
    const first = (await claim()).jobs[0]; expect(first).toBeDefined();
    await identity();
    await db.query("update public.transcript_attempts set billing_month=(date_trunc('month',now())-interval '1 month')::date where id=$1", [first.attempt_id]);
    await db.query("update public.transcription_media_refreshes set billing_month=(date_trunc('month',now())-interval '1 month')::date where id=$1", [media.refresh_id]);
    await settings({ monthly_budget_usd: .1 });
    expect(await claim()).toMatchObject({ jobs: [], reason: 'budget_paused' });
    await identity('authenticated');
    const overview = await rpc('get_transcription_overview');
    expect(overview).toMatchObject({ accounted_month_spend: 0, reserved_usd: .08, actual_month_spend: null });
    expect(JSON.stringify(overview)).not.toMatch(/cdninstagram|source_url|lease_token|dispatch_nonce|inert-fixture-key|secret_id/);
    expect(mediaReel).toBeTruthy();
  });

  it('bounds provider run allowance by the configured job cap while keeping monthly and provider quotas enforced', async () => {
    await activate();
    await identity('authenticated'); await rpc('update_settings', ['{"monthly_budget_usd":25}']);
    await identity();
    await db.query("insert into public.scrape_jobs(owner_user_id,kind,status,requested_profiles_count,results_limit,live,apify_account_slot,expected_provider_user_id,actual_cost_usd,billing_month,billing_reconciled_at) values($1,'manual','succeeded',1,10,true,1,'fixture_account',4.5,date_trunc('month',now())::date,now()-interval '1 minute')", [owner]);
    const pending = await normalJob();
    await identity('service_role');
    expect(await rpc('worker_claim_dispatch', [owner, true, 'fixture_actor', 'manual'])).toMatchObject({ job: { id: pending, reserved_usd: .1 }, max_total_charge_usd: .1 });
    await identity('authenticated');
    expect((await rpc<{ usage: Record<string, unknown> }>('get_bootstrap')).usage).toMatchObject({ remaining_allowance: 20.4 });
    const second = await normalJob();
    await identity(); await db.query('update public.app_settings set provider_cycle_limit_usd=.15 where owner_user_id=$1', [owner]);
    await db.query('update public.apify_accounts set limit_usd=.15 where owner_id=$1 and slot=1', [owner]);
    await identity('service_role');
    expect(await rpc('worker_claim_dispatch', [owner, true, 'fixture_actor', 'manual'])).toMatchObject({ reason: 'account_capacity_full' });
    const nonce = await value<string>('select dispatch_nonce value from public.scrape_jobs where id=$1', [pending]);
    expect(await rpc('worker_cancel_pre_submit', [owner, pending, nonce, 'Synthetic quota check after cancelling unsubmitted claim'])).toMatchObject({ cancelled: true });
    expect(await rpc('worker_claim_dispatch', [owner, true, 'fixture_actor', 'manual'])).toMatchObject({ reason: 'budget_paused' });
    await identity(); expect(await value<number>('select reserved_usd::float8 value from public.scrape_jobs where id=$1', [second])).toBe(0);
  });

  it('counts the complete authorized backlog while only returning the latest 100 public jobs', async () => {
    await identity();
    await db.query("insert into public.reels(creator_id,shortcode,reel_url,published_at,duration_seconds,latest_fetched_at,provider,latest_views,views_state) select $1,'BACKLOG_'||n,'https://www.instagram.com/reel/fixture/','2026-08-01T00:00:00Z',60,now(),'fixture',123,'known' from generate_series(1,105) n", [creator]);
    await db.query("insert into public.transcript_jobs(reel_id,status,priority_requested_at) select id,'queued',now() from public.reels where creator_id=$1", [creator]);
    await identity('authenticated');
    const overview = await rpc<{ jobs: unknown[]; job_counts: { queued: number } }>('get_transcription_overview');
    expect(overview.jobs).toHaveLength(100);
    expect(overview.job_counts.queued).toBe(105);
    await identity();
    expect(await value<number>('select count(*)::int value from cron.job')).toBe(0);
    expect(await value<number>('select count(*)::int value from net.requests')).toBe(0);
  });
});

describe('continuous automatic media recovery after a verified fixture pilot', () => {
  it('preserves terminal media failure when stale, rejected or null observations retain the old source', async () => {
    await automaticFixture();
    const unavailable = await reel();
    const attempt = (await claim()).jobs[0]; expect(attempt).toBeDefined();
    expect(await rpc('worker_transcription_fail', [attempt.attempt_id, attempt.lease_token, 'media_unavailable', 'Fixture download rejected', null])).toMatchObject({ status: 'media_unavailable' });
    await identity();
    // Make the queue due so the no-new-claim assertion cannot pass merely because
    // the failed attempt's five-minute retry timestamp is still in the future.
    await db.query("update public.transcript_jobs set next_attempt_at=now()-interval '1 second' where reel_id=$1", [unavailable]);
    const completed = await value<string>('select completed_at::text value from public.transcript_jobs where reel_id=$1', [unavailable]);
    await identity('service_role');
    expect(await rpc('worker_observe_reel_media', [unavailable, 'https://scontent.cdninstagram.com/replacement.mp4', '[]', true, new Date(Date.now() - 60_000).toISOString()])).toMatchObject({ status: 'media_unavailable' });
    await expect(rpc('worker_observe_reel_media', [unavailable, 'http://scontent.cdninstagram.com/rejected.mp4', '[]', true, new Date().toISOString()])).rejects.toThrow(/invalid_media_source/);
    expect(await rpc('worker_observe_reel_media', [unavailable, null, '[]', true, new Date().toISOString()])).toMatchObject({ status: 'media_unavailable' });
    expect(await claim()).toMatchObject({ jobs: [] });
    await identity();
    expect(await value<string>('select source_url value from public.reel_media_sources where reel_id=$1', [unavailable])).toBe('https://scontent.cdninstagram.com/fixture.mp4');
    expect(await value<string>('select completed_at::text value from public.transcript_jobs where reel_id=$1', [unavailable])).toBe(completed);
    expect(await value<number>('select attempt_count value from public.transcript_jobs where reel_id=$1', [unavailable])).toBe(1);
    expect(await value<number>('select count(*)::int value from public.reel_transcripts where reel_id=$1', [unavailable])).toBe(0);
  });

  it('recovers newly observed videos after the original target refresh has settled', async () => {
    const { original, refresh } = await automaticFixture();
    const fresh = await reel(false);
    await identity('service_role');
    const candidates = await rpc<{ creators: { creator_id: string }[] }>('worker_transcription_media_candidates');
    expect(candidates.creators.some(candidate => candidate.creator_id === creator)).toBe(true);
    const next = await recoverMedia(fresh);
    expect(next.refresh_id).not.toBe(refresh.refresh_id);
    expect(next.target_count).toBe(1);
    const attempt = (await claim()).jobs[0]; expect(attempt).toBeDefined();
    await identity();
    expect(await value<string[]>('select array_agg(reel_id::text) value from public.transcription_media_targets where refresh_id=$1', [next.refresh_id])).toEqual([fresh]);
    expect(await value<number>('select count(*)::int value from public.transcription_media_targets where reel_id=$1', [original])).toBe(1);
    await identity('authenticated');
    expect(await rpc('get_transcription_overview')).toMatchObject({ actual_month_spend: null, accounted_month_spend: .08, reserved_usd: .08, phase: 'automatic' });
  });

  it('keeps unsuccessful persisted targets excluded while accepting different new targets', async () => {
    await automaticFixture();
    const unavailable = await reel(false);
    const failedRefresh = await recoverMedia(null);
    await identity();
    expect(await value<string>('select status value from public.transcript_jobs where reel_id=$1', [unavailable])).toBe('media_unavailable');
    await identity('service_role');
    expect(await rpc('worker_transcription_media_candidates')).toMatchObject({ creators: [] });
    const fresh = await reel(false);
    await identity('service_role');
    const next = await rpc<{ refresh_id: string; target_count: number }>('worker_transcription_media_enqueue', [creator]);
    expect(next.target_count).toBe(1); expect(next.refresh_id).not.toBe(failedRefresh.refresh_id);
    await identity();
    expect(await value<string[]>('select array_agg(reel_id::text) value from public.transcription_media_targets where refresh_id=$1', [next.refresh_id])).toEqual([fresh]);
    expect(await value<number>('select count(*)::int value from public.transcription_media_targets where reel_id=$1', [unavailable])).toBe(1);
    expect(await value<string>('select status value from public.transcript_jobs where reel_id=$1', [unavailable])).toBe('media_unavailable');
  });

  it('bounds requested refresh target sets at 100 and deduplicates concurrent same-creator enqueue', async () => {
    await automaticFixture();
    await identity();
    await db.query("insert into public.reels(creator_id,shortcode,reel_url,published_at,duration_seconds,latest_fetched_at,provider,latest_views,views_state) select $1,'AUTO_'||n,'https://www.instagram.com/reel/fixture/','2026-08-01T00:00:00Z',60,now(),'fixture',123,'known' from generate_series(1,102) n", [creator]);
    await identity('service_role');
    const ids = (await db.query<{ id: string }>("select id from public.reels where shortcode like 'AUTO_%'")).rows.map(row => row.id);
    for (const id of ids) await rpc('worker_observe_reel_media', [id, null, '[]', true, new Date().toISOString()]);
    await identity();
    await db.query('update public.transcript_jobs set priority_requested_at=now() where reel_id=any($1::uuid[])', [ids]);
    await identity('service_role');
    const refreshes = await Promise.all([
      rpc<{ refresh_id: string; target_count: number }>('worker_transcription_media_enqueue', [creator]),
      rpc<{ refresh_id: string; target_count: number }>('worker_transcription_media_enqueue', [creator]),
    ]);
    expect(new Set(refreshes.map(refresh => refresh.refresh_id)).size).toBe(1);
    expect(refreshes[0].target_count).toBe(100);
    await identity();
    expect(await value<number>('select count(*)::int value from public.transcription_media_targets where refresh_id=$1', [refreshes[0].refresh_id])).toBe(100);
    expect(await value<number>("select count(*)::int value from public.transcription_media_refreshes where status='active'")).toBe(1);
  }, 60_000);

  it('continues to freeze pilot recovery at 41 targets and keeps later pilot videos ineligible', async () => {
    for (let i = 0; i < 43; i++) await reel(false);
    await identity('service_role'); await rpc('worker_transcription_manifest', [41]);
    await activate();
    const late = await reel(false);
    await identity('service_role');
    const refresh = await rpc<{ target_count: number }>('worker_transcription_media_enqueue', [creator]);
    expect(refresh.target_count).toBe(41);
    await identity();
    expect(await value<boolean>('select media_recovery_eligible value from public.transcript_jobs where reel_id=$1', [late])).toBe(false);
  }, 60_000);
});

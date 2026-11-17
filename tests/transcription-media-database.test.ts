import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const db = new PGlite();
const root = join(process.cwd(), 'supabase/migrations');
const owner = 'd1000000-0000-4000-8000-000000000001';
let workspace: string, creator: string, other: string, originalClaim: string;
let sequence = 0;
type Enqueued = { job_id: string; refresh_id: string; target_count: number; reason: string | null };
type Attempt = { id: string; reel_id: string; attempt_id: string; lease_token: string };
type Context = { job?: { id: string; reserved_usd: number; lease_token: string; dispatch_nonce: string }; max_total_charge_usd?: number; reason?: string };
async function value<T>(sql: string, args: unknown[] = []): Promise<T> {
  return (await db.query<{ value: T }>(sql, args)).rows[0].value;
}
async function rpc<T = Record<string, unknown>>(name: string, args: unknown[] = []): Promise<T> {
  return value<T>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) value`, args);
}
async function identity(role = 'postgres') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role, sub: owner })]);
  if (role !== 'postgres') await db.exec(`set role ${role}`);
}
async function reel(cid = creator, duration: number | null = 60) {
  await identity();
  return value<string>("insert into public.reels(creator_id,shortcode,reel_url,published_at,duration_seconds,latest_fetched_at,provider,latest_views,views_state) values($1,$2,'https://www.instagram.com/reel/fixture/','2026-08-01T00:00:00Z',$3,now(),'fixture',123,'known') returning id value", [cid, `MEDIA_${++sequence}`, duration]);
}
async function seed(ids: string[]) {
  await identity('service_role');
  for (const id of ids) await rpc('worker_observe_reel_media', [id, null, '[]', null, new Date().toISOString()]);
  await rpc('worker_transcription_manifest', [41]);
}
async function activate(monthly = 5, pilot = .25) {
  await identity('service_role');
  await rpc('worker_transcription_configure', [true, false, 'pilot', monthly, pilot, true]);
  await rpc('worker_transcription_validate_account', [.22, .08]);
  await identity();
  const sid = await value<string>("select vault.create_secret('fixture-not-a-real-key','reelradar_transcription_webhook_hmac_v1','fixture') value");
  await db.query("update public.transcription_webhook_setup set status='configured',webhook_id='fixture_hook',secret_id=$1 where singleton", [sid]);
  await db.query("update public.app_settings set scraping_enabled=true,paused=false,max_run_charge_usd=.10,provider_account_id='fixture_account',provider_usage_checked_at=now(),provider_cycle_start_at=date_trunc('month',now()),provider_cycle_end_at=date_trunc('month',now())+interval '1 month',provider_cycle_usage_usd=0,provider_cycle_limit_usd=4 where owner_user_id=$1", [owner]);
  await identity('service_role');
  await rpc('worker_transcription_activate', ['pilot']);
}
async function enqueue(cid = creator) { return rpc<Enqueued>('worker_transcription_media_enqueue', [cid]); }
async function claim() { return rpc<{ jobs: Attempt[]; reason: string | null }>('worker_transcription_claim', [2]); }
async function mediaProcessing(e: Enqueued, actual: number | null = .005) {
  const ctx = await rpc<Context>('worker_transcription_media_claim', [e.job_id, 'fixture_actor']);
  expect(ctx.job?.id).toBe(e.job_id);
  await rpc('worker_attach_run', [e.job_id, ctx.job!.dispatch_nonce, `run_${e.job_id}`, 'fixture_actor', 'fixture_account', 'fixture_dataset']);
  await rpc('worker_reconcile_run', [e.job_id, `run_${e.job_id}`, 'fixture_actor', 'fixture_account', 'SUCCEEDED', 'fixture_dataset', actual]);
  const processing = await rpc<Context>('worker_claim_processing', [e.job_id]);
  return processing.job!.lease_token;
}
async function record(id: string, overrides: Record<string, unknown> = {}) {
  await identity();
  const shortcode = await value<string>('select shortcode value from public.reels where id=$1', [id]);
  await identity('service_role');
  return { creator_id: creator, username: 'harshpanwar', shortcode, fetched_at: new Date().toISOString(), duration_seconds: 65,
    media_source_url: 'https://scontent.cdninstagram.com/fresh.mp4', media_candidates: [], has_audio: true, ...overrides };
}
async function page(e: Enqueued, lease: string, rows: Record<string, unknown>[], cursor = 0, finished = true, next = cursor + rows.length) {
  return rpc('worker_ingest_page', [e.job_id, lease, cursor, JSON.stringify(rows), '[]', next, finished, JSON.stringify({ [creator]: rows.length })]);
}
async function finalizeMedia(e: Enqueued, lease: string) {
  // The provider's latest100 harvest can end at fewer rows; never rewrite its existing summary contract.
  await rpc('worker_finish_processing', [e.job_id, lease]);
  return rpc('worker_transcription_media_reconcile', [e.job_id]);
}
async function complete(a: Attempt) {
  expect(await rpc('worker_transcription_before_submit', [a.attempt_id, a.lease_token])).toMatchObject({ allow: true });
  await rpc('worker_transcription_attach', [a.attempt_id, a.lease_token, `speech_${a.attempt_id}`, `transcript_${a.attempt_id}`]);
  return rpc('worker_transcription_complete', [a.attempt_id, a.lease_token, 'Verified fixture speech', 'en', '[]', false, null]);
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
    -- Full historical bootstrap, with hosted facilities replaced ONLY by local inert stand-ins.
    create schema vault; create schema cron; create schema net;
    create table vault.secrets(id uuid primary key default gen_random_uuid(),name text,secret text);
    create view vault.decrypted_secrets as select id,name,secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(value text,label text,description text) returns uuid language sql as $$ insert into vault.secrets(name,secret) values(label,value) returning id $$;
    create table cron.job(jobid bigint generated always as identity primary key,jobname text unique,schedule text,command text,active boolean default true);
    create function cron.schedule(label text,schedule text,command text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values(label,schedule,command) returning jobid $$;
    create table net.requests(id bigint generated always as identity,url text,headers jsonb,body jsonb);
    create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as $$ insert into net.requests(url,headers,body) values(url,headers,body) returning id $$;
  `);
  for (const file of [
    '202611080001_schema.sql','202611080002_queue.sql','202611080003_initial_backfill_and_usage.sql',
    '202611080004_nullable_provider_timestamps.sql','202611080005_assumed_ist_publication.sql',
    '202611080006_owner_realtime_revision.sql','202611080007_transcription.sql','202611080008_transcription_maintenance.sql',
    '202611080009_advanced_reel_filters.sql','202611090010_transcription_webhook_setup.sql',
  ]) {
    await db.exec(readFileSync(join(root, file), 'utf8').replace(/^create extension[^;]+;\s*/gm, ''));
  }
  originalClaim = await value<string>("select prosrc value from pg_proc where oid='public.worker_claim_dispatch(uuid,boolean,text,text)'::regprocedure");
  // Emulate equivalent hosted007 definitions with different formatting/local names.
  // 011 must explicitly replace these, not assume pg_get_functiondef matches local files.
  for (const signature of ['worker_transcription_claim(integer)','worker_transcription_manifest(integer)','worker_observe_reel_media(uuid,text,jsonb,boolean,timestamptz)','transcription_enqueue(uuid)']) {
    const definition = await value<string>('select pg_get_functiondef($1::regprocedure) value', [`public.${signature}`]);
    const compressed = definition.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ')
      .replace(/(?<!')\bjobs\b(?!')/g, 'claimed_jobs');
    await db.exec(compressed);
  }
  await db.exec(readFileSync(join(root, '202611090011_transcription_media_recovery.sql'), 'utf8'));
  await db.query('insert into auth.users values($1)', [owner]);
  await identity('service_role'); await rpc('provision_owner', [owner]);
  await identity('authenticated'); workspace = (await rpc<{ id: string }>('create_workspace', ['Recovery fixture'])).id;
  await identity();
  creator = await value<string>("insert into public.creators(username,status) values('harshpanwar','active') returning id value");
  other = await value<string>("insert into public.creators(username,status) values('other_fixture','active') returning id value");
  await db.query('insert into public.workspace_creators(workspace_id,creator_id) values($1,$2),($1,$3)', [workspace, creator, other]);
}, 60000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await identity();
  await db.exec('truncate public.transcription_media_targets,public.transcription_media_refreshes,public.transcript_jobs,public.transcript_attempts,public.reel_transcripts,public.reel_media_sources,public.reels,public.scrape_jobs,public.creator_initializations,public.budget_envelopes cascade');
  await db.exec("update public.transcription_settings set enabled=false,paused=true,key_validated=false,contract_validated=false,phase='pilot',monthly_budget_usd=5,pilot_limit_usd=.25,manifest_seeded=false,media_recovery_enabled=false,pilot_verified=false,account_pricing_validated=false; update public.transcription_webhook_setup set status='idle',webhook_id=null,secret_id=null; delete from vault.secrets");
  await db.query("update public.creators set status='active' where id in ($1,$2)", [creator, other]);
  await db.query('update public.workspaces set archived_at=null where id=$1', [workspace]);
  await db.query('update public.workspace_creators set active=true where workspace_id=$1', [workspace]);
  await db.query('update public.app_settings set scraping_enabled=false,paused=true,monthly_budget_usd=4,max_run_charge_usd=.10 where owner_user_id=$1', [owner]);
});

describe('011 private ledger and activation contracts', () => {
  it('loads all prior migrations including010 and preserves the original dispatch policy', async () => {
    const core = await value<string>("select prosrc value from pg_proc where oid='public.transcription_claim_dispatch_core(uuid,boolean,text,text)'::regprocedure");
    for (const guard of ['globalscraping_disabled','initial_backfill_disabled','live_setup_or_usage_unverified','unreconciled_charges','concurrency_limit','manual_authorization_required','provider_cycle_usage_usd+cycle_unobserved+reserved+cap>s.provider_cycle_limit_usd','committed+reserved+cap>least(s.monthly_budget_usd,4)','envelope_committed+cap>envelope_limit']) {
      expect(originalClaim).toContain(guard); expect(core).toContain(guard);
    }
    expect(await value<string[]>("select proconfig value from pg_proc where oid='public.transcription_claim_dispatch_core(uuid,boolean,text,text)'::regprocedure")).toEqual(['search_path=pg_catalog, public']);
    expect(await value<number>('select count(*)::int value from cron.job')).toBe(0);
    expect(await value<number>('select count(*)::int value from net.requests')).toBe(0);
    for (const table of ['transcription_media_refreshes','transcription_media_targets']) {
      expect(await value<boolean>('select relrowsecurity value from pg_class where oid=$1::regclass', [`public.${table}`])).toBe(true);
      for (const role of ['anon','authenticated','service_role']) expect(await value<boolean>("select has_table_privilege($1,$2,'insert,update,delete') value", [role, `public.${table}`])).toBe(false);
    }
    expect(await value<boolean>("select has_function_privilege('service_role','public.transcription_claim_dispatch_core(uuid,boolean,text,text)','execute') value")).toBe(false);
    await identity('authenticated');
    await expect(rpc('worker_transcription_media_enqueue', [creator])).rejects.toThrow(/permission denied/);
    await expect(rpc('worker_transcription_activate', ['pilot'])).rejects.toThrow(/permission denied/);
  });
  it('rejects credential-only and configure bypasses, bounded pricing and unverified automatic activation', async () => {
    await identity('service_role');
    await expect(rpc('worker_transcription_activate', ['pilot'])).rejects.toThrow(/activation_unvalidated/);
    await expect(rpc('worker_transcription_configure', [true,true,'pilot',5,.25,true])).rejects.toThrow(/use_transcription_activate/);
    await expect(rpc('worker_transcription_validate_account', [.221,.08])).rejects.toThrow(/pricing_bounds_exceeded/);
    await expect(rpc('worker_transcription_validate_account', [.22,.081])).rejects.toThrow(/pricing_bounds_exceeded/);
    await expect(rpc('worker_transcription_validate_account', [0,.08])).rejects.toThrow(/pricing_bounds_exceeded/);
    await expect(rpc('worker_transcription_validate_account', [.22,0])).rejects.toThrow(/pricing_bounds_exceeded/);
    await activate();
    expect(await rpc('worker_transcription_verify_pilot')).toMatchObject({ verified: false });
    await expect(rpc('worker_transcription_activate', ['automatic'])).rejects.toThrow(/pilot_unverified/);
    await expect(rpc('worker_transcription_configure', [true,false,'automatic',5,.25,true])).rejects.toThrow(/pilot_unverified/);
  });
  it('freezes only41 existing targets and never widens eligibility on later observations', async () => {
    for (let i=0; i<45; i++) await reel();
    await identity('service_role'); await rpc('worker_transcription_manifest');
    await activate();
    const e = await enqueue(); expect(e.target_count).toBe(41);
    const late = await reel(); await seed([late]);
    expect(await value<boolean>('select media_recovery_eligible value from public.transcript_jobs where reel_id=$1', [late])).toBe(false);
    expect(await value<number>('select count(*)::int value from public.transcription_media_targets where refresh_id=$1', [e.refresh_id])).toBe(41);
    expect(await rpc('worker_transcription_media_candidates')).toEqual({ creators: [] });
  });
});

describe('serialized reservations and dedicated manual100 claims', () => {
  it('deduplicates concurrent enqueue, reserves pipeline before claim and claims only intended job', async () => {
    const id = await reel(); await seed([id]); await activate();
    const jobs = await Promise.all([enqueue(),enqueue(),enqueue()]);
    expect(new Set(jobs.map(x => x.job_id)).size).toBe(1);
    expect(jobs.map(x => x.reason)).toEqual([null,'already_queued','already_queued']);
    await identity();
    const unrelated = await value<string>("insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,manual_authorized_by,priority,scheduled_for) values($1,'manual',1,10,$1,100,now()-interval '1 day') returning id value", [owner]);
    await db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [unrelated, other]);
    expect(await value<number>('select reserved_usd::float8 value from public.transcription_media_refreshes')).toBe(.01);
    expect(await value<number>('select reserved_usd::float8 value from public.scrape_jobs where id=$1', [jobs[0].job_id])).toBe(0);
    await identity('service_role');
    const ctx = await rpc<Context>('worker_transcription_media_claim', [jobs[0].job_id,'fixture_actor']);
    expect(ctx).toMatchObject({ job: { id: jobs[0].job_id,reserved_usd: .01 }, max_total_charge_usd: .01 });
    expect(await value<string>('select status value from public.scrape_jobs where id=$1', [unrelated])).toBe('pending');
    expect(await rpc('worker_transcription_media_claim', [jobs[0].job_id,'fixture_actor'])).toMatchObject({ reason: 'no_pending_jobs' });
    expect(await value<number>('select max_run_charge_usd::float8 value from public.app_settings where owner_user_id=$1', [owner])).toBe(.10);
    expect(await rpc('worker_transcription_media_jobs')).toMatchObject({ jobs: [{ id: jobs[0].job_id,status:'dispatching',creator_id:creator }] });
  });
  it('rejects unbacked100 jobs, and never changes ordinary manual10 per-run cap', async () => {
    await activate(); await identity();
    await expect(db.query("insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,manual_authorized_by) values($1,'manual',1,100,$1)", [owner])).rejects.toThrow(/media_job_link_required/);
    const normal = await value<string>("insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,manual_authorized_by) values($1,'manual',1,10,$1) returning id value", [owner]);
    await db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [normal, creator]);
    await identity('service_role');
    expect(await rpc('worker_claim_dispatch', [owner,true,'fixture_actor','manual'])).toMatchObject({ job: {id:normal},max_total_charge_usd:.10 });
    expect(await rpc('worker_transcription_media_reconcile', [normal])).toEqual({ status:'not_linked',actual_cost_usd:null,actual_cost_known:false,reason:'not_linked' });
  });
  it('retains original global switch, verified usage, envelope and4-dollar Apify budget', async () => {
    const id=await reel(); await seed([id]); await activate(); const e=await enqueue();
    await identity(); await db.query('update public.app_settings set scraping_enabled=false where owner_user_id=$1',[owner]);
    await identity('service_role'); expect(await rpc('worker_transcription_media_claim',[e.job_id,'fixture_actor'])).toMatchObject({reason:'globalscraping_disabled'});
    await identity(); await db.query("update public.app_settings set scraping_enabled=true,provider_usage_checked_at=now()-interval '16 minutes' where owner_user_id=$1",[owner]);
    await identity('service_role'); expect(await rpc('worker_transcription_media_claim',[e.job_id,'fixture_actor'])).toMatchObject({reason:'live_setup_or_usage_unverified'});
    await identity(); await db.query('update public.app_settings set provider_usage_checked_at=now() where owner_user_id=$1',[owner]);
    await identity('service_role'); await rpc('worker_configure_budget_envelope',[owner,.005]);
    expect(await rpc('worker_transcription_media_claim',[e.job_id,'fixture_actor'])).toMatchObject({reason:'budget_paused'});
    await identity(); await db.exec('update public.budget_envelopes set limit_usd=.01');
    await db.query('update public.app_settings set monthly_budget_usd=.005 where owner_user_id=$1',[owner]);
    await identity('service_role'); expect(await rpc('worker_transcription_media_claim',[e.job_id,'fixture_actor'])).toMatchObject({reason:'budget_paused'});
  });
  it('fits media .01 + three STT .08 inside .25 and blocks a fourth or second media reserve', async () => {
    const ids=[]; for(let i=0;i<4;i++) ids.push(await reel()); await seed(ids); await activate();
    const e=await enqueue(); const lease=await mediaProcessing(e);
    const rows=[]; for (const id of ids) rows.push(await record(id));
    await page(e,lease,rows); await finalizeMedia(e,lease);
    for (let i=0;i<3;i++) { const next=await claim(); expect(next.jobs).toHaveLength(1); await complete(next.jobs[0]); }
    expect(await claim()).toMatchObject({reason:'budget_paused',jobs:[]});
    expect(await value<number>('select sum(accounted_usd)::float8 value from public.transcript_attempts')).toBeCloseTo(.24);
    const second=await reel(other); await seed([second]);
    await identity(); await db.query('update public.transcript_jobs set media_recovery_eligible=true where reel_id=$1',[second]); await identity('service_role');
    expect(await enqueue(other)).toMatchObject({job_id:null,reason:'budget_paused'});
  });
  it('counts old-month media reservations independently when the current-month aggregate isNULL', async () => {
    const id=await reel(); await seed([id]); await activate(.08); const e=await enqueue();
    await identity(); await db.query("update public.transcription_media_refreshes set billing_month='2020-01-01' where id=$1",[e.refresh_id]);
    await identity('service_role'); await rpc('worker_observe_reel_media',[id,'https://scontent.cdninstagram.com/direct.mp4','[]',true,new Date().toISOString()]);
    expect(await claim()).toMatchObject({jobs:[],reason:'budget_paused'});
    await identity(); await db.exec('update public.transcription_settings set monthly_budget_usd=.09'); await identity('service_role');
    expect((await claim()).jobs).toHaveLength(1);
  });
});

describe('target-only ingest, ordered observations and canonical reconciliation', () => {
  it('ignores outsider shortcodes, retains metrics/bills, fences replay and validates raw counts', async () => {
    const id=await reel(); await seed([id]); const outsider=await reel(); await activate(); const e=await enqueue(); const lease=await mediaProcessing(e);
    const rows=[await record(id),await record(outsider),await record(id,{shortcode:'NEVER_NEW_REEL'})];
    expect(await page(e,lease,rows)).toMatchObject({accepted:1,cursor:3,duplicate:false});
    expect(await page(e,lease,[{...rows[0],media_source_url:'invalid'}],0)).toMatchObject({duplicate:true});
    expect(await value<number>('select count(*)::int value from public.reels')).toBe(2);
    expect(await value<number>('select count(*)::int value from public.reel_metric_snapshots')).toBe(0);
    expect(await value<number>('select latest_views::float8 value from public.reels where id=$1',[id])).toBe(123);
    expect(await value<number>('select duration_seconds::float8 value from public.reels where id=$1',[id])).toBe(65);
    expect(await value<number>('select observation_count value from public.transcription_media_targets where reel_id=$1',[id])).toBe(1);
    expect(await value<number>('select received_count value from public.scrape_job_creators where job_id=$1',[e.job_id])).toBe(3);
    expect(await value<number>('select count(*)::int value from public.reel_media_sources where reel_id=$1 and source_url is not null',[outsider])).toBe(0);
    expect(await finalizeMedia(e,lease)).toMatchObject({status:'partial',actual_cost_known:true,actual_cost_usd:.005});
    expect(await rpc('worker_transcription_media_reconcile',[e.job_id])).toMatchObject({actual_cost_known:true,actual_cost_usd:.005});
    expect(await value<number>('select accounted_usd::float8 value from public.transcription_media_refreshes')).toBe(.005);
  });
  it('invalid target observations roll back cursor, counts, duration and media atomically', async () => {
    const id=await reel(); await seed([id]); await activate(); const e=await enqueue(); const lease=await mediaProcessing(e);
    const good=await record(id); const bad={...good,media_candidates:[42]};
    await expect(page(e,lease,[good,bad])).rejects.toThrow(/invalid_media_candidates/);
    expect(await value<number>('select dataset_cursor value from public.scrape_jobs where id=$1',[e.job_id])).toBe(0);
    expect(await value<number>('select observation_count value from public.transcription_media_targets')).toBe(0);
    await expect(page(e,owner,[good])).rejects.toThrow(/lease_expired/);
    await expect(rpc('worker_ingest_page',[e.job_id,lease,0,JSON.stringify([good]),'[]',1,false,'{}'])).rejects.toThrow(/invalid_received_counts/);
    await expect(page(e,lease,[{...good,creator_id:other}])).rejects.toThrow(/creator_identity_mismatch/);
  });
  it('retains candidate order, promotes fresh candidate-only primary and does not erase unknown values', async () => {
    const id=await reel(); await seed([id]); await activate();
    const old='https://scontent.cdninstagram.com/stale.mp4', first='https://video.fbcdn.net/z-first.mp4', second='https://video.fbcdn.net/a-second.mp4';
    await rpc('worker_observe_reel_media',[id,old,'[]',true,new Date().toISOString()]);
    const newer=new Date(Date.now()+1000).toISOString();
    await rpc('worker_observe_reel_media',[id,null,JSON.stringify([first,second,first]),null,newer]);
    await rpc('worker_observe_reel_media',[id,null,'[]',null,new Date(Date.now()+2000).toISOString()]);
    expect(await value('select to_jsonb(m) value from public.reel_media_sources m where reel_id=$1',[id])).toMatchObject({source_url:first,candidates:[first,second],has_audio:true});
  });
  it('unknown actual cost retains the media hold and blocks new paid work after completion', async () => {
    const id=await reel(); await seed([id]); await activate(); const e=await enqueue(); const lease=await mediaProcessing(e,null);
    await page(e,lease,[await record(id)]);
    expect(await finalizeMedia(e,lease)).toMatchObject({actual_cost_known:false,actual_cost_usd:null});
    expect(await value<number>('select reserved_usd::float8 value from public.transcription_media_refreshes')).toBe(.01);
    expect(await claim()).toMatchObject({jobs:[],reason:'uncertain'});
    await rpc('worker_reconcile_run',[e.job_id,`run_${e.job_id}`,'fixture_actor','fixture_account','SUCCEEDED','fixture_dataset',.005]);
    expect(await rpc('worker_transcription_media_reconcile',[e.job_id])).toMatchObject({actual_cost_known:true,actual_cost_usd:.005});
  });
});

describe('before-submit and pilot verification fences', () => {
  it('rechecks pause after claim, releases only proven unstarted attempts, blocks stale and duplicate paid submission', async () => {
    const id=await reel(); await seed([id]); await activate();
    await rpc('worker_observe_reel_media',[id,'https://scontent.cdninstagram.com/direct.mp4','[]',true,new Date().toISOString()]);
    const a=(await claim()).jobs[0];
    await identity(); await db.query('update public.app_settings set paused=true where owner_user_id=$1',[owner]); await identity('service_role');
    await expect(rpc('worker_transcription_cancel_not_started',[a.attempt_id,a.lease_token])).rejects.toThrow(/nonacceptance_not_proven/);
    await identity(); await db.exec('update public.transcription_settings set paused=true'); await identity('service_role');
    expect(await rpc('worker_transcription_before_submit',[a.attempt_id,a.lease_token])).toMatchObject({allow:false,reason:'paused'});
    await expect(rpc('worker_transcription_cancel_not_started',[a.attempt_id,owner])).rejects.toThrow(/lease_expired/);
    expect(await rpc('worker_transcription_cancel_not_started',[a.attempt_id,a.lease_token])).toMatchObject({status:'not_started',duplicate:false});
    expect(await value<number>('select accounted_usd::float8 value from public.transcript_attempts')).toBe(0);
    expect(await value<number>('select reserved_usd::float8 value from public.transcript_attempts')).toBe(0);
    await identity(); await db.exec('update public.transcription_settings set paused=false'); await identity('service_role');
    const b=(await claim()).jobs[0];
    expect(await rpc('worker_transcription_before_submit',[b.attempt_id,b.lease_token])).toMatchObject({allow:true});
    expect(await rpc('worker_transcription_before_submit',[b.attempt_id,b.lease_token])).toMatchObject({allow:false});
    await expect(rpc('worker_transcription_cancel_not_started',[b.attempt_id,b.lease_token])).rejects.toThrow(/nonacceptance_not_proven/);
  });
  it('blocks another uncertain attempt and inactive workspace immediately before paid POST', async () => {
    const ids=[await reel(),await reel()]; await seed(ids); await activate();
    for(const id of ids) await rpc('worker_observe_reel_media',[id,'https://scontent.cdninstagram.com/direct.mp4','[]',true,new Date().toISOString()]);
    const a=(await claim()).jobs[0], b=(await claim()).jobs[0];
    await rpc('worker_transcription_fail',[a.attempt_id,a.lease_token,'uncertain',null,null]);
    expect(await rpc('worker_transcription_before_submit',[b.attempt_id,b.lease_token])).toMatchObject({allow:false,reason:'uncertain'});
    await rpc('worker_transcription_cancel_not_started',[b.attempt_id,b.lease_token]);
    await rpc('worker_transcription_reconcile',[a.attempt_id,'not_started',0]);
    const next=(await claim()).jobs[0];
    await identity(); await db.query('update public.workspaces set archived_at=now() where id=$1',[workspace]); await identity('service_role');
    expect(await rpc('worker_transcription_before_submit',[next.attempt_id,next.lease_token])).toMatchObject({allow:false,reason:'workspace_or_creator_inactive'});
  });
  it('verifies signed ready bounded pilot with known media actual, allows partial harvest, never fabricates STT billing', async () => {
    const id=await reel(); await seed([id]); await activate(); const e=await enqueue(); const lease=await mediaProcessing(e);
    await page(e,lease,[await record(id)]); await finalizeMedia(e,lease);
    expect(await rpc('worker_transcription_verify_pilot')).toMatchObject({verified:false});
    const a=(await claim()).jobs[0]; await complete(a);
    expect(await value<null>('select actual_cost_usd value from public.transcript_attempts')).toBeNull();
    expect(await rpc('worker_transcription_verify_pilot')).toMatchObject({verified:true});
    expect(await rpc('worker_transcription_activate',['automatic'])).toMatchObject({enabled:true,phase:'automatic',pilot_verified:true});
  });
  it('avoids owner revision churn for unchanged awaiting_media and budget_paused jobs', async () => {
    const id=await reel(); await seed([id]); await activate();
    await claim();
    const initial=await value<number>('select revision::int value from public.owner_revisions where owner_user_id=$1',[owner]);
    await claim();
    expect(await value<number>('select revision::int value from public.owner_revisions where owner_user_id=$1',[owner])).toBe(initial);
    await identity(); await db.exec('update public.transcription_settings set monthly_budget_usd=0'); await identity('service_role');
    await rpc('worker_observe_reel_media',[id,'https://scontent.cdninstagram.com/direct.mp4','[]',true,new Date().toISOString()]);
    await claim();
    const before=await value<number>('select revision::int value from public.owner_revisions where owner_user_id=$1',[owner]);
    await claim();
    expect(await value<number>('select revision::int value from public.owner_revisions where owner_user_id=$1',[owner])).toBe(before);
  });
});

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const db = new PGlite();
const owner = 'b1000000-0000-4000-8000-000000000001';
const stranger = 'b1000000-0000-4000-8000-000000000002';
let workspace: string, emptyWorkspace: string, creator: string;
let oldImplementation: string, viewColumns: string[];
let sequence = 0;
type Claimed = { id: string; reel_id: string; attempt_id: string; lease_token: string; source_url: string; model: string; reservation_usd: number; max_media_bytes: number };
async function identity(role = 'postgres', user = owner) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role, sub: user })]);
  if (role !== 'postgres') await db.exec(`set role ${role}`);
}
async function value<T>(sql: string, args: unknown[] = []): Promise<T> {
  return (await db.query<{ value: T }>(sql, args)).rows[0].value;
}
async function rpc<T>(name: string, args: unknown[] = []): Promise<T> {
  return value<T>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) as value`, args);
}
async function reel(duration: number | null = 60): Promise<string> {
  return value<string>("insert into public.reels(creator_id,shortcode,reel_url,published_at,duration_seconds,latest_fetched_at,provider) values($1,$2,'https://www.instagram.com/reel/fixture/','2026-08-01T00:00:00Z',$3,now(),'test') returning id as value", [creator, `TRANSCRIPT_${++sequence}`, duration]);
}
async function observed(id: string, url: string | null = 'https://scontent.cdninstagram.com/video.mp4', audio: boolean | null = null, candidates: string[] = []) {
  await identity('service_role');
  return rpc('worker_observe_reel_media', [id, url, JSON.stringify(candidates), audio, new Date().toISOString()]);
}
async function enable(phase = 'pilot', monthly = 5, pilot = .25) {
  await identity('service_role');
  await rpc('worker_transcription_configure', [true, true, phase, monthly, pilot, true]);
  await identity('authenticated');
  await rpc('update_transcription_preferences', [false]);
  await identity('service_role');
}
async function claim(limit = 2) {
  return rpc<{ reason: string | null; jobs: Claimed[] }>('worker_transcription_claim', [limit]);
}
async function complete(job: Claimed, text = 'Hello world', segments: unknown[] = [{ start_ms: 0, end_ms: 1000, text: 'Hello world' }]) {
  return rpc('worker_transcription_complete', [job.attempt_id, job.lease_token, text, 'en', JSON.stringify(segments), false, null]);
}
async function jobStatus(id: string) {
  return value<string>('select status as value from public.transcript_jobs where reel_id=$1', [id]);
}

beforeAll(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    grant usage on schema auth,public to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
  `);
  for (const file of ['202611080001_schema.sql', '202611080002_queue.sql', '202611080003_initial_backfill_and_usage.sql', '202611080004_nullable_provider_timestamps.sql', '202611080005_assumed_ist_publication.sql', '202611080006_owner_realtime_revision.sql']) {
    await db.exec(readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }
  oldImplementation = await value<string>("select prosrc as value from pg_proc where oid='public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb)'::regprocedure");
  viewColumns = await value<string[]>("select jsonb_agg(column_name order by ordinal_position) as value from information_schema.columns where table_schema='public' and table_name='reels_summary'");
  await db.exec(readFileSync(join(process.cwd(), 'supabase/migrations/202611080007_transcription.sql'), 'utf8'));
  await db.query('insert into auth.users values($1),($2)', [owner, stranger]);
  await identity('service_role');
  await rpc('provision_owner', [owner]);
  await identity('authenticated');
  workspace = (await rpc<{ id: string }>('create_workspace', ['Transcript database'])).id;
  emptyWorkspace = (await rpc<{ id: string }>('create_workspace', ['Foreign scope'])).id;
  await identity();
  creator = await value<string>("insert into public.creators(username,status) values('transcript_fixture','active') returning id as value");
  await db.query('insert into public.workspace_creators(workspace_id,creator_id) values($1,$2)', [workspace, creator]);
}, 60000);
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await identity();
  await db.exec('truncate public.transcript_jobs,public.transcript_attempts,public.reel_transcripts,public.reel_media_sources cascade');
  await db.exec('delete from public.reels');
  await db.exec("update public.transcription_settings set enabled=false,paused=true,key_validated=false,contract_validated=false,phase='pilot',monthly_budget_usd=5,pilot_limit_usd=.25,manifest_seeded=false");
  await db.query("update public.creators set status='active' where id=$1", [creator]);
  await db.query('update public.workspace_creators set active=true where workspace_id=$1 and creator_id=$2', [workspace, creator]);
});

describe('migration007 private schema and authorized browser contract', () => {
  it('preserves the exact patched ingestion implementation/view and publishes only revisions', async () => {
    expect(await value<string>("select prosrc as value from pg_proc where oid='public.worker_ingest_page_pre_transcription(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb)'::regprocedure")).toBe(oldImplementation);
    expect(await value<string[]>("select jsonb_agg(column_name order by ordinal_position) as value from information_schema.columns where table_schema='public' and table_name='reels_summary'")).toEqual(viewColumns);
    expect((await db.query<{ tablename: string }>("select tablename from pg_publication_tables where pubname='supabase_realtime'")).rows.map(x => x.tablename)).toEqual(['owner_revisions']);
    for (const table of ['transcription_settings', 'reel_media_sources', 'transcript_jobs', 'transcript_attempts', 'reel_transcripts']) {
      expect(await value<boolean>('select relrowsecurity as value from pg_class where oid=$1::regclass', [`public.${table}`])).toBe(true);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await value<boolean>('select has_table_privilege($1,$2,\'insert,update,delete\') as value', [role, `public.${table}`])).toBe(false);
      }
      expect(await value<boolean>("select has_table_privilege('authenticated',$1,'select') as value", [`public.${table}`])).toBe(false);
    }
    expect(await value<boolean>("select has_function_privilege('service_role','public.worker_ingest_page_pre_transcription(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb)','execute') as value")).toBe(false);
  });

  it('fails closed without credentials and browser preference cannot authorize enabling or change caps', async () => {
    await identity('authenticated');
    const overview = await rpc<Record<string, unknown>>('get_transcription_overview');
    expect(overview).toMatchObject({ enabled: false, paused: true, phase: 'pilot', monthly_budget_usd: 5, pilot_limit_usd: .25, actual_month_spend: null, reserved_usd: 0, estimated_month_spend: 0 });
    expect(await rpc('update_transcription_preferences', [false])).toMatchObject({ enabled: false, paused: false });
    await expect(rpc('worker_transcription_configure', [true, true])).rejects.toThrow(/permission denied/);
    await expect(db.exec('update public.transcription_settings set enabled=true')).rejects.toThrow(/permission denied/);
    await expect(rpc('update_transcription_preferences', [null])).rejects.toThrow(/invalid_preference/);
    await identity('service_role');
    expect(await claim()).toEqual({ reason: 'disabled', jobs: [] });
    await expect(rpc('worker_transcription_configure', [false, true])).rejects.toThrow(/invalid_transcription_configuration/);
    await expect(rpc('worker_transcription_configure', [true, true])).rejects.toThrow(/invalid_transcription_configuration/);
    for (const args of [[true, true, 'automatic', 5.01, .25, true], [true, true, 'pilot', 5, .26, true]]) {
      await expect(rpc('worker_transcription_configure', args)).rejects.toThrow(/invalid_transcription_configuration/);
    }
    expect(await rpc('worker_transcription_config')).toMatchObject({ enabled: false, key_validated: false, contract_validated: false, concurrency: 2, max_duration_seconds: 180, max_media_bytes: 26214400, reservation_usd: .08, media_recovery_enabled: false });
  });

  it('rejects anonymous, stranger, foreign-workspace and removed-link reads including ready results', async () => {
    const id = await reel();
    await observed(id); await enable();
    await complete((await claim(1)).jobs[0]);
    await identity('authenticated');
    expect(await rpc('get_reel_transcript', [workspace, id])).toMatchObject({ reel_id: id, status: 'ready', text: 'Hello world', language: 'en', model: 'scribe_v2', segments: [{ start_ms: 0, end_ms: 1000, text: 'Hello world' }], error_message: null });
    await expect(rpc('get_reel_transcript', [emptyWorkspace, id])).rejects.toThrow(/reel_not_in_workspace/);
    await identity('authenticated', stranger);
    await expect(rpc('get_reel_transcript', [workspace, id])).rejects.toThrow(/forbidden/);
    await expect(rpc('get_transcription_overview')).rejects.toThrow(/forbidden/);
    await expect(rpc('update_transcription_preferences', [false])).rejects.toThrow(/forbidden/);
    await identity('anon');
    await expect(rpc('get_reel_transcript', [workspace, id])).rejects.toThrow(/permission denied/);
    await identity();
    await db.query('update public.workspace_creators set active=false where workspace_id=$1 and creator_id=$2', [workspace, creator]);
    await identity('authenticated');
    await expect(rpc('get_reel_transcript', [workspace, id])).rejects.toThrow(/reel_not_in_workspace/);
    expect(await rpc('get_transcription_overview')).toMatchObject({ jobs: [] });
    await identity();
    await db.query('delete from public.workspace_creators where workspace_id=$1 and creator_id=$2', [workspace, creator]);
    await identity('authenticated');
    await expect(rpc('get_reel_transcript', [workspace, id])).rejects.toThrow(/reel_not_in_workspace/);
    await identity();
    await db.query('insert into public.workspace_creators(workspace_id,creator_id) values($1,$2)', [workspace, creator]);
  });

  it('returns a narrow not_requested object without URLs, attempts or billing identities', async () => {
    const id = await reel();
    await identity('authenticated');
    const result = await rpc<Record<string, unknown>>('get_reel_transcript', [workspace, id]);
    expect(result).toEqual({ reel_id: id, status: 'not_requested', text: null, language: null, segments: [], model: null, completed_at: null, error_message: null });
    await observed(id);
    await identity('authenticated');
    const all = JSON.stringify(await rpc('get_transcription_overview'));
    expect(all).not.toMatch(/https:|source_url|provider_job_id|lease_token|candidates/);
  });
});

describe('atomic media capture and safe queue', () => {
  it('ingests eight arguments atomically, retains dates/counts and skips replay media capture', async () => {
    const job = await value<{ id: string; lease_token: string }>("insert into public.scrape_jobs(owner_user_id,kind,status,requested_profiles_count,results_limit,lease_token,lease_expires_at) values($1,'manual','processing',1,10,gen_random_uuid(),now()+interval '3 minutes') returning jsonb_build_object('id',id,'lease_token',lease_token) as value", [owner]);
    await db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [job.id, creator]);
    const record = { creator_id: creator, username: 'transcript_fixture', shortcode: `INGEST_${++sequence}`, fetched_at: new Date().toISOString(), published_at: '2026-08-10T20:06:13+05:30', published_at_raw: '2026-08-10T20:06:13', published_at_basis: 'assumed_Asia/Kolkata', duration_seconds: 60, views: 100, likes: null, comments: 0, views_state: 'known', likes_state: 'hidden', comments_state: 'known', provider: 'fixture', media_source_url: 'https://scontent.cdninstagram.com/first.mp4', media_candidates: ['https://video.fbcdn.net/backup.mp4'], has_audio: null };
    await identity('service_role');
    const args = [job.id, job.lease_token, 0, JSON.stringify([record]), '[]', 1, false, JSON.stringify({ [creator]: 1 })];
    expect(await rpc('worker_ingest_page', args)).toMatchObject({ accepted: 1, cursor: 1, duplicate: false });
    expect(await rpc('worker_ingest_page', [...args.slice(0, 3), JSON.stringify([{ ...record, media_source_url: 'not a URL' }]), ...args.slice(4)])).toMatchObject({ duplicate: true });
    const id = await value<string>('select id as value from public.reels where shortcode=$1', [record.shortcode]);
    expect(await value<string>('select source_url as value from public.reel_media_sources where reel_id=$1', [id])).toBe(record.media_source_url);
    expect(await value<number>('select received_count as value from public.scrape_job_creators where job_id=$1', [job.id])).toBe(1);
    expect(await value<number>('select count(*)::int as value from public.transcript_jobs')).toBe(1);
    expect(await value<number>('select count(*)::int as value from public.reel_metric_snapshots')).toBe(1);
    const later = { ...record, published_at: '2020-01-01T00:00:00Z', published_at_basis: 'explicit_offset', published_at_raw: null, media_source_url: null, media_candidates: [], fetched_at: new Date(Date.now() + 1000).toISOString() };
    expect(await rpc('worker_ingest_page', [job.id, job.lease_token, 1, JSON.stringify([later]), '[]', 2, false, JSON.stringify({ [creator]: 1 })])).toMatchObject({ accepted: 1 });
    expect(await value<string>('select published_at::text as value from public.reels where id=$1', [id])).toContain('2020-01-01 00:00:00');
    expect(await value<string>('select source_url as value from public.reel_media_sources where reel_id=$1', [id])).toBe(record.media_source_url);
    await expect(rpc('worker_ingest_page', [job.id, stranger, 2, '[]', '[]', 2, true, null])).rejects.toThrow(/lease_expired/);
    await expect(rpc('worker_ingest_page', [job.id, job.lease_token, 2, JSON.stringify([{ ...later, media_candidates: [42] }]), '[]', 3, true, JSON.stringify({ [creator]: 1 })])).rejects.toThrow(/invalid_media_candidates/);
    expect(await value<number>('select dataset_cursor as value from public.scrape_jobs where id=$1', [job.id])).toBe(2);
    expect(await value<number>('select received_count as value from public.scrape_job_creators where job_id=$1', [job.id])).toBe(2);
  });

  it('keeps tri-state audio, ignores older/missing observations and deduplicates logical jobs', async () => {
    const id = await reel();
    await observed(id, null, null);
    expect(await jobStatus(id)).toBe('awaiting_media');
    expect(await value<boolean | null>('select has_audio as value from public.reel_media_sources where reel_id=$1', [id])).toBeNull();
    await observed(id, 'https://scontent.cdninstagram.com/good.mp4', true, ['https://video.fbcdn.net/backup.mp4']);
    await observed(id, null, null);
    await rpc('worker_observe_reel_media', [id, 'https://scontent.cdninstagram.com/old.mp4', '[]', false, '2020-01-01T00:00:00Z']);
    expect(await value<{ source_url: string; has_audio: boolean; candidates: string[] }>('select to_jsonb(m) as value from public.reel_media_sources m where reel_id=$1', [id])).toMatchObject({ source_url: 'https://scontent.cdninstagram.com/good.mp4', has_audio: true, candidates: ['https://video.fbcdn.net/backup.mp4'] });
    expect(await value<number>('select count(*)::int as value from public.transcript_jobs where reel_id=$1', [id])).toBe(1);
    expect(await jobStatus(id)).toBe('queued');
    for (const candidates of ['{}', '[null]', '["http://bad.test/video"]']) await expect(rpc('worker_observe_reel_media', [id, null, candidates, null, new Date().toISOString()])).rejects.toThrow(/invalid_media_candidates/);
    await identity(); await db.query('update public.workspace_creators set active=false where workspace_id=$1', [workspace]);
    await identity('service_role');
    await expect(rpc('worker_observe_reel_media', [id, null, '[]', null, new Date().toISOString()])).rejects.toThrow(/reel_not_authorized/);
  });

  it('seeds at most41 existing reels exactly once without adding/changing scrape jobs', async () => {
    for (let i = 0; i < 45; i++) await reel();
    const jobsBefore = await value<number>('select count(*)::int as value from public.scrape_jobs');
    await identity('service_role');
    await expect(rpc('worker_transcription_manifest', [42])).rejects.toThrow(/invalid_manifest_limit/);
    const first = await rpc<{ items: unknown[]; already_seeded: boolean }>('worker_transcription_manifest');
    expect(first.items).toHaveLength(41); expect(first.already_seeded).toBe(false);
    expect(await rpc('worker_transcription_manifest')).toEqual({ items: [], already_seeded: true });
    expect(await value<number>('select count(*)::int as value from public.transcript_jobs')).toBe(41);
    expect(await value<number>('select count(*)::int as value from public.scrape_jobs')).toBe(jobsBefore);
  });

  it('excludes private, unavailable and paused creators before enqueue, manifests and paid claims', async () => {
    const id = await reel(); await observed(id); await enable();
    for (const status of ['private', 'unavailable', 'paused']) {
      await identity(); await db.query('update public.creators set status=$1 where id=$2', [status, creator]);
      await identity('service_role'); expect((await claim()).jobs).toHaveLength(0);
    }
    expect(await rpc('worker_transcription_manifest')).toEqual({ items: [], already_seeded: false });
    await identity(); await db.exec('truncate public.transcript_jobs,public.transcript_attempts cascade');
    expect(await observed(id)).toEqual({ status: 'not_requested' });
    expect(await value<number>('select count(*)::int as value from public.transcript_jobs')).toBe(0);
    await identity(); await db.query("update public.creators set status='active' where id=$1", [creator]);
    await observed(id); expect((await claim()).jobs).toHaveLength(1);
  });

  it('validates CDN URLs, pathological durations and segments before paid/result writes', async () => {
    const id = await reel(.01); await observed(id); await enable();
    expect((await claim()).jobs).toHaveLength(0); expect(await jobStatus(id)).toBe('media_unavailable');
    for (const url of ['https://localhost/video', 'https://cdninstagram.com/video', 'https://cdninstagram.com.evil.test/video', 'https://user@scontent.cdninstagram.com/video', 'https://scontent.cdninstagram.com:444/video', 'http://scontent.cdninstagram.com/video']) {
      await expect(observed(id, url)).rejects.toThrow(/invalid_media_source/);
    }
    await identity(); const timed = await reel(); await observed(timed); const job = (await claim(1)).jobs[0];
    await expect(complete(job, 'too many', Array.from({ length: 5001 }, () => ({ start_ms: 0, end_ms: 0, text: '' })))).rejects.toThrow(/invalid_transcript/);
    expect(await complete(job, 'Valid untimed text', [])).toMatchObject({ status: 'ready' });
  });

  it('does not infer unknown audio as no speech and enforces media duration without any reservation', async () => {
    const unknown = await reel(); const silent = await reel(); const tooLong = await reel(181); const missingDuration = await reel(null);
    await observed(unknown, null, null); await observed(silent, null, false); await observed(tooLong); await observed(missingDuration);
    await enable();
    expect((await claim()).jobs).toEqual([]);
    expect(await jobStatus(unknown)).toBe('awaiting_media'); expect(await jobStatus(silent)).toBe('no_speech');
    expect(await jobStatus(tooLong)).toBe('media_unavailable'); expect(await jobStatus(missingDuration)).toBe('media_unavailable');
    expect(await value<number>('select count(*)::int as value from public.transcript_attempts')).toBe(0);
  });
});

describe('serialized reservations, fences and conservative charge ledger', () => {
  it('claims distinct jobs in parallel with concurrency2 and pilot3 aggregate media-inclusive starts', async () => {
    for (let i = 0; i < 5; i++) { await identity(); await observed(await reel()); }
    await enable();
    const parallel = await Promise.all([claim(2), claim(2), claim(2)]);
    const jobs = parallel.flatMap(x => x.jobs);
    expect(jobs).toHaveLength(2); expect(new Set(jobs.map(j => j.attempt_id)).size).toBe(2);
    expect(jobs[0]).toMatchObject({ model: 'scribe_v2', reservation_usd: .08, max_media_bytes: 26214400 });
    expect(await value<number>('select sum(reserved_usd)::float8 as value from public.transcript_attempts')).toBeCloseTo(.16);
    await rpc('worker_transcription_fail', [jobs[0].attempt_id, jobs[0].lease_token, 'media_unavailable', 'https://signed.secret/?token=hidden', 0]);
    await complete(jobs[1]);
    const third = (await claim(1)).jobs[0]; expect(third).toBeDefined(); await complete(third);
    expect(await claim()).toMatchObject({ reason: 'budget_paused', jobs: [] });
    expect(await value<number>('select count(*)::int as value from public.transcript_attempts')).toBe(3);
    expect(await value<number>('select sum(accounted_usd)::float8 as value from public.transcript_attempts')).toBeCloseTo(.24);
    await identity('authenticated');
    expect(await rpc('get_transcription_overview')).toMatchObject({ actual_month_spend: null, estimated_month_spend: .24, reserved_usd: 0, unreconciled_jobs: 3 });
    expect(JSON.stringify(await rpc('get_transcription_overview'))).not.toMatch(/signed.secret|hidden|https:/);
  });

  it('reserves against pilot and monthly caps before downloads, including old-month uncertain holds', async () => {
    for (let i = 0; i < 3; i++) { await identity(); await observed(await reel()); }
    await enable('pilot', 5, .1);
    expect((await claim()).jobs).toHaveLength(1);
    expect(await claim()).toMatchObject({ reason: 'budget_paused', jobs: [] });
    const first = (await rpc<{ jobs: { attempt_id: string; lease_token: string }[] }>('worker_transcription_candidates')).jobs[0];
    await rpc('worker_transcription_fail', [first.attempt_id, first.lease_token, 'uncertain', null, null]);
    await identity(); await db.query("update public.transcript_attempts set billing_month='2020-01-01' where id=$1", [first.attempt_id]);
    await enable('automatic', .08);
    expect(await claim()).toEqual({ reason: 'uncertain', jobs: [] });
    await rpc('worker_transcription_reconcile', [first.attempt_id, 'charged', .08]);
    expect((await claim()).jobs).toHaveLength(1);
    const active = (await rpc<{ jobs: { attempt_id: string; lease_token: string }[] }>('worker_transcription_candidates')).jobs[0];
    await rpc('worker_transcription_fail', [active.attempt_id, active.lease_token, 'failed', null, null]);
    expect(await claim()).toMatchObject({ reason: 'budget_paused', jobs: [] });
  });

  it('holds uncertain starts, lists without charging, reconciles nonacceptance and fences old callbacks', async () => {
    const id = await reel(); await observed(id); await enable();
    const first = (await claim(1)).jobs[0];
    await expect(rpc('worker_transcription_attach', [first.attempt_id, stranger, 'provider-1'])).rejects.toThrow(/lease_expired/);
    await rpc('worker_transcription_fail', [first.attempt_id, first.lease_token, 'uncertain', 'sensitive provider result', null]);
    expect(await claim()).toEqual({ reason: 'uncertain', jobs: [] });
    expect(await value<number>('select reserved_usd::float8 as value from public.transcript_attempts where id=$1', [first.attempt_id])).toBe(.08);
    expect(await rpc('worker_transcription_candidates', [10])).toMatchObject({ jobs: [{ id: first.id, reel_id: id, attempt_id: first.attempt_id, lease_token: first.lease_token, status: 'uncertain' }] });
    expect(await rpc('worker_transcription_callback_context', [first.attempt_id])).toMatchObject({ job: { id: first.id, attempt_id: first.attempt_id, model: 'scribe_v2', status: 'uncertain', max_duration_seconds: 180 } });
    expect(await rpc('worker_transcription_callback_context', [stranger])).toEqual({ job: null });
    await expect(rpc('worker_transcription_candidates', [11])).rejects.toThrow(/invalid_candidate_limit/);
    await rpc('worker_transcription_reconcile', [first.attempt_id, 'not_started', 0]);
    const second = (await claim(1)).jobs[0]; expect(second.attempt_id).not.toBe(first.attempt_id);
    await expect(complete(first)).rejects.toThrow(/lease_expired/);
    await expect(rpc('worker_transcription_provider_failure', [first.attempt_id, first.lease_token, 'old-request'])).rejects.toThrow(/lease_expired/);
    expect(await rpc('worker_transcription_callback_context', [first.attempt_id])).toEqual({ job: null });
    await complete(second);
    await expect(rpc('worker_transcription_reconcile', [first.attempt_id, 'charged', .02])).rejects.toThrow(/reconciliation_mismatch/);
  });

  it('expires leases into uncertainty instead of relaunching and completes authenticated late result safely', async () => {
    const id = await reel(); await observed(id); await enable(); const first = (await claim(1)).jobs[0];
    await identity(); await db.query("update public.transcript_attempts set lease_expires_at=now()-interval '1 second' where id=$1", [first.attempt_id]);
    await identity('service_role');
    expect(await claim()).toEqual({ reason: 'uncertain', jobs: [] });
    expect(await value<number>('select count(*)::int as value from public.transcript_attempts')).toBe(1);
    expect(await rpc('worker_transcription_attach', [first.attempt_id, first.lease_token, 'late-request-id', 'late-transcript-id'])).toMatchObject({ status: 'uncertain' });
    expect(await rpc('worker_transcription_callback_context', [first.attempt_id])).toMatchObject({ job: { provider_job_id: 'late-request-id', provider_transcription_id: 'late-transcript-id', status: 'uncertain' } });
    expect(await complete(first)).toMatchObject({ status: 'ready' });
    expect(await value<number>('select reserved_usd::float8 as value from public.transcript_attempts where id=$1', [first.attempt_id])).toBe(0);
  });

  it('settles authoritative provider failure after timeout with attached identity and nonce, never requeues', async () => {
    const id = await reel(); await observed(id); await enable(); const job = (await claim(1)).jobs[0];
    await identity(); await db.query("update public.transcript_attempts set lease_expires_at=now()-interval '1 second' where id=$1", [job.attempt_id]);
    await identity('service_role'); expect(await claim()).toEqual({ reason: 'uncertain', jobs: [] });
    await expect(rpc('worker_transcription_provider_failure', [job.attempt_id, job.lease_token, 'verified-request'])).rejects.toThrow(/provider_job_mismatch/);
    await rpc('worker_transcription_attach', [job.attempt_id, job.lease_token, 'verified-request', 'verified-transcript']);
    await expect(rpc('worker_transcription_fail', [job.attempt_id, job.lease_token, 'failed', null, null])).rejects.toThrow(/reconciliation_required/);
    await expect(rpc('worker_transcription_provider_failure', [job.attempt_id, stranger, 'verified-request'])).rejects.toThrow(/lease_expired/);
    await expect(rpc('worker_transcription_provider_failure', [job.attempt_id, job.lease_token, 'wrong-request'])).rejects.toThrow(/provider_job_mismatch/);
    await identity('authenticated');
    await expect(rpc('worker_transcription_provider_failure', [job.attempt_id, job.lease_token, 'verified-request'])).rejects.toThrow(/permission denied/);
    await identity('service_role');
    expect(await rpc('worker_transcription_provider_failure', [job.attempt_id, job.lease_token, 'verified-request'])).toEqual({ status: 'failed', duplicate: false });
    expect(await rpc('worker_transcription_provider_failure', [job.attempt_id, job.lease_token, 'verified-request'])).toEqual({ status: 'failed', duplicate: true });
    expect(await jobStatus(id)).toBe('failed'); expect((await claim()).jobs).toHaveLength(0);
    expect(await value<{ reserved: number; accounted: number; actual: number | null }>('select jsonb_build_object(\'reserved\',reserved_usd,\'accounted\',accounted_usd,\'actual\',actual_cost_usd) as value from public.transcript_attempts where id=$1', [job.attempt_id])).toEqual({ reserved: 0, accounted: .08, actual: null });
    expect(await value<number>('select attempt_count as value from public.transcript_jobs where id=$1', [job.id])).toBe(1);
    await expect(complete(job)).rejects.toThrow(/attempt_not_completable/);
    await identity('authenticated'); expect(await rpc('get_reel_transcript', [workspace, id])).toMatchObject({ status: 'failed', text: null, error_message: 'Provider confirmed transcription failure.' });
  });

  it('accepts early callback, attach-once and replay without downgrading ready or leaking segment extras', async () => {
    const id = await reel(); await observed(id); await enable(); const first = (await claim(1)).jobs[0];
    await expect(complete(first, 'bad', [{ start_ms: -1, end_ms: 1, text: 'bad' }])).rejects.toThrow(/invalid_segments/);
    expect(await complete(first, 'Hello world', [{ start_ms: 0, end_ms: 1000, text: 'Hello world', media_url: 'https://secret.example/private' }])).toMatchObject({ status: 'ready', duplicate: false });
    expect(await rpc('worker_transcription_attach', [first.attempt_id, first.lease_token, 'early-provider-id'])).toEqual({ status: 'ready', duplicate: true });
    expect(await rpc('worker_transcription_attach', [first.attempt_id, first.lease_token, 'early-provider-id', 'separate-retrieval-id'])).toEqual({ status: 'ready', duplicate: true });
    await rpc('worker_transcription_attach', [first.attempt_id, first.lease_token, 'early-provider-id', null]);
    expect(await rpc('worker_transcription_callback_context', [first.attempt_id])).toMatchObject({ job: { provider_job_id: 'early-provider-id', provider_transcription_id: 'separate-retrieval-id' } });
    await expect(rpc('worker_transcription_attach', [first.attempt_id, first.lease_token, 'early-provider-id', 'wrong-retrieval-id'])).rejects.toThrow(/provider_job_mismatch/);
    await expect(rpc('worker_transcription_attach', [first.attempt_id, first.lease_token, 'different-provider-id'])).rejects.toThrow(/provider_job_mismatch/);
    expect(await complete(first, 'Overwrite attempt')).toMatchObject({ status: 'ready', duplicate: true });
    expect(await rpc('worker_transcription_fail', [first.attempt_id, first.lease_token, 'failed', 'Overwrite', null])).toMatchObject({ status: 'ready', duplicate: true });
    expect(await rpc('worker_transcription_provider_failure', [first.attempt_id, first.lease_token, 'early-provider-id'])).toEqual({ status: 'ready', duplicate: true });
    await observed(id, 'https://scontent.cdninstagram.com/new.mp4');
    expect((await claim()).jobs).toEqual([]);
    await identity('authenticated');
    const result = await rpc<{ segments: unknown[]; text: string }>('get_reel_transcript', [workspace, id]);
    expect(result.text).toBe('Hello world'); expect(result.segments).toEqual([{ start_ms: 0, end_ms: 1000, text: 'Hello world' }]);
    await identity('service_role'); await rpc('worker_transcription_reconcile', [first.attempt_id, 'charged', .02]);
    expect(await value<number>('select accounted_usd::float8 as value from public.transcript_attempts where id=$1', [first.attempt_id])).toBe(.08);
    await identity('authenticated'); expect(await rpc('get_transcription_overview')).toMatchObject({ actual_month_spend: null, unreconciled_jobs: 0 });
  });

  it('retries confirmed failure finitely with backoff, never more than3 per logical job', async () => {
    const id = await reel(); await observed(id); await enable('automatic');
    for (let attempt = 1; attempt <= 3; attempt++) {
      const job = (await claim(1)).jobs[0]; expect(job).toBeDefined();
      expect(await rpc('worker_transcription_fail', [job.attempt_id, job.lease_token, 'failed', null, null])).toMatchObject({ status: attempt === 3 ? 'failed' : 'queued' });
      expect((await claim(1)).jobs).toHaveLength(0);
      await identity(); await db.query("update public.transcript_jobs set next_attempt_at=now()-interval '1 second' where reel_id=$1", [id]); await identity('service_role');
    }
    expect((await claim()).jobs).toHaveLength(0); expect(await jobStatus(id)).toBe('failed');
    expect(await value<number>('select attempt_count as value from public.transcript_jobs where reel_id=$1', [id])).toBe(3);
  });

  it('revision changes on service results, coalesces within transactions and never exposes raw tables', async () => {
    const id = await reel(); await observed(id); await enable(); const job = (await claim(1)).jobs[0];
    const before = await value<number>('select revision::int as value from public.owner_revisions');
    await db.exec('begin'); await complete(job); await rpc('worker_transcription_attach', [job.attempt_id, job.lease_token, 'revision-provider']); await db.exec('commit');
    expect(await value<number>('select revision::int as value from public.owner_revisions')).toBe(before + 1);
    await expect(db.exec("update public.transcript_jobs set status='failed'")).rejects.toThrow(/permission denied/);
    await identity('authenticated');
    for (const table of ['reel_media_sources', 'reel_transcripts', 'transcript_jobs', 'transcript_attempts']) await expect(db.exec(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
    for (const name of ['worker_transcription_config', 'worker_transcription_candidates', 'worker_transcription_claim']) await expect(rpc(name)).rejects.toThrow(/permission denied/);
    await expect(rpc('worker_transcription_callback_context', [job.attempt_id])).rejects.toThrow(/permission denied/);
  });
});

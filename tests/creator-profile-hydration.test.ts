import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const db = new PGlite();
const owner = 'b2000000-0000-4000-8000-000000000001';
const stranger = 'b2000000-0000-4000-8000-000000000002';
let workspace: string;
type Added = { id: string; initial_backfill_job_id: string | null; profile_job_ids: string[] };
type Imported = { added: number; duplicates: number; job_ids: string[]; profile_job_ids: string[] };
async function role(name = 'authenticated', user = owner) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, role: name })]);
  if (name !== 'postgres') await db.exec(`set role ${name}`);
}
async function value<T>(sql: string, args: unknown[] = []) { return (await db.query<{ value: T }>(sql, args)).rows[0].value; }
async function denied(sql: string, args: unknown[] = [], message = /permission denied|forbidden|not_authorized/) {
  await db.exec('savepoint expected_failure');
  await expect(db.query(sql, args)).rejects.toThrow(message);
  await db.exec('rollback to savepoint expected_failure');
}
async function add(username = 'new_creator') { return value<Added>('select public.add_creator($1,$2) value', [workspace, username]); }
async function legacy(username = 'legacy_creator', complete = false) {
  await role('postgres');
  const id = await value<string>('insert into public.creators(username,avatar_url,display_name,followers_count,last_profile_fetch_at) values($1,$2,$3,$4,$5) returning id value',
    [username, complete ? 'https://scontent.cdninstagram.com/avatar.jpg' : null, complete ? 'Known profile' : null, complete ? 100 : null, complete ? new Date().toISOString() : null]);
  await db.query('insert into public.workspace_creators(workspace_id,creator_id) values($1,$2)', [workspace, id]);
  await role();
  return id;
}

beforeAll(async () => {
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
    -- Hosted facilities are inert fixtures; these tests never start external work.
    create schema vault; create schema cron; create schema net;
    create table vault.secrets(id uuid primary key default gen_random_uuid(),name text,secret text);
    create view vault.decrypted_secrets as select id,name,secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(value text,label text,description text) returns uuid language sql as $$ insert into vault.secrets(name,secret) values(label,value) returning id $$;
    create table cron.job(jobid bigint generated always as identity primary key,jobname text unique,schedule text,command text,active boolean default true);
    create function cron.schedule(label text,schedule text,command text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values(label,schedule,command) returning jobid $$;
    create table net.requests(id bigint generated always as identity,url text,headers jsonb,body jsonb);
    create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as $$ insert into net.requests(url,headers,body) values(url,headers,body) returning id $$;`);
  const migrations = join(process.cwd(), 'supabase/migrations');
  for (const file of readdirSync(migrations).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrations, file), 'utf8').replace(/^create extension[^;]+;\s*/gm, ''));
  }
  await db.query('insert into auth.users values($1),($2)', [owner, stranger]);
  await role('service_role'); await db.query('select public.provision_owner($1)', [owner]);
  await role(); workspace = (await value<{ id: string }>('select public.create_workspace($1) value', ['Profiles'])).id;
}, 60000);
beforeEach(async () => { await role('postgres'); await db.exec('begin'); await role(); });
afterEach(async () => { await db.exec('rollback'); });
afterAll(async () => { await db.close(); });

describe('profile hydration for single and bulk creator imports', () => {
  it('queues one initial profile fetch and one Reel import in the same owner transaction', async () => {
    const result = await add();
    expect(result.initial_backfill_job_id).toBeTruthy();
    expect(result.profile_job_ids).toHaveLength(1);
    const jobs = (await db.query<{ kind: string; manual_authorized_by: string; reserved_usd: number; results_limit: number }>('select kind,manual_authorized_by,reserved_usd,results_limit from public.scrape_jobs order by kind')).rows;
    expect(jobs.map(job => job.kind)).toEqual(['backfill', 'profile']);
    expect(jobs[1]).toMatchObject({ manual_authorized_by: owner, results_limit: 1 });
    expect(jobs.every(job => Number(job.reserved_usd) === 0)).toBe(true);
    await role('service_role');
    expect(await value<{ reason: string }>('select public.worker_claim_dispatch($1,true,$2,$3) value', [owner, 'profile-actor', 'profile'])).toEqual({ reason: 'globalscraping_disabled' });
  });

  it('batches 45 profiles into three metadata jobs while retaining 45 initial Reel imports', async () => {
    const input = Array.from({ length: 45 }, (_, index) => ({ username: `bulk_${index}` }));
    const result = await value<Imported>('select public.import_creators($1,$2) value', [workspace, input]);
    expect(result.added).toBe(45);
    expect(result.profile_job_ids).toHaveLength(3);
    expect(result.job_ids).toHaveLength(48);
    const profiles = (await db.query<{ n: number; manual_authorized_by: string }>("select requested_profiles_count n,manual_authorized_by from public.scrape_jobs where kind='profile'")).rows;
    expect(profiles.map(row => row.n).sort((a, b) => a - b)).toEqual([5, 20, 20]);
    expect(profiles.every(row => row.manual_authorized_by === owner)).toBe(true);
    expect(await value<number>("select count(*)::int value from public.scrape_job_creators jc join public.scrape_jobs j on j.id=jc.job_id where j.kind='profile'")).toBe(45);
  });

  it('does not duplicate jobs for repeated imports, normalized handles or shared links', async () => {
    const input = [{ username: '@Mixed_Case' }, { username: 'mixed_case' }, { username: 'another_one' }];
    expect(await value<Imported>('select public.import_creators($1,$2) value', [workspace, input])).toMatchObject({ added: 2, duplicates: 1 });
    const count = await value<number>('select count(*)::int value from public.scrape_jobs');
    expect(await value<Imported>('select public.import_creators($1,$2) value', [workspace, input])).toMatchObject({ added: 0, duplicates: 3, job_ids: [], profile_job_ids: [] });
    const other = (await value<{ id: string }>('select public.create_workspace($1) value', ['Shared'])).id;
    const linked = await value<Added>('select public.add_creator($1,$2) value', [other, 'https://instagram.com/mixed_case/']);
    expect(linked).toMatchObject({ initial_backfill_job_id: null, profile_job_ids: [] });
    expect(await value<number>('select count(*)::int value from public.scrape_jobs')).toBe(count);
  });

  it('repairs a newly linked legacy profile without claiming a new Reel import', async () => {
    await legacy();
    const other = (await value<{ id: string }>('select public.create_workspace($1) value', ['New link'])).id;
    const result = await value<Added>('select public.add_creator($1,$2) value', [other, 'legacy_creator']);
    expect(result.initial_backfill_job_id).toBeNull();
    expect(result.profile_job_ids).toHaveLength(1);
    expect(await value<number>('select count(*)::int value from public.scrape_jobs')).toBe(1);
  });

  it('reuses complete profile metadata when linking it to another workspace', async () => {
    await legacy('complete_creator', true);
    const other = (await value<{ id: string }>('select public.create_workspace($1) value', ['Complete link'])).id;
    const result = await value<Imported>('select public.import_creators($1,$2) value', [other, [{ username: 'complete_creator' }]]);
    expect(result).toMatchObject({ added: 1, job_ids: [], profile_job_ids: [] });
  });

  it('rolls back both profile and Reel jobs when a bulk import exceeds capacity', async () => {
    await db.query('select public.update_settings($1)', [{ capacity: 1 }]);
    await denied('select public.import_creators($1,$2)', [workspace, [{ username: 'over_one' }, { username: 'over_two' }]], /capacity_exceeded/);
    expect(await value<number>('select count(*)::int value from public.creators')).toBe(0);
    expect(await value<number>('select count(*)::int value from public.scrape_jobs')).toBe(0);
  });

  it('lets an explicit refresh repair missing profiles but does not repeat pending or uncertain work', async () => {
    const id = await legacy();
    const result = await value<Imported>("select public.enqueue_refresh($1,$2,'manual') value", [workspace, [id]]);
    expect(result.job_ids).toHaveLength(2); expect(result.profile_job_ids).toHaveLength(1);
    expect(await value<Imported>("select public.enqueue_refresh($1,$2,'manual') value", [workspace, [id]])).toMatchObject({ job_ids: [], profile_job_ids: [] });
    await role('postgres');
    await db.query("update public.scrape_jobs set status='uncertain' where id=$1", [result.profile_job_ids[0]]);
    await role();
    expect((await add('legacy_creator')).profile_job_ids).toEqual([]);
    expect(await value<Imported>("select public.enqueue_refresh($1,$2,'manual') value", [workspace, [id]])).toMatchObject({ job_ids: [], profile_job_ids: [] });
  });

  it('does not launch profile refreshes from daily schedules', async () => {
    await legacy();
    await role('service_role');
    expect(await value<{ reason: string }>("select public.worker_schedule($1,'profile') value", [owner])).toEqual({ job_ids: [], reason: 'profile_requires_manual_authorization' });
    expect(await value<number>('select count(*)::int value from public.scrape_jobs')).toBe(0);
  });

  it('denies foreign owners, archived workspaces, foreign creator IDs and browser queue-helper calls', async () => {
    await role('authenticated', stranger);
    await denied('select public.add_creator($1,$2)', [workspace, 'unauthorized']);
    await denied('select public.import_creators($1,$2)', [workspace, [{ username: 'unauthorized' }]]);
    await role();
    await denied('select creator_profile_private.queue_missing_profiles($1,true)', [[]]);
    await denied("select public.enqueue_refresh($1,$2,'profile')", [workspace, [stranger]], /creator_not_in_workspace/);
    await db.query('select public.update_workspace($1,null,true)', [workspace]);
    await denied('select public.add_creator($1,$2)', [workspace, 'archived'], /workspace_archived/);
    await denied('select public.import_creators($1,$2)', [workspace, []], /workspace_archived/);
    for (const deniedRole of ['anon', 'service_role']) {
      await role(deniedRole);
      await denied('select public.add_creator($1,$2)', [workspace, 'denied']);
    }
  });

  it('uses the monthly collection budget for profiles without creating another envelope', async () => {
    await role();
    const added = await add();
    expect(await value<string>('select envelope_id value from public.scrape_jobs where id=$1', [added.profile_job_ids[0]])).toBeNull();
    await role('postgres');
    await db.query("update public.app_settings set scraping_enabled=true,provider_account_id='account',provider_usage_checked_at=now(),provider_cycle_start_at=now()-interval '1 day',provider_cycle_end_at=now()+interval '1 day',provider_cycle_usage_usd=0,provider_cycle_limit_usd=5,max_run_charge_usd=.1 where owner_user_id=$1", [owner]);
    await role('service_role');
    await db.query("select public.worker_configure_apify_account($1,1,'account',true,true)", [owner]);
    await db.query("select public.worker_record_account_usage($1,1,'account',now()-interval '1 day',now()+interval '1 day',0,5)", [owner]);
    const claimed = await value<{ job: { id: string; reserved_usd: number }; max_total_charge_usd: number }>('select public.worker_claim_dispatch($1,true,$2,$3) value', [owner, 'profile-actor', 'profile']);
    expect(claimed.job.id).toBe(added.profile_job_ids[0]);
    expect(Number(claimed.job.reserved_usd)).toBe(.1);
    expect(Number(claimed.max_total_charge_usd)).toBe(.1);
  });

  it('puts all four profile batches ahead of 71 Reel backfills in the dispatcher queue', async () => {
    const input = Array.from({ length: 71 }, (_, index) => ({ username: `large_batch_${index}` }));
    const imported = await value<Imported>('select public.import_creators($1,$2) value', [workspace, input]);
    expect(imported.profile_job_ids).toHaveLength(4);
    const candidates = (await db.query<{ id: string; kind: string }>("select id,kind from public.scrape_jobs where status in ('pending','budget_paused') order by priority desc,scheduled_for asc limit 20")).rows;
    expect(candidates.slice(0, 4).map(job => job.id).sort()).toEqual([...imported.profile_job_ids].sort());
    expect(candidates.slice(4).every(job => job.kind === 'backfill')).toBe(true);
    await role('service_role');
    for (const candidate of candidates.slice(0, 2)) {
      const claimed = await value<{ job: { kind: string } }>('select public.worker_claim_dispatch($1,false,$2,$3) value', [owner, 'profile-fixture', candidate.kind]);
      expect(claimed.job.kind).toBe('profile');
    }
    expect(await value<number>("select count(*)::int value from public.scrape_jobs where kind='backfill' and status='pending'")).toBe(71);
    expect(await value('select public.worker_claim_dispatch($1,false,$2,$3) value', [owner, 'profile-fixture', 'profile'])).toEqual({ reason: 'concurrency_limit' });
  });

  it.each([{ spent: .18, cap: .1, expected: .1 }, { spent: .18, cap: .01, expected: .1 }, { spent: 4, cap: .1, expected: null }])(
    'uses monthly headroom with $spent already spent regardless of legacy $cap run cap', async ({ spent, cap, expected }) => {
      await role();
      const added = await add();
      await role('postgres');
      await db.query("update public.scrape_jobs set status='succeeded',live=true,actual_cost_usd=$1,billing_month=date_trunc('month',now())::date,billing_reconciled_at=now() where id=$2", [spent, added.initial_backfill_job_id]);
      await db.query("update public.app_settings set scraping_enabled=true,provider_account_id='account',provider_usage_checked_at=now(),provider_cycle_start_at=now()-interval '1 day',provider_cycle_end_at=now()+interval '1 day',provider_cycle_usage_usd=$1,provider_cycle_limit_usd=5,max_run_charge_usd=$2 where owner_user_id=$3", [spent, cap, owner]);
      await role('service_role');
      await db.query("select public.worker_configure_apify_account($1,1,'account',true,true)", [owner]);
      await db.query("select public.worker_record_account_usage($1,1,'account',now()-interval '1 day',now()+interval '1 day',$2,5)", [owner, spent]);
      const result = await value<{ reason?: string; job?: { reserved_usd: number }; max_total_charge_usd?: number }>('select public.worker_claim_dispatch($1,true,$2,$3) value', [owner, 'profile-actor', 'profile']);
      if (expected === null) {
        expect(result).toEqual({ reason: 'budget_paused' });
        expect(await value<number>('select reserved_usd::float8 value from public.scrape_jobs where id=$1', [added.profile_job_ids[0]])).toBe(0);
      } else {
        expect(Number(result.job?.reserved_usd)).toBe(expected);
        expect(Number(result.max_total_charge_usd)).toBe(expected);
      }
    });
});

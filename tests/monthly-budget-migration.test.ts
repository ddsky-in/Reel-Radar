import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, it, expect } from 'vitest';

const db = new PGlite();
afterAll(() => db.close());

it('migrates existing capped jobs without losing holds, changing budgets or waking work', async () => {
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
    create schema vault; create schema cron; create schema net;
    create table vault.secrets(id uuid primary key default gen_random_uuid(),name text,secret text);
    create view vault.decrypted_secrets as select id,name,secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(value text,label text,description text) returns uuid language sql as $$ insert into vault.secrets(name,secret) values(label,value) returning id $$;
    create table cron.job(jobid bigint generated always as identity,jobname text unique,schedule text,command text,active boolean default true);
    create function cron.schedule(label text,schedule text,command text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values(label,schedule,command) returning jobid $$;
    create table net.requests(id bigint generated always as identity,url text,headers jsonb,body jsonb);
    create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as $$ insert into net.requests(url,headers,body) values(url,headers,body) returning id $$;`);
  const dir = join(process.cwd(), 'supabase/migrations');
  const migration = '20261111032422_unified_monthly_budgets.sql';
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql') && f < migration).sort()) {
    await db.exec(readFileSync(join(dir, file), 'utf8').replace(/^create extension[^;]+;\s*/gm, ''));
  }
  const owner = 'fe000000-0000-4000-8000-000000000001';
  async function role(name: string) {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role: name, sub: owner })]);
    if (name !== 'postgres') await db.exec(`set role ${name}`);
  }
  async function rpc<T>(name: string, args: unknown[] = []) {
    return (await db.query<{ v: T }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) v`, args)).rows[0].v;
  }
  await db.query('insert into auth.users values($1)', [owner]);
  await role('service_role'); await rpc('provision_owner', [owner]);
  const envelope = await rpc<string>('worker_configure_budget_envelope', [owner, .25]);
  await role('authenticated'); const workspace = await rpc<{ id: string }>('create_workspace', ['Migration fixture']);
  await rpc('import_creators', [workspace.id, JSON.stringify([{ username: 'migration_one' }, { username: 'migration_two' }])]);
  await role('postgres');
  await db.query("update public.app_settings set monthly_budget_usd=50,paused=false,scraping_enabled=true,initial_backfill_enabled=true,provider_account_id='fixture',provider_usage_checked_at=now(),provider_cycle_start_at=now()-interval '1 day',provider_cycle_end_at=now()+interval '1 day',provider_cycle_usage_usd=0,provider_cycle_limit_usd=5 where owner_user_id=$1", [owner]);
  await db.exec('update public.transcription_settings set monthly_budget_usd=100');
  await role('service_role');
  const claim = await rpc<{ job: { id: string; dispatch_nonce: string } }>('worker_claim_dispatch', [owner, true, 'fixture_actor', 'profile']);
  await rpc('worker_start_uncertain', [claim.job.id, claim.job.dispatch_nonce]);
  await role('postgres');
  const before = (await db.query('select id,status,reserved_usd,envelope_id,dispatch_nonce,attempt_count from public.scrape_jobs order by id')).rows;
  await db.exec(readFileSync(join(dir, migration), 'utf8'));
  expect((await db.query('select id,status,reserved_usd,envelope_id,dispatch_nonce,attempt_count from public.scrape_jobs order by id')).rows).toEqual(before);
  expect((await db.query('select active,deactivated_at is not null archived from public.budget_envelopes where id=$1', [envelope])).rows).toEqual([{ active: false, archived: true }]);
  expect((await db.query('select monthly_budget_usd::float8 budget,paused,scraping_enabled from public.app_settings')).rows).toEqual([{ budget: 50, paused: false, scraping_enabled: true }]);
  expect((await db.query('select monthly_budget_usd::float8 budget from public.transcription_settings')).rows).toEqual([{ budget: 100 }]);
  expect((await db.query<{ n: number }>('select count(*)::int n from net.requests')).rows[0].n).toBe(0);
  expect((await db.query<{ n: number }>('select count(*)::int n from cron.job')).rows[0].n).toBe(0);
  await role('service_role');
  expect(await rpc('worker_claim_dispatch', [owner, true, 'fixture_actor', 'backfill'])).toEqual({ reason: 'unreconciled_charges' });
  await role('authenticated');
  const added = await rpc<{ profile_job_ids: string[] }>('add_creator', [workspace.id, 'migration_new']);
  expect((await db.query<{ envelope_id: string | null }>('select envelope_id from public.scrape_jobs where id=$1', [added.profile_job_ids[0]])).rows[0].envelope_id).toBeNull();
  for (const denied of ['anon', 'authenticated']) {
    await role(denied);
    await expect(rpc('transcription_combined_budget', [0])).rejects.toThrow(/permission denied/);
    await expect(rpc('worker_claim_dispatch', [owner, true, 'fixture_actor', 'profile'])).rejects.toThrow(/permission denied/);
  }
}, 60000);

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const fixtureOwner = 'fa100000-0000-4000-8000-000000000001';
export const fixtureStranger = 'fa100000-0000-4000-8000-000000000002';

export async function featureDatabase(options: { excludeMigrations?: string[]; empty?: boolean } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
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
    create function cron.schedule(label text,timing text,sql_command text) returns bigint language sql as $$
      insert into cron.job(jobname,schedule,command) values(label,timing,sql_command)
      on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command,active=true returning jobid $$;
    create function cron.alter_job(job_id bigint,new_schedule text) returns void language sql as $$ update cron.job set schedule=$2 where jobid=$1 $$;
    create table net.requests(id bigint generated always as identity,url text,headers jsonb,body jsonb);
    create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as $$
      insert into net.requests(url,headers,body) values(url,headers,body) returning id $$;
  `);
  const directory = join(process.cwd(), 'supabase/migrations');
  for (const file of readdirSync(directory).filter(file => file.endsWith('.sql') && !options.excludeMigrations?.includes(file)).sort()) {
    try { await db.exec(readFileSync(join(directory, file), 'utf8').replace(/^create extension[^;]+;\s*/gm, '')); }
    catch (error) { await db.close(); throw new Error(`Migration ${file} failed`, { cause: error }); }
  }
  async function value<T>(sql: string, args: unknown[] = []): Promise<T> {
    return (await db.query<{ v: T }>(sql, args)).rows[0].v;
  }
  async function rpc<T = Record<string, unknown>>(name: string, args: unknown[] = []) {
    return value<T>(`select public.${name}(${args.map((_, index) => `$${index + 1}`).join(',')}) v`, args);
  }
  async function identity(role = 'postgres', owner = fixtureOwner) {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role, sub: owner })]);
    if (role !== 'postgres') await db.exec(`set role ${role}`);
  }
  let workspace = '', creator = '';
  if (!options.empty) {
  await db.query('insert into auth.users values($1),($2)', [fixtureOwner, fixtureStranger]);
  await identity('service_role'); await rpc('provision_owner', [fixtureOwner]);
  await identity('authenticated'); workspace = (await rpc<{ id: string }>('create_workspace', ['Backend feature fixtures'])).id;
  creator = (await rpc<{ id: string }>('add_creator', [workspace, 'backend_fixture'])).id;
  await identity();
  await db.exec("update public.creators set status='active'; update public.scrape_jobs set status='failed',actual_cost_usd=0,completed_at=now();");
  await db.query(`update public.app_settings set scraping_enabled=true,paused=false,initial_backfill_enabled=true,monthly_budget_usd=50,
    provider_account_id='fixture',provider_usage_checked_at=now(),provider_cycle_start_at=now()-interval '1 day',
    provider_cycle_end_at=now()+interval '20 days',provider_cycle_usage_usd=0,provider_cycle_limit_usd=50 where owner_user_id=$1`, [fixtureOwner]);
  if (await value<boolean>("select to_regprocedure('public.worker_configure_apify_account(uuid,integer,text,boolean,boolean)') is not null v")) {
    await identity('service_role');
    await rpc('worker_configure_apify_account', [fixtureOwner, 1, 'fixture', true, true]);
    await rpc('worker_record_account_usage', [fixtureOwner, 1, 'fixture', new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 20 * 86_400_000).toISOString(), 0, 50]);
    await identity();
  }
  }
  let sequence = 0;
  async function reel(media = true, creatorId = creator, published: string | null = '2026-01-01T00:00:00Z', requested = true) {
    await identity();
    const shortcode = `FEATURE_${++sequence}`;
    const id = await value<string>(`insert into public.reels(creator_id,shortcode,reel_url,published_at,duration_seconds,latest_fetched_at,provider,latest_views,views_state)
      values($1,$2,$3,$4,60,now()-interval '2 days','fixture',100,'known') returning id v`, [creatorId, shortcode, `https://www.instagram.com/reel/${shortcode}/`, published]);
    await identity('service_role');
    await rpc('worker_observe_reel_media', [id, media ? 'https://scontent.cdninstagram.com/fixture.mp4' : null, '[]', true, new Date().toISOString()]);
    // Existing worker tests seed waiting requests; on-demand tests explicitly
    // opt out to exercise imported Reels without a user request.
    if (requested) {
      await identity();
      await db.query('update public.transcript_jobs set priority_requested_at=now() where reel_id=$1', [id]);
      await identity('service_role');
    }
    return id;
  }
  async function activate() {
    await identity();
    await db.exec(`update public.transcription_settings set key_validated=true,contract_validated=true,account_pricing_validated=true,
      pilot_verified=true,phase='automatic',enabled=true,paused=false,media_recovery_enabled=true,monthly_budget_usd=100;
      insert into vault.secrets(name,secret) values('reelradar_transcription_webhook_hmac_v1','synthetic-test-secret');
      update public.transcription_webhook_setup set status='configured',webhook_id='fixture',secret_id=(select id from vault.secrets where name='reelradar_transcription_webhook_hmac_v1' limit 1) where singleton;`);
    await identity('service_role');
  }
  return { db, value, rpc, identity, reel, activate, workspace, creator };
}

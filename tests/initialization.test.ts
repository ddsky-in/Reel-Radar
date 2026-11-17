import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const db = new PGlite();
const owner = 'b0000000-0000-4000-8000-000000000001';
let workspace: string, job: string, envelope: string;
async function role(name: 'postgres' | 'authenticated' | 'service_role') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: owner, role: name, email: 'local-test@example.test' })]);
  if (name !== 'postgres') await db.exec(`set role ${name}`);
}
async function value<T>(sql: string, args: unknown[] = []): Promise<T> { return (await db.query<{ value: T }>(sql, args)).rows[0].value; }
beforeAll(async () => {
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role' $$;
    grant usage on schema public,auth to anon,authenticated,service_role; grant execute on all functions in schema auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
  for (const file of ['202611080001_schema.sql','202611080002_queue.sql','202611080003_initial_backfill_and_usage.sql']) await db.exec(readFileSync(join(process.cwd(),'supabase/migrations',file),'utf8'));
  await db.query('insert into auth.users values ($1)',[owner]);
  await role('service_role'); await db.query('select public.provision_owner($1)',[owner]);
  envelope = await value<string>('select public.worker_configure_budget_envelope($1,.25) as value',[owner]);
  await role('authenticated'); workspace = (await value<{ id: string }>('select public.create_workspace($1) as value',['Local initialization test'])).id;
},60000);
afterAll(async()=>{await db.close();});

describe('incremental initial100 and budget controls in actual PostgreSQL',()=>{
  it('queues exactly one100 initial job in the add transaction',async()=>{
    const added = await value<{id:string; initial_backfill_job_id:string}>('select public.add_creator($1,$2) as value',[workspace,'@Example']);
    job=added.initial_backfill_job_id;
    expect(job).toBeTruthy();
    expect(await value<number>('select results_limit as value from public.scrape_jobs where id=$1',[job])).toBe(100);
    expect(await value<string>('select envelope_id as value from public.scrape_jobs where id=$1',[job])).toBe(envelope);
  });
  it('does not repeat initialization for normalized duplicates or shared workspace links',async()=>{
    const second=(await value<{id:string}>('select public.create_workspace($1) as value',['Shared initialization'])).id;
    expect((await value<{initial_backfill_job_id:null}>('select public.add_creator($1,$2) as value',[second,'https://instagram.com/Example/reels/'])).initial_backfill_job_id).toBeNull();
    expect(await value<number>('select count(*)::int as value from public.creator_initializations')).toBe(1);
    expect(await value<number>('select count(*)::int as value from public.scrape_jobs')).toBe(1);
  });
  it('rolls back capacity-failed imports and their jobs',async()=>{
    await db.query('select public.update_settings($1)',[{capacity:1}]);
    await expect(db.query('select public.import_creators($1,$2)',[workspace,[{username:'extra_one'},{username:'extra_two'}]])).rejects.toThrow(/capacity_exceeded/);
    expect(await value<number>('select count(*)::int as value from public.scrape_jobs')).toBe(1);
    expect(await value<number>('select count(*)::int as value from public.creators')).toBe(1);
    await db.query('select public.update_settings($1)',[{capacity:120,weekly_limit:20}]);
    expect(await value<number>('select results_limit as value from public.scrape_jobs where id=$1',[job])).toBe(100);
  });
  it('keeps live switches off even though automatic initialization is queued',async()=>{
    await role('service_role');
    expect(await value<{reason:string}>('select public.worker_claim_dispatch($1,true,$2,$3) as value',[owner,'real-actor','backfill'])).toEqual({reason:'globalscraping_disabled'});
  });
  it('binds first verified account usage but refuses a different account',async()=>{
    const start=new Date(Date.now()-86400000).toISOString(),end=new Date(Date.now()+86400000*20).toISOString();
    await db.query('select public.worker_record_usage($1,$2,$3,$4,$5,$6)',[owner,'verified-owner',start,end,0,5]);
    await expect(db.query('select public.worker_record_usage($1,$2,$3,$4,$5,$6)',[owner,'different-owner',start,end,0,5])).rejects.toThrow(/provider_account_mismatch/);
    await role('postgres');await db.query('update public.app_settings set scraping_enabled=true,initial_backfill_enabled=true,max_run_charge_usd=.10 where owner_user_id=$1',[owner]);
  });
  it('allows initial100 while schedules paused and enforces aggregate envelope across runs',async()=>{
    await role('service_role');
    const claim=await value<{job:{id:string;dispatch_nonce:string;reserved_usd:number}}>('select public.worker_claim_dispatch($1,true,$2,$3) as value',[owner,'real-actor','backfill']);
    expect(claim.job.id).toBe(job);expect(Number(claim.job.reserved_usd)).toBe(.10);
    await db.query('select public.worker_attach_run($1,$2,$3,$4,$5,$6)',[job,claim.job.dispatch_nonce,'owned-run','real-actor','verified-owner','owned-dataset']);
    await db.query('select public.worker_reconcile_run($1,$2,$3,$4,$5,$6,$7)',[job,'owned-run','real-actor','verified-owner','SUCCEEDED','owned-dataset',.20]);
    await role('postgres');await db.query("update public.scrape_jobs set status='partial',completed_at=now(),lease_token=null,lease_expires_at=null where id=$1",[job]);
    await role('authenticated');await db.query('select public.add_creator($1,$2)',[workspace,'another_creator']);
    await role('service_role');
    expect(await value<{reason:string}>('select public.worker_claim_dispatch($1,true,$2,$3) as value',[owner,'real-actor','backfill'])).toEqual({reason:'budget_paused'});
    expect(await value<{reason:string}>('select public.worker_schedule($1,$2) as value',[owner,'daily'])).toEqual({job_ids:[],reason:'paused'});
  });
  it('new privileged tables and RPCs do not inherit broad hosted API grants',async()=>{
    await role('postgres');
    expect(await value<boolean>("select has_table_privilege('anon','public.budget_envelopes','select') as value")).toBe(false);
    expect(await value<boolean>("select has_function_privilege('authenticated','public.worker_record_usage(uuid,text,timestamptz,timestamptz,numeric,numeric)','execute') as value")).toBe(false);
    expect(await value<boolean>("select has_function_privilege('anon','public.assign_job_budget_envelope()','execute') as value")).toBe(false);
  });
});

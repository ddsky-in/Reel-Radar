import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>;
type Claim = { reason?: string; job?: { id: string; kind: string; collection_source: string; apify_account_slot: number; reserved_usd: number; dispatch_nonce: string }; max_total_charge_usd?: number };
type Executor = { executor_nonce: string; claimed_revision: number };
const kinds = ['profile','daily','weekly','backfill','manual','retry','discovery','metrics','carousel'];
const actors = Object.fromEntries(kinds.map(kind => [kind, 'fixture-actor']));
beforeAll(async () => { f = await featureDatabase(); }, 60000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => {
  await f.identity(); await f.db.exec('begin');
  await f.db.exec("update public.scrape_jobs set status='failed',live=false,actual_cost_usd=0,reserved_usd=0; update public.app_settings set monthly_budget_usd=50,scraping_enabled=true,initial_backfill_enabled=true,paused=false;");
  await f.identity('service_role');
  for (let slot=1; slot<=5; slot++) {
    const id=slot===1 ? 'fixture' : `account-${slot}`;
    await f.rpc('worker_configure_apify_account',[fixtureOwner,slot,id,true,true]);
    await f.rpc('worker_record_account_usage',[fixtureOwner,slot,id,new Date(Date.now()-86400000).toISOString(),new Date(Date.now()+20*86400000).toISOString(),0,50]);
  }
});
afterEach(async () => { await f.db.exec('rollback'); await f.identity(); });
const config = (active: number, starts=active) => f.rpc('worker_configure_collection_throughput',[fixtureOwner,active,starts]);
const runtime = () => f.rpc<{ max_active: number; max_starts_per_wake: number; wake_revision: number; drained_revision: number; wake_pending: boolean; last_category: string }>('worker_collection_runtime',[fixtureOwner]);
const next = (eligible=kinds,executor?:Executor) => f.rpc<Claim>('worker_claim_next',[fixtureOwner,true,JSON.stringify(actors),eligible,...executor?[executor.executor_nonce,executor.claimed_revision]:[]]);
const claimExecutor = () => f.rpc<Executor>('worker_claim_collection_executor',[fixtureOwner,true]);
const drainExecutor = (executor:Executor) => f.rpc<boolean>('worker_drain_completion_wake',[fixtureOwner,executor.claimed_revision,executor.executor_nonce]);
async function pending(kind='daily',priority=0,results=kind==='profile'?1:30) {
  // Seed an already owner-authorized profile fixture; service callers cannot grant consent.
  if (kind==='profile') await f.identity();
  const id=await f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,priority,manual_authorized_by)
    values($1,$2,1,$3,$4,$1) returning id v`,[fixtureOwner,kind,results,priority]);
  await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)',[id,f.creator]);
  if (kind==='profile') await f.identity('service_role');
  return id;
}
async function settle(id: string,cost: number | null=.01) {
  await f.identity();
  await f.db.query("update public.scrape_jobs set status='succeeded',provider_terminal_status='SUCCEEDED',actual_cost_usd=$2,reserved_usd=case when $2::numeric is null then reserved_usd else 0 end,completed_at=now(),billing_reconciled_at=case when $2::numeric is not null then now() end where id=$1",[id,cost]);
  await f.identity('service_role');
}
async function rejected(call: () => Promise<unknown>,message: string) {
  await f.db.exec('savepoint rejected_call');
  try { await expect(call()).rejects.toThrow(message); }
  finally { await f.db.exec('rollback to savepoint rejected_call; release savepoint rejected_call'); }
}
describe('local forward collection throughput allocator',()=>{
  it('keeps default2 and configures staged3/4 without budgets, network or schedules',async()=>{
    expect(await runtime()).toMatchObject({max_active:2,max_starts_per_wake:2,wake_pending:false});
    expect(await config(3)).toEqual({max_active:3,max_starts_per_wake:3});
    expect(await config(4)).toEqual({max_active:4,max_starts_per_wake:4});
    expect(await f.value('select monthly_budget_usd::float8 v from public.app_settings')).toBe(50);
    await f.identity();
    expect(await f.value('select count(*)::int v from net.requests')).toBe(0);
    expect(await f.value('select count(*)::int v from cron.job')).toBe(0);
    await f.identity('service_role');
    for (const value of [0,5]) await rejected(()=>config(value),'invalid_collection_throughput');
    const sql=readFileSync(join(process.cwd(),'supabase/migrations/202611150001_collection_throughput.sql'),'utf8');
    expect(sql).not.toMatch(/cron\.(schedule|unschedule)|net\.http|vault\.|set reserved_usd=0/i);
  });
  it.each([3,4])('serializes contenders at max%s with distinct accounts and all monetary reservations',async active=>{
    await config(active); for(let i=0;i<active+2;i++) await pending();
    const claims=await Promise.all(Array.from({length:active+2},()=>next()));
    const jobs=claims.flatMap(claim=>claim.job ? [claim.job]:[]);
    expect(jobs).toHaveLength(active); expect(new Set(jobs.map(job=>job.id)).size).toBe(active);
    expect(jobs.map(job=>job.apify_account_slot)).toEqual(Array.from({length:active},(_,i)=>i+1));
    expect(jobs.every(job=>job.collection_source==='ordinary')).toBe(true);
    expect(claims.filter(claim=>!claim.job).every(claim=>claim.reason==='concurrency_limit')).toBe(true);
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.scrape_jobs where live')).toBeCloseTo(active * .1,6);
    expect(jobs.every(job=>job.reserved_usd <= .1)).toBe(true);
    expect(await f.value<number>('select max(holds)::float8 v from (select sum(reserved_usd) holds from public.scrape_jobs where live group by apify_account_slot) q')).toBeLessThanOrEqual(50);
  });
  it('preserves .907554 old primary uncertainty while using3 distinct secondary slots under max4',async()=>{
    await config(4);
    const old=await f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,status,requested_profiles_count,results_limit,live,reserved_usd,expected_actor_id,expected_provider_user_id,apify_account_slot,attempt_count,dispatch_nonce)
      values($1,'daily','uncertain',1,30,true,.907554,'fixture-actor','fixture',1,1,gen_random_uuid()) returning id v`,[fixtureOwner]);
    await f.rpc('worker_invalidate_account_usage',[fixtureOwner,1]);
    for(let i=0;i<4;i++) await pending();
    expect((await Promise.all([next(),next(),next()])).map(claim=>claim.job?.apify_account_slot)).toEqual([2,3,4]);
    expect(await next()).toEqual({reason:'concurrency_limit'});
    expect(await f.value('select jsonb_build_object(\'hold\',reserved_usd,\'cost\',actual_cost_usd,\'status\',status) v from public.scrape_jobs where id=$1',[old])).toEqual({hold:.907554,cost:null,status:'uncertain'});
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.scrape_jobs where live')).toBeCloseTo(.907554 + 3 * .1,6);
  });
  it('rotates categories durably preserving priority within category and disabled kinds cannot starve',async()=>{
    await config(4);
    await pending('daily',99); const top=await pending('weekly',100);
    const carousel=await pending('carousel',1),profile=await pending('profile',0);
    const first=await next(); expect(first.job?.id).toBe(profile); await settle(profile);
    const second=await next(); expect(second.job?.id).toBe(top); await settle(top);
    expect((await next()).job?.id).toBe(carousel); await settle(carousel);
    expect((await runtime()).last_category).toBe('carousels');
    for(let i=0;i<40;i++) await pending('profile',100);
    expect((await next(['daily'])).job?.kind).toBe('daily');
  });
  it.each(['empty','invalid'])('skips an %s head by ID and claims the next job of the same kind',async head=>{
    const blocked=await pending('daily',100,head==='invalid'?9:30),alternate=await pending('daily',90);
    if(head==='empty') {
      await f.identity(); await f.db.query('delete from public.scrape_job_creators where job_id=$1',[blocked]);
      await f.identity('service_role');
    }
    const claim=await next(['daily']);
    expect(claim.job).toMatchObject({id:alternate,kind:'daily',collection_source:'ordinary',apify_account_slot:1});
    expect(await f.value(`select jsonb_build_object('status',status,'attempts',attempt_count,'nonce',dispatch_nonce,
      'slot',apify_account_slot,'live',live,'hold',reserved_usd,'cost',actual_cost_usd) v from public.scrape_jobs where id=$1`,[blocked]))
      .toEqual({status:head==='empty'?'failed':'pending',attempts:0,nonce:null,slot:null,live:false,hold:0,cost:head==='empty'?0:null});
    expect((await runtime()).last_category).toBe('reels');
    await settle(alternate);
    const later=await pending('daily',80);
    expect((await next(['daily'])).job?.id).toBe(later);
  });
  it('bounds individual rejected heads per category without hiding alternate category work',async()=>{
    for(let i=0;i<40;i++) await pending('manual',100,100);
    const carousel=await pending('carousel');
    expect((await next(['manual','carousel'])).job?.id).toBe(carousel);
    expect((await runtime()).last_category).toBe('carousels');
    const sql=readFileSync(join(process.cwd(),'supabase/migrations/202611150001_collection_throughput.sql'),'utf8');
    expect(sql).toContain('for candidate_index in 1..32 loop');
    expect(sql).toContain('not q.id=any(attempted_ids)');
    expect(sql).not.toContain('attempted_kinds');
  });
  it.each(['daily','carousel'])('skips a pinned %s prior start without replaying it or blocking valid alternate work',async kind=>{
    await config(4);
    const pinned=await f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,priority,
      manual_authorized_by,live,apify_account_slot,attempt_count,started_at,dispatch_nonce,expected_actor_id,expected_provider_user_id,reserved_usd)
      values($1,$2,1,30,100,$1,true,1,1,now(),gen_random_uuid(),'fixture-actor','fixture',.907554) returning id v`,[fixtureOwner,kind]);
    await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)',[pinned,f.creator]);
    const alternate=await pending(kind,90),other=await pending('profile',1);
    const before=await f.value('select to_jsonb(j) v from public.scrape_jobs j where id=$1',[pinned]);
    await f.identity('service_role');
    expect((await next([kind])).job).toMatchObject({id:alternate,kind,collection_source:'ordinary'});
    await settle(alternate);
    expect((await next([kind,'profile'])).job?.id).toBe(other);
    expect(await f.value('select to_jsonb(j) v from public.scrape_jobs j where id=$1',[pinned])).toEqual(before);
  });
  it('filters an account pin independently of the live prior-start evidence fields',async()=>{
    const pinned=await f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,priority,
      apify_account_slot,expected_provider_user_id) values($1,'daily',1,30,100,1,'fixture') returning id v`,[fixtureOwner]);
    await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)',[pinned,f.creator]);
    const alternate=await pending('daily',90),before=await f.value('select to_jsonb(j) v from public.scrape_jobs j where id=$1',[pinned]);
    expect((await next(['daily'])).job?.id).toBe(alternate);
    expect(await f.value('select to_jsonb(j) v from public.scrape_jobs j where id=$1',[pinned])).toEqual(before);
  });
  it.each(['attempt_count','started_at','dispatch_nonce','actor_run_id','provider_terminal_status'])('filters live prior-start evidence %s even independently of account pinning',async evidence=>{
    const blocked=await pending('daily',100),alternate=await pending('daily',90);
    const expression: Record<string,string>={attempt_count:'1',started_at:'now()',dispatch_nonce:'gen_random_uuid()',actor_run_id:"'prior-run'",provider_terminal_status:"'SUCCEEDED'"};
    await f.identity();
    // Deliberately seed malformed historical combinations; do not infer replay
    // safety from settled billing or missing account/nonce companion evidence.
    await f.db.query(`update public.scrape_jobs set live=true,actual_cost_usd=0,billing_reconciled_at=now(),${evidence}=${expression[evidence]} where id=$1`,[blocked]);
    const before=await f.value('select to_jsonb(j) v from public.scrape_jobs j where id=$1',[blocked]);
    await f.identity('service_role');
    const claim=await next(['daily']);
    if(evidence==='started_at') expect(claim.job?.id).toBe(alternate);
    // Unmapped prior paid starts remain an owner/account-wide billing gate;
    // excluding their ID never bypasses the account registry safety check.
    else expect(claim).toEqual({reason:'unreconciled_charges'});
    expect(await f.value('select to_jsonb(j) v from public.scrape_jobs j where id=$1',[blocked])).toEqual(before);
  });
  it('unknown costs block only their account; verified busy capacity is not credit exhaustion',async()=>{
    await config(4); await pending(); await pending(); const first=await next(); await settle(first.job!.id,null);
    await pending(); expect((await next()).job?.apify_account_slot).toBe(2);
    for(let slot=3;slot<=5;slot++) await f.rpc('worker_configure_apify_account',[fixtureOwner,slot,`account-${slot}`,false,true]);
    await pending(); expect(await next()).toEqual({reason:'account_capacity_full'});
    await f.identity('authenticated');
    const status=await f.rpc<{ accounts:{reason:string|null}[] }>('get_apify_account_status');
    expect(status.accounts[0].reason).toBe('unreconciled_charges'); expect(status.accounts[1].reason).toBe('account_capacity_full');
  });
  it.each([false,true])('reports zero ready accounts from capacity truthfully with summary parity (exhausted alternate=%s)',async exhausted=>{
    await config(4); await pending(); await pending();
    const first=(await next()).job!;
    for(let slot=2;slot<=5;slot++) await f.rpc('worker_configure_apify_account',[fixtureOwner,slot,`account-${slot}`,false,true]);
    if(exhausted) {
      await f.rpc('worker_configure_apify_account',[fixtureOwner,2,'account-2',true,true]);
      await f.rpc('worker_record_account_usage',[fixtureOwner,2,'account-2',new Date(Date.now()-86400000).toISOString(),new Date(Date.now()+20*86400000).toISOString(),50,50]);
    }
    expect(await next()).toEqual({reason:'account_capacity_full'});
    const before=await f.value('select to_jsonb(j) v from public.scrape_jobs j where id=$1',[first.id]);
    await f.identity('authenticated');
    const status=await f.rpc<{ ready_accounts:number; accounts:{reason:string|null}[] }>('get_apify_account_status');
    expect(status.ready_accounts).toBe(0); expect(status.accounts[0].reason).toBe('account_capacity_full');
    const state=await f.rpc<{reason:string|null;blocking_job_id:string|null}>('get_creator_collection_state',[f.workspace,[f.creator]]);
    const summary=await f.rpc<{reason:string|null;blocking_job_id:string|null}>('get_creator_collection_summary',[f.workspace]);
    expect(state).toMatchObject({reason:'concurrency_limit',blocking_job_id:null});
    expect(summary).toMatchObject({reason:state.reason,blocking_job_id:state.blocking_job_id});
    await f.identity('service_role');
    expect(await f.value('select to_jsonb(j) v from public.scrape_jobs j where id=$1',[first.id])).toEqual(before);
  });
  it('honors an already pinned target through both old wrappers and restores session scope',async()=>{
    await pending('daily',100); const target=await pending('carousel',0);
    await f.db.query("select set_config('reelradar.media_job_id',$1,true)",[target]);
    expect((await next()).job?.id).toBe(target);
    expect(await f.value("select current_setting('reelradar.media_job_id',true) v")).toBe(target);
  });
  it('does not escape an explicitly pinned rejected target to otherwise eligible ordinary work',async()=>{
    const target=await pending('daily',100,9),alternate=await pending('daily',90);
    await f.db.query("select set_config('reelradar.media_job_id',$1,true)",[target]);
    expect(await next(['daily'])).toEqual({reason:'provider_input_invalid'});
    expect(await f.value("select current_setting('reelradar.media_job_id',true) v")).toBe(target);
    expect(await f.value('select status v from public.scrape_jobs where id=$1',[alternate])).toBe('pending');
  });
  it('disabled automatic carousel and closed profile heads cannot hide eligible reel work',async()=>{
    const carousel=await pending('carousel',100);await f.identity();
    await f.db.query('update public.scrape_jobs set carousel_automatic=true,carousel_automation_scheduled_at=now() where id=$1',[carousel]);
    await f.identity('service_role');const daily=await pending('daily');
    expect((await next(['carousel','daily'])).job?.id).toBe(daily);
    expect(await f.value('select status v from public.scrape_jobs where id=$1',[carousel])).toBe('pending');
  });
  it('legacy direct claims share max4 and one outstanding per account transactionally',async()=>{
    await config(4); for(let i=0;i<5;i++) await pending();
    const claims=await Promise.all(Array.from({length:5},()=>f.rpc<Claim>('worker_claim_dispatch',[fixtureOwner,true,'fixture-actor','daily'])));
    expect(claims.flatMap(claim=>claim.job?[claim.job.apify_account_slot]:[])).toEqual([1,2,3,4]);
    expect(claims[4]).toEqual({reason:'concurrency_limit'});
  });
  it('keeps unmapped historical attempts globally fail closed',async()=>{
    await config(4);
    await f.db.query("insert into public.scrape_jobs(owner_user_id,kind,status,requested_profiles_count,results_limit,live,reserved_usd,expected_provider_user_id,attempt_count) values($1,'daily','uncertain',1,30,true,.1,'unmapped',1)",[fixtureOwner]);
    await pending(); expect(await next()).toEqual({reason:'unreconciled_charges'});
  });
});
describe('durable completion provenance and coalesced wakes',()=>{
  it('records finishing transaction before RPC/ACK, coalesces duplicate and preserves later revisions after drain',async()=>{
    await pending(); const first=(await next()).job!; await settle(first.id);
    expect(await runtime()).toMatchObject({wake_revision:1,drained_revision:0,wake_pending:true});
    expect(await f.rpc('worker_record_completion_wake',[fixtureOwner,first.id])).toBe(true);
    expect((await runtime()).wake_revision).toBe(1);
    const executor=await claimExecutor(); expect(executor.claimed_revision).toBe(1);
    await pending(); const second=(await next(kinds,executor)).job!; await settle(second.id);
    expect(await drainExecutor(executor)).toBe(true);
    expect(await runtime()).toMatchObject({wake_revision:2,drained_revision:1,wake_pending:true});
    const laterExecutor=await claimExecutor(); expect(laterExecutor.claimed_revision).toBe(2);
    expect(await drainExecutor(laterExecutor)).toBe(true);
    expect((await runtime()).wake_pending).toBe(false);
    expect(await f.rpc('worker_record_completion_wake',[fixtureStranger,first.id])).toBe(false);
  });
  it('unknown cost completion wakes alternates; late billing adds one new durable wake',async()=>{
    await pending(); const job=(await next()).job!; await settle(job.id,null);
    expect(await runtime()).toMatchObject({wake_pending:true,wake_revision:1});
    const executor=await claimExecutor(); expect(executor.claimed_revision).toBe(1);
    expect(await drainExecutor(executor)).toBe(true);
    await settle(job.id,.01); expect(await runtime()).toMatchObject({wake_pending:true,wake_revision:2});
    expect(await f.rpc('worker_record_completion_wake',[fixtureOwner,job.id])).toBe(true);
    expect((await runtime()).wake_revision).toBe(2);
  });
  it('pilot provenance persists after gate removal and cannot wake/dispatch unrelated jobs',async()=>{
    const id=await pending('carousel'); await pending('daily',100);
    const trial=await f.rpc<Claim>('worker_claim_carousel_pilot',[fixtureOwner,id,'fixture-actor']);
    expect(trial.job).toMatchObject({id,collection_source:'carousel_pilot',reserved_usd:.1});
    await settle(id); expect(await f.rpc('worker_record_completion_wake',[fixtureOwner,id])).toBe(false);
    expect((await runtime()).wake_pending).toBe(false);
  });
  it('operator settlement and legacy completions do not create generic wakes',async()=>{
    await pending(); const job=(await next()).job!;
    await f.rpc('worker_isolate_collection_settlement',[fixtureOwner,job.id]); await settle(job.id);
    expect(await f.rpc('worker_record_completion_wake',[fixtureOwner,job.id])).toBe(false);
    const legacy=await pending(); await f.identity();
    await f.db.query("update public.scrape_jobs set live=true,status='succeeded',provider_terminal_status='SUCCEEDED',actual_cost_usd=.01 where id=$1",[legacy]);
    await f.identity('service_role'); expect((await runtime()).wake_pending).toBe(false);
  });
  it('target media stays outside generic fair selector and never creates ordinary wakes',async()=>{
    await f.activate(); await f.reel(false);
    const media=await f.rpc<{job_id:string}>('worker_transcription_media_enqueue',[f.creator]);
    const ordinary=await pending(); expect((await next()).job?.id).toBe(ordinary); await settle(ordinary);
    const claimed=await f.rpc<Claim>('worker_transcription_media_claim',[media.job_id,'fixture-actor']);
    expect(claimed.job?.collection_source).toBe('target_media'); await settle(media.job_id);
    const before=(await runtime()).wake_revision;
    expect(await f.rpc('worker_record_completion_wake',[fixtureOwner,media.job_id])).toBe(false);
    expect((await runtime()).wake_revision).toBe(before);
  });
  it.each(['anon','authenticated'])('denies service config/wake/claims for %s',async role=>{
    await f.identity(role);
    await rejected(()=>config(3),'permission denied');
    await rejected(()=>next(),'permission denied');
    await rejected(()=>runtime(),'permission denied');
    await rejected(()=>f.rpc('worker_record_completion_wake',[fixtureOwner,f.creator]),'permission denied');
  });
});

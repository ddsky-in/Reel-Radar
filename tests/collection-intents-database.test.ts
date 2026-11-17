import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>;
type Job = { id: string; kind: string; dispatch_nonce: string; started_at: string; dispatch_phase: string; recovery_version: number; reserved_usd: number; claimed_cap_usd: number; input_digest: string | null; apify_account_slot: number };
type Claim = { job?: Job; reason?: string; max_total_charge_usd?: number };
type Executor = { executor_nonce: string; claimed_revision: number };
const actor='fixture-actor', digest='ab'.repeat(32);
let currentExecutor: Executor | undefined;
beforeAll(async()=> { f=await featureDatabase(); },60000);
afterAll(async()=> { await f?.db.close(); });
beforeEach(async()=> {
  currentExecutor=undefined;
  await f.identity(); await f.db.exec('begin');
  await f.db.exec("update public.scrape_jobs set status='failed',live=false,actual_cost_usd=0,reserved_usd=0; update public.app_settings set monthly_budget_usd=50,collection_job_cap_usd=.1,scraping_enabled=true,initial_backfill_enabled=true,paused=false;");
  await f.identity('service_role');
  for(let slot=1;slot<=5;slot++) {
    const provider=slot===1?'fixture':`account-${slot}`;
    await f.rpc('worker_configure_apify_account',[fixtureOwner,slot,provider,true,true]);
    await f.rpc('worker_record_account_usage',[fixtureOwner,slot,provider,new Date(Date.now()-86400000).toISOString(),new Date(Date.now()+864000000).toISOString(),0,50]);
  }
});
afterEach(async()=> { await f.db.exec('rollback'); await f.identity(); });
async function rejected(call:()=>Promise<unknown>, message:string) {
  await f.db.exec('savepoint rejected_call');
  try { await expect(call()).rejects.toThrow(message); }
  finally { await f.db.exec('rollback to savepoint rejected_call; release savepoint rejected_call'); }
}
async function pending(kind='daily',results=30) {
  await f.identity();
  const id=await f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,manual_authorized_by)
    values($1,$2,1,$3,$1) returning id v`,[fixtureOwner,kind,results]);
  await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)',[id,f.creator]);
  await f.identity('service_role'); return id;
}
const next=(executor?:Executor,kind='daily')=>f.rpc<Claim>('worker_claim_next',[fixtureOwner,true,JSON.stringify({[kind]:actor}),[kind],...executor?[executor.executor_nonce,executor.claimed_revision]:[]]);
const authorize=(job:Job,executor:Executor | undefined=currentExecutor)=>f.rpc<{authorized:boolean;reason?:string;job?:Job}>('worker_authorize_collection_submit',[fixtureOwner,job.id,job.dispatch_nonce,digest,...executor?[executor.executor_nonce,executor.claimed_revision]:[]]);
async function claim(kind='daily',executor?:Executor) {
  await pending(kind,kind==='profile'?1:30);
  currentExecutor=executor??currentExecutor??await f.rpc<Executor>('worker_claim_collection_executor',[fixtureOwner,false]);
  return (await next(currentExecutor,kind)).job!;
}
async function legacy(hold=.907554,slot=1) {
  await f.identity();
  const job=await f.value<Job>(`insert into public.scrape_jobs(owner_user_id,kind,status,requested_profiles_count,results_limit,live,reserved_usd,
    expected_actor_id,expected_provider_user_id,apify_account_slot,attempt_count,dispatch_nonce,started_at,billing_month)
    values($1,'daily','uncertain',1,30,true,$2,$3,$4,$5,1,gen_random_uuid(),now()-interval '2 days',date_trunc('month',now() at time zone 'UTC')::date) returning to_jsonb(scrape_jobs) v`,
    [fixtureOwner,hold,actor,slot===1?'fixture':`account-${slot}`,slot]);
  await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)',[job.id,f.creator]);
  await f.identity('service_role'); return job;
}
async function settle(job:Job,key='owner-release') {
  await f.identity('service_role'); await f.rpc('worker_set_collection_start_gate',[fixtureOwner,true]);
  await f.identity('authenticated');
  return f.rpc<Record<string,unknown>>('collection_settle_job',[job.id,'risk_release','Accept unresolved provider liability','owner_ui_explicit_decision',key,job.recovery_version,true]);
}
async function row(id:string) { return f.value<Record<string,unknown>>('select to_jsonb(j) v from public.scrape_jobs j where id=$1',[id]); }

describe('transactional phase-specific submission intents',()=> {
  it('loads the full chain with default .10 and no network or Cron',async()=> {
    expect(await f.value('select collection_job_cap_usd::float8 v from public.app_settings')).toBe(.1);
    expect(await f.value('select paid_starts_gated v from public.collection_worker_settings')).toBe(false);
    await f.identity();
    expect(await f.value('select count(*)::int v from net.requests')).toBe(0);
    expect(await f.value('select count(*)::int v from cron.job')).toBe(0);
  });
  it('prepares an immutable cap snapshot, authorizes exactly once, and rejects stale executor ownership',async()=> {
    const executor=await f.rpc<Executor>('worker_claim_collection_executor',[fixtureOwner,false]);
    const job=await claim('daily',executor);
    expect(job).toMatchObject({dispatch_phase:'prepared',claimed_cap_usd:.1,reserved_usd:.1,input_digest:null});
    expect(await f.rpc('worker_authorize_collection_submit',[fixtureOwner,job.id,job.dispatch_nonce,digest])).toEqual({authorized:false,reason:'executor_lease_lost'});
    expect(await authorize(job,executor)).toMatchObject({authorized:true,job:{dispatch_phase:'submission_authorized',input_digest:digest}});
    expect(await authorize(job,executor)).toEqual({authorized:false,reason:'intent_not_fresh'});
    await f.identity();
    const intent=await f.value<Record<string,unknown>>('select to_jsonb(i) v from collection_intents_private.intents i where job_id=$1',[job.id]);
    expect(intent).toMatchObject({claimed_cap_usd:.1,input_digest:digest,executor_nonce:executor.executor_nonce,executor_revision:executor.claimed_revision});
    await rejected(()=>f.db.query('update collection_intents_private.intents set claimed_cap_usd=2 where job_id=$1',[job.id]),'immutable_collection_intent');
    await rejected(()=>f.db.query('update public.scrape_jobs set input_digest=$2 where id=$1',[job.id,'cd'.repeat(32)]),'immutable_collection_claim');
    await rejected(()=>f.db.query("update public.scrape_jobs set dispatch_phase='prepared' where id=$1",[job.id]),'collection_phase_regression');
  });
  it('keeps compatibility direct-service claims prepared but requires a fenced executor before ordinary paid submission',async()=> {
    await pending(); const direct=(await next()).job!;
    expect(await authorize(direct)).toEqual({authorized:false,reason:'executor_lease_lost'});
    const executor=await f.rpc<Executor>('worker_claim_collection_executor',[fixtureOwner,false]);
    expect(await authorize(direct,executor)).toEqual({authorized:false,reason:'executor_lease_lost'});
  });
  it('enforces the start gate on every live claim and rechecks it between preparation and submission',async()=> {
    const job=await claim();
    expect(await f.rpc('worker_set_collection_start_gate',[fixtureOwner,true])).toEqual({paid_starts_gated:true});
    expect(await authorize(job)).toEqual({authorized:false,reason:'paid_starts_gated'});
    const daily=await pending();
    expect(await next(currentExecutor)).toEqual({reason:'paid_starts_gated'});
    expect(await f.rpc('worker_claim_dispatch',[fixtureOwner,true,actor,'daily'])).toEqual({reason:'paid_starts_gated'});
    const pilot=await pending('carousel');
    expect(await f.rpc('worker_claim_carousel_pilot',[fixtureOwner,pilot,actor])).toEqual({reason:'paid_starts_gated'});
    expect((await row(daily)).attempt_count).toBe(0);
    expect((await row(job.id)).dispatch_phase).toBe('prepared');
    const wakeBefore=(await f.rpc<{wake_revision:number}>('worker_collection_runtime',[fixtureOwner])).wake_revision;
    expect(await f.rpc('worker_cancel_pre_submit',[fixtureOwner,job.id,job.dispatch_nonce,'Gate activated before submit'])).toEqual({cancelled:true,replayed:false});
    expect(await f.rpc('worker_collection_runtime',[fixtureOwner])).toMatchObject({wake_revision:wakeBefore,paid_starts_gated:true});
  });
  it('honors zero and smaller caps without allocating monthly budget across a single job',async()=> {
    await f.identity('authenticated');
    expect(await f.rpc('update_settings',[JSON.stringify({collection_job_cap_usd:0})])).toMatchObject({collection_job_cap_usd:0});
    await f.identity('service_role'); await pending();
    expect(await next()).toEqual({reason:'job_cap_disabled'});
    await f.identity('authenticated');
    await f.rpc('update_settings',[JSON.stringify({collection_job_cap_usd:.025})]);
    await f.identity('service_role'); expect((await next()).job).toMatchObject({reserved_usd:.025,claimed_cap_usd:.025});
  });
  it('cancels only a prepared no-submit proof, no wake, no run binding, no browser proof flags',async()=> {
    const job=await claim();
    const wakeBefore=(await f.rpc<{wake_revision:number}>('worker_collection_runtime',[fixtureOwner])).wake_revision;
    expect(await f.rpc('worker_dispatch_failure',[fixtureOwner,job.id,job.dispatch_nonce,'definite_no_start','Local preparation failed'])).toMatchObject({recorded:true});
    expect(await row(job.id)).toMatchObject({status:'failed',dispatch_phase:'cancelled_before_submit',reserved_usd:0,actual_cost_usd:0,collection_source:'operator_settle'});
    expect(await f.rpc('worker_collection_runtime',[fixtureOwner])).toMatchObject({wake_revision:wakeBefore});
    await rejected(()=>f.rpc('worker_attach_run',[job.id,job.dispatch_nonce,'late-impossible',actor,'fixture','dataset']),'run_identity_mismatch');
    const accepted=await claim(); await authorize(accepted);
    expect(await f.rpc('worker_cancel_pre_submit',[fixtureOwner,accepted.id,accepted.dispatch_nonce,'Not actually proof'])).toEqual({cancelled:false,reason:'submission_possible'});
  });
  it('settles a rolled-back authorization without searching or charging the provider',async()=> {
    const job=await claim();
    const runtime=await f.rpc<{wake_revision:number}>('worker_collection_runtime',[fixtureOwner]);
    expect(await f.rpc('worker_dispatch_failure',[fixtureOwner,job.id,job.dispatch_nonce,'request_unknown','Authorization RPC timed out'])).toEqual({recorded:true,cancelled:true});
    expect(await row(job.id)).toMatchObject({status:'failed',dispatch_phase:'cancelled_before_submit',reserved_usd:0,actual_cost_usd:0});
    expect(await authorize(job)).toEqual({authorized:false,reason:'intent_not_fresh'});
    expect(await f.rpc('worker_collection_runtime',[fixtureOwner])).toMatchObject({wake_revision:runtime.wake_revision});
  });
  it('repairs historical misclassification with exhausted lookup budget using immutable authorization proof',async()=> {
    const job=await claim();
    await f.identity();
    await f.db.query("update public.scrape_jobs set status='uncertain',dispatch_phase='request_unknown',missing_run_recovery_exhausted=true,missing_run_recovery_attempts=8,missing_run_recovery_pages=8 where id=$1",[job.id]);
    await f.identity('service_role');
    expect(await f.rpc('worker_expire_dispatches',[fixtureOwner])).toBe(1);
    expect(await row(job.id)).toMatchObject({status:'failed',dispatch_phase:'cancelled_before_submit',reserved_usd:0,actual_cost_usd:0});
    expect(await f.rpc('worker_expire_dispatches',[fixtureOwner])).toBe(0);
  });
  it('preserves committed authorization after a lost ACK, and never turns legacy uncertainty into zero cost',async()=> {
    const job=await claim(); await authorize(job);
    expect(await f.rpc('worker_dispatch_failure',[fixtureOwner,job.id,job.dispatch_nonce,'request_unknown','Authorization ACK lost'])).toEqual({recorded:true});
    const old=await legacy(.1,2);
    expect(await f.rpc('worker_cancel_pre_submit',[fixtureOwner,old.id,old.dispatch_nonce,'Missing journal is not proof'])).toEqual({cancelled:false,reason:'submission_possible'});
    await f.rpc('worker_expire_dispatches',[fixtureOwner]);
    expect(await row(job.id)).toMatchObject({status:'uncertain',dispatch_phase:'request_unknown',reserved_usd:.1,actual_cost_usd:null});
    expect(await row(old.id)).toMatchObject({status:'uncertain',reserved_usd:.1,actual_cost_usd:null});
  });
  it('keeps accepted evidence durable and idempotent across attachment failure, never grants billing trust',async()=> {
    const job=await claim(); await authorize(job);
    for(let n=0;n<2;n++) expect(await f.rpc('worker_record_accepted_evidence',[fixtureOwner,job.id,job.dispatch_nonce,'accepted-run','start_response',false])).toEqual({recorded:true});
    expect(await f.rpc('worker_dispatch_failure',[fixtureOwner,job.id,job.dispatch_nonce,'request_unknown','Attachment save lost'])).toEqual({recorded:false,reason:'stronger_evidence_preserved'});
    expect(await row(job.id)).toMatchObject({dispatch_phase:'accepted_save_pending',actual_cost_usd:null,billing_reconciled_at:null,reserved_usd:.1});
    expect(await f.rpc('worker_get_collection_recovery_state',[fixtureOwner,job.id,job.dispatch_nonce])).toMatchObject({input_digest:digest,accepted_evidence:[{run_id:'accepted-run',source:'start_response',verified:false}]});
    expect(await f.rpc('worker_record_accepted_evidence',[fixtureOwner,job.id,job.dispatch_nonce,'conflict','provider_recovery',true])).toEqual({recorded:false,reason:'evidence_identity_mismatch'});
    await rejected(()=>f.rpc('worker_attach_run',[job.id,job.dispatch_nonce,'other-run',actor,'fixture','dataset']),'run_identity_mismatch');
    await f.rpc('worker_attach_run',[job.id,job.dispatch_nonce,'accepted-run',actor,'fixture','dataset']);
    expect(await row(job.id)).toMatchObject({dispatch_phase:'attached',status:'running',actor_run_id:'accepted-run',actual_cost_usd:null});
  });
  it('refuses prepared cancellation once a callback receipt conflicts, and preserves callback exact pins',async()=> {
    const job=await claim();
    expect(await f.rpc('worker_record_callback_receipt',[fixtureOwner,job.id,job.dispatch_nonce,'hint-run',actor,'fixture'])).toEqual({accepted:true});
    expect(await authorize(job)).toEqual({authorized:false,reason:'accepted_evidence_conflict'});
    expect(await f.rpc('worker_cancel_pre_submit',[fixtureOwner,job.id,job.dispatch_nonce,'Local proof'])).toEqual({cancelled:false,reason:'submission_possible'});
    expect(await f.rpc('worker_get_collection_recovery_state',[fixtureOwner,job.id,job.dispatch_nonce])).toMatchObject({callback_hints:[{run_id:'hint-run',dispatch_nonce:job.dispatch_nonce}]});
    expect(await f.rpc('worker_get_collection_recovery_state',[fixtureStranger,job.id,job.dispatch_nonce])).toBeNull();
  });
  it('expires prepared intents as proven cancellation but keeps authorized/accepted/legacy evidence unknown',async()=> {
    const prepared=await claim();
    await f.identity(); await f.db.query("update public.scrape_jobs set lease_expires_at=now()-interval '1 second' where id=$1",[prepared.id]); await f.identity('service_role');
    expect(await f.rpc('worker_expire_dispatches',[fixtureOwner])).toBe(1);
    expect(await row(prepared.id)).toMatchObject({dispatch_phase:'cancelled_before_submit',actual_cost_usd:0,reserved_usd:0});
    const authorized=await claim(); await authorize(authorized);
    await f.identity(); await f.db.query("update public.scrape_jobs set lease_expires_at=now()-interval '1 second' where id=$1",[authorized.id]); await f.identity('service_role');
    await f.rpc('worker_expire_dispatches',[fixtureOwner]);
    expect(await row(authorized.id)).toMatchObject({status:'uncertain',dispatch_phase:'request_unknown',actual_cost_usd:null,reserved_usd:.1});
  });
  it.each([.025,1])('authorizes an exact carousel pilot with a .10 trial ceiling and configured cap %s',async configuredCap=> {
    const id=await pending('carousel');
    await f.identity('authenticated'); await f.rpc('update_settings',[JSON.stringify({collection_job_cap_usd:configuredCap})]); await f.identity('service_role');
    const pilot=(await f.rpc<Claim>('worker_claim_carousel_pilot',[fixtureOwner,id,actor])).job!;
    expect(pilot).toMatchObject({claimed_cap_usd:Math.min(configuredCap,.1),reserved_usd:Math.min(configuredCap,.1),dispatch_phase:'prepared'});
    expect(await f.rpc('worker_authorize_collection_submit',[fixtureOwner,id,pilot.dispatch_nonce,digest])).toMatchObject({authorized:true});
  });
  it('never lets NULL/empty run IDs reconcile an unbound hold as a fake zero charge',async()=> {
    const job=await legacy();
    for(const name of ['worker_reconcile_run','worker_reconcile_run_billing_only']) for(const run of [null,'',' '])
      await rejected(()=>f.rpc(name,[job.id,run,actor,'fixture','SUCCEEDED','dataset',0]),'run_identity_mismatch');
    expect(await row(job.id)).toMatchObject({status:'uncertain',actual_cost_usd:null,billing_reconciled_at:null,reserved_usd:.907554});
  });
});

describe('bounded read-only missing-run recovery',()=> {
  it('claims at most two jobs, keeps leases/cursors bounded, and never infers no-start from exhaustion',async()=> {
    const jobs=[await legacy(.1,1),await legacy(.1,2),await legacy(.1,3)];
    await rejected(()=>f.rpc('worker_claim_missing_run_recovery',[fixtureOwner,null,3]),'invalid_missing_run_scope');
    const claims=await f.rpc<{job:Job;recovery_token:string;pages_remaining:number}[]>('worker_claim_missing_run_recovery',[fixtureOwner]);
    expect(claims).toHaveLength(2); expect(claims[0].pages_remaining).toBe(8);
    expect(await f.rpc('worker_complete_missing_run_recovery',[fixtureOwner,claims[0].job.id,claims[0].recovery_token,'no_match','cursor-1',1])).toEqual({recorded:true,exhausted:false});
    expect(await f.rpc('worker_complete_missing_run_recovery',[fixtureOwner,claims[0].job.id,claims[0].recovery_token,'no_match',null,1])).toEqual({recorded:false,reason:'recovery_lease_lost'});
    expect(await row(claims[0].job.id)).toMatchObject({status:'uncertain',reserved_usd:.1,actual_cost_usd:null,missing_run_recovery_cursor:'cursor-1',missing_run_recovery_reason:'no_match_not_no_start'});
    await f.identity(); await f.db.query('update public.scrape_jobs set missing_run_recovery_next_at=now()-interval \'1 second\' where id=$1',[claims[0].job.id]); await f.identity('service_role');
    const again=(await f.rpc<{job:Job;recovery_token:string;cursor:string}[]>('worker_claim_missing_run_recovery',[fixtureOwner,claims[0].job.id,1]))[0];
    expect(again.cursor).toBe('cursor-1');
    await rejected(()=>f.rpc('worker_complete_missing_run_recovery',[fixtureOwner,again.job.id,again.recovery_token,'no_match','cursor-2',8]),'missing_run_page_budget_exceeded');
    await f.rpc('worker_complete_missing_run_recovery',[fixtureOwner,again.job.id,again.recovery_token,'exhausted',null,7]);
    expect(await row(again.job.id)).toMatchObject({status:'uncertain',actual_cost_usd:null,billing_reconciled_at:null,missing_run_recovery_pages:8,missing_run_recovery_exhausted:true,missing_run_recovery_reason:'lookup_exhausted_not_no_start'});
    expect(await f.rpc('worker_claim_missing_run_recovery',[fixtureOwner,again.job.id,1])).toEqual([]);
    expect(jobs).toHaveLength(3);
  });
  it('marks a lost last recovery lease exhausted and reopens exact accepted journal reads only',async()=> {
    const job=await legacy(.1);
    await f.identity(); await f.db.query('update public.scrape_jobs set missing_run_recovery_attempts=7 where id=$1',[job.id]); await f.identity('service_role');
    await f.rpc('worker_claim_missing_run_recovery',[fixtureOwner,job.id,1]);
    await f.identity(); await f.db.query("update public.scrape_jobs set missing_run_recovery_expires_at=now()-interval '1 second' where id=$1",[job.id]); await f.identity('service_role');
    expect(await f.rpc('worker_claim_missing_run_recovery',[fixtureOwner,job.id,1])).toEqual([]);
    expect(await row(job.id)).toMatchObject({missing_run_recovery_exhausted:true,actual_cost_usd:null});
    await f.rpc('worker_record_accepted_evidence',[fixtureOwner,job.id,job.dispatch_nonce,'late-journal','start_response',false]);
    const reopened=await f.rpc<{recovery_token:string;pages_remaining:number;accepted_evidence:{run_id:string}[]}[]>('worker_claim_missing_run_recovery',[fixtureOwner,job.id,1]);
    expect(reopened).toHaveLength(1); expect(reopened[0].accepted_evidence[0].run_id).toBe('late-journal');
    await f.rpc('worker_record_accepted_evidence',[fixtureOwner,job.id,job.dispatch_nonce,'late-journal','provider_recovery',true]);
    await f.rpc('worker_complete_missing_run_recovery',[fixtureOwner,job.id,reopened[0].recovery_token,'matched',null,0]);
    expect(await row(job.id)).toMatchObject({missing_run_recovery_attempts:8,actual_cost_usd:null});
  });
  it('requires verified match evidence and no new provider starts',async()=> {
    const job=await legacy(.1);
    const claims=await f.rpc<{recovery_token:string}[]>('worker_claim_missing_run_recovery',[fixtureOwner,job.id,1]);
    await rejected(()=>f.rpc('worker_complete_missing_run_recovery',[fixtureOwner,job.id,claims[0].recovery_token,'matched',null,0]),'missing_run_match_unverified');
    await f.rpc('worker_record_accepted_evidence',[fixtureOwner,job.id,job.dispatch_nonce,'recovered-run','provider_recovery',true]);
    expect(await f.rpc('worker_complete_missing_run_recovery',[fixtureOwner,job.id,claims[0].recovery_token,'matched',null,0])).toEqual({recorded:true,exhausted:false});
    expect(await row(job.id)).toMatchObject({actual_cost_usd:null,attempt_count:1,dispatch_phase:'accepted_save_pending'});
  });
});

describe('audited operator risk release and safe owner reads',()=> {
  it('removes only operational reservation/capacity; preserves every billing pin and immutable unknown exposure',async()=> {
    const job=await legacy(); const before=await row(job.id);
    const result=await settle(job);
    expect(result).toMatchObject({id:job.id,status:'uncertain',operational_disposition:'risk_released',reserved_usd:0,actual_cost_usd:null,audit:[{outcome:'risk_release',released_usd:.907554}]});
    const after=await row(job.id);
    for(const key of ['dispatch_nonce','started_at','expected_actor_id','expected_provider_user_id','apify_account_slot','live','billing_month','actual_cost_usd','billing_reconciled_at','dispatch_phase']) expect(after[key]).toEqual(before[key]);
    expect(after.collection_source).toBe('operator_settle');
    expect(await f.rpc('get_collection_holds',[1,20])).toMatchObject({total:1,capacity:{occupied_slots:0,uncertain_slots:0,max_active:2,paid_starts_gated:true},usage:{reconciled_month_spend_usd:0,risk_released_exposure_usd:.907554}});
    const reads=JSON.stringify(await f.rpc('get_collection_job_recovery',[job.id]));
    expect(reads).not.toMatch(/dispatch_nonce|input_digest|expected_provider_user_id|executor_nonce|original_snapshot/);
    expect(await settle(job)).toEqual(result);
    await rejected(()=>settle(job,'conflict-key'),'collection_settlement_idempotency_conflict');
    await f.identity();
    await rejected(()=>f.db.query("update public.scrape_jobs set dispatch_nonce=gen_random_uuid() where id=$1",[job.id]),'immutable_released_collection_identity');
    await rejected(()=>f.db.query('update public.scrape_jobs set actual_cost_usd=0,billing_reconciled_at=now() where id=$1',[job.id]),'immutable_released_collection_identity');
    await rejected(()=>f.db.query("update collection_intents_private.release_audit set released_usd=0 where job_id=$1",[job.id]),'immutable_collection_release_audit');
    await f.identity('service_role');
    expect(await f.rpc('worker_collection_runtime',[fixtureOwner])).toMatchObject({wake_revision:0});
    await f.rpc('worker_set_collection_start_gate',[fixtureOwner,false]);
    expect((await claim()).apify_account_slot).toBe(1);
  });
  it('requires the global no-paid gate and refuses settlement during an active exact reconciliation lease',async()=> {
    const job=await legacy();
    await f.identity('authenticated');
    await rejected(()=>f.rpc('collection_settle_job',[job.id,'risk_release','Decision','owner_ui_explicit_decision','guard-test',job.recovery_version,true]),'paid_starts_gate_required');
    await f.identity('service_role'); await f.rpc('worker_set_collection_start_gate',[fixtureOwner,true]);
    const recovery=(await f.rpc<{job:Job;recovery_token:string}[]>('worker_claim_missing_run_recovery',[fixtureOwner,job.id,1]))[0];
    await f.identity('authenticated'); await rejected(()=>f.rpc('collection_settle_job',[job.id,'risk_release','Decision','owner_ui_explicit_decision','guard-test',recovery.job.recovery_version,true]),'collection_recovery_in_flight');
  });
  it('authenticates owner/workspace, pages deterministically, rejects fake no-start flags and stale CAS',async()=> {
    const job=await legacy(); await legacy(.1,2);
    await f.identity('authenticated');
    const holds=await f.rpc<{items:{id:string}[];total:number}>('get_collection_holds',[1,1]);
    expect(holds.total).toBe(2); expect(holds.items).toHaveLength(1);
    expect((await f.rpc<{items:{id:string}[]}>('get_collection_holds',[2,1])).items[0].id).not.toBe(holds.items[0].id);
    await rejected(()=>f.rpc('collection_settle_job',[job.id,'no_start','Browser asserted proof','untrusted','fake',job.recovery_version,true]),'unknown_liability_acknowledgement_required');
    await rejected(()=>f.rpc('collection_settle_job',[job.id,'risk_release','Unacknowledged','untrusted','fake',job.recovery_version,false]),'unknown_liability_acknowledgement_required');
    await rejected(()=>f.rpc('collection_settle_job',[job.id,'risk_release','Stale','untrusted','fake',job.recovery_version+1,true]),'collection_state_changed');
    await f.identity('authenticated',fixtureStranger);
    await rejected(()=>f.rpc('get_collection_job_recovery',[job.id]),'forbidden');
    await rejected(()=>f.rpc('get_collection_holds'),'forbidden');
    await rejected(()=>f.rpc('worker_set_collection_start_gate',[fixtureOwner,true]),'permission denied');
    await f.identity('anon'); await rejected(()=>f.rpc('get_collection_holds'),'permission denied');
  });
  it('batch releases original-style three jobs atomically under gate, rejects a bad manifest, and replays exactly',async()=> {
    const jobs=[await legacy(.907554,1),await legacy(24.546223,2),await legacy(24.546223,3)];
    const expected=jobs.map(j=>({job_id:j.id,expected_version:j.recovery_version,dispatch_nonce:j.dispatch_nonce,started_at:j.started_at}));
    const release=(manifest=expected)=>f.rpc<{items:unknown[];replayed:boolean}>('worker_risk_release_collection_jobs',[fixtureOwner,jobs.map(j=>j.id),'original-three-test','Audited unknown liability decision','local-test-audit',JSON.stringify(manifest)]);
    await rejected(()=>release(),'paid_starts_gate_required');
    await f.rpc('worker_set_collection_start_gate',[fixtureOwner,true]);
    await rejected(()=>release(expected.map((e,index)=>index===1?{...e,expected_version:99}:e)),'collection_state_changed');
    for(const job of jobs) expect(await row(job.id)).toMatchObject({operational_disposition:'protected',reserved_usd:job.reserved_usd,actual_cost_usd:null});
    expect(await release()).toMatchObject({replayed:false});
    expect(await release()).toMatchObject({replayed:true});
    await f.identity('authenticated');
    expect(await f.rpc('get_collection_holds')).toMatchObject({capacity:{occupied_slots:0,uncertain_slots:0,paid_starts_gated:true},usage:{risk_released_exposure_usd:50}});
    expect(await f.rpc('get_bootstrap')).toMatchObject({settings:{collection_job_cap_usd:.1},collection_capacity:{occupied_slots:0,paid_starts_gated:true},usage:{actual_month_spend:null,risk_released_exposure_usd:50}});
  });
  it('closes a linked metrics workflow as outcome_unknown without retry or losing its job/targets',async()=> {
    await f.identity();
    const rid=await f.reel(false,f.creator,'2026-01-01T00:00:00Z',false); await f.identity();
    const workflow=await f.value<string>("insert into public.competitor_refresh_runs(owner_user_id,creator_id,kind,slot,status,attempt_count,expected_reels) values($1,$2,'metrics',now(),'blocked',1,1) returning id v",[fixtureOwner,f.creator]);
    await f.db.query('insert into public.competitor_refresh_targets(run_id,reel_id,shortcode) select $1,id,shortcode from public.reels where id=$2',[workflow,rid]);
    const id=await f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,results_limit,requested_profiles_count,competitor_run_id,workflow_attempt)
      values($1,'metrics',10000,1,$2,1) returning id v`,[fixtureOwner,workflow]);
    await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)',[id,f.creator]);
    await f.value<Job>(`update public.scrape_jobs set status='dispatching',live=true,reserved_usd=.1,expected_actor_id=$2,expected_provider_user_id='fixture',
      apify_account_slot=1,attempt_count=1,dispatch_nonce=gen_random_uuid(),started_at=now() where id=$1 returning to_jsonb(scrape_jobs) v`,[id,actor]);
    const job=await f.value<Job>("update public.scrape_jobs set status='uncertain' where id=$1 returning to_jsonb(scrape_jobs) v",[id]);
    await f.db.query('update public.competitor_refresh_runs set last_job_id=$2 where id=$1',[workflow,job.id]);
    await settle(job);
    await f.identity('service_role'); expect(await f.rpc('worker_competitor_maintain',[fixtureOwner])).toEqual({job_ids:[]});
    expect(await f.value('select jsonb_build_object(\'status\',status,\'last_job_id\',last_job_id,\'attempt_count\',attempt_count) v from public.competitor_refresh_runs where id=$1',[workflow])).toEqual({status:'outcome_unknown',last_job_id:job.id,attempt_count:1});
    expect((await row(job.id)).competitor_run_id).toBe(workflow);
  });
  it('late same-nonce verified receipts rediscover a real run and restore operational blocking, not guessed billing',async()=> {
    const job=await legacy(); await settle(job); await f.identity('service_role');
    expect(await f.rpc('worker_record_callback_receipt',[fixtureOwner,job.id,job.dispatch_nonce,'late-real-run',actor,'fixture'])).toEqual({accepted:true});
    await f.rpc('worker_record_accepted_evidence',[fixtureOwner,job.id,job.dispatch_nonce,'late-real-run','callback',true]);
    await f.rpc('worker_attach_run',[job.id,job.dispatch_nonce,'late-real-run',actor,'fixture','dataset']);
    expect(await row(job.id)).toMatchObject({status:'running',actor_run_id:'late-real-run',operational_disposition:'risk_released',actual_cost_usd:null,reserved_usd:0});
    await f.identity('authenticated'); expect(await f.rpc('get_collection_holds')).toMatchObject({capacity:{occupied_slots:1},usage:{risk_released_exposure_usd:.907554}});
    await f.identity('service_role'); await f.rpc('worker_reconcile_run_billing_only',[job.id,'late-real-run',actor,'fixture','SUCCEEDED','dataset',.03]);
    await f.identity('authenticated'); expect(await f.rpc('get_collection_holds')).toMatchObject({usage:{reconciled_month_spend_usd:.03,risk_released_exposure_usd:0}});
    expect((await f.rpc<{audit:{released_usd:number}[]}>('get_collection_job_recovery',[job.id])).audit[0].released_usd).toBe(.907554);
  });
});

describe('isolated authoritative billing reconciliation',()=> {
  it('keeps status/data and both completion wake revisions unchanged while recording authoritative charges',async()=> {
    const job=await claim(); await authorize(job);
    await f.rpc('worker_attach_run',[job.id,job.dispatch_nonce,'billing-run',actor,'fixture','dataset']);
    await f.rpc('worker_reconcile_run',[job.id,'billing-run',actor,'fixture','SUCCEEDED','dataset',null]);
    await f.identity(); await f.db.query("update public.scrape_jobs set status='succeeded',completed_at=now() where id=$1",[job.id]); await f.identity('service_role');
    const before=await f.rpc<{wake_revision:number}>('worker_collection_runtime',[fixtureOwner]);
    const claims=await f.rpc<{job:Job;reconciliation_token:string;callback_hint:null}[]>('worker_claim_billing_reconciliation',[fixtureOwner,job.id,1]);
    expect(claims).toHaveLength(1); expect(claims[0].callback_hint).toBeNull();
    await rejected(()=>f.rpc('worker_reconcile_run_billing_only',[job.id,'billing-run',actor,'fixture','SUCCEEDED','ignored-dataset',.02]),'run_identity_mismatch');
    expect(await f.rpc('worker_reconcile_run_billing_only',[job.id,'billing-run',actor,'fixture','SUCCEEDED','dataset',.02])).toMatchObject({status:'succeeded',dataset_id:'dataset',actual_cost_usd:.02,reserved_usd:0});
    expect((await f.rpc<{wake_revision:number}>('worker_collection_runtime',[fixtureOwner])).wake_revision).toBe(before.wake_revision);
    expect(await f.rpc('worker_reconcile_run_billing_only',[job.id,'billing-run',actor,'fixture','SUCCEEDED','dataset',.03])).toMatchObject({actual_cost_usd:.03,billing_review_required:false});
    expect(await f.rpc('worker_reconcile_run_billing_only',[job.id,'billing-run',actor,'fixture','SUCCEEDED','dataset',.02])).toMatchObject({actual_cost_usd:.03,billing_review_required:true});
    await f.rpc('worker_complete_reconciliation',[fixtureOwner,job.id,claims[0].reconciliation_token,null,'pending']);
    expect(await f.rpc('worker_claim_billing_reconciliation',[fixtureOwner,job.id,1])).toHaveLength(1);
    await f.identity(); expect(await f.value('select count(*)::int v from collection_intents_private.billing_mode')).toBe(0);
  });
});

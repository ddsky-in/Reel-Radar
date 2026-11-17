import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApifyAccount, ApifyAccountSlot, Context, Job } from '../supabase/functions/_shared/model.ts';
vi.stubGlobal('Deno',{env:{get:()=>undefined},serve:vi.fn()});
const worker=await import('../supabase/functions/_shared/worker.ts' as string);
const webhook=await import('../supabase/functions/apify-webhook/index.ts' as string);
const reconcile=await import('../supabase/functions/reconcile-jobs/index.ts' as string);
const refresh=await import('../supabase/functions/refresh-dispatch/index.ts' as string);
const owner='11111111-1111-4111-8111-111111111111',creator='22222222-2222-4222-8222-222222222222',nonce='33333333-3333-4333-8333-333333333333';
const now='2026-11-15T12:00:00Z';
let env:Record<string,string>,accounts:ApifyAccount[],queue:Job[],selected:Job,max:number;
let calls:{name:string;args:Record<string,unknown>}[],reads:{slot:number;path:string;method:string}[],unexpected:string[];
let startFailure:boolean,pageFailure:boolean,complete:boolean,dirty:boolean,runCost:number|null,drainFailure:boolean;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
const args=(name:string)=>calls.filter(call=>call.name===name).map(call=>call.args);
const starts=()=>reads.filter(read=>read.method==='POST');
const context=(job:Job):Context=>({job:structuredClone(job),creators:[{id:creator,username:'fixture'}]});
function job(slot:ApifyAccountSlot,patch:Partial<Job>={}):Job {
  return {id:`44444444-4444-4444-8444-00000000000${slot}`,owner_user_id:owner,kind:'daily',live:true,status:'dispatching',collection_source:'ordinary',
    apify_account_slot:slot,expected_actor_id:'reel-actor',expected_provider_user_id:`account-${slot}`,dispatch_nonce:nonce,
    reserved_usd:.1,results_limit:30,actor_run_id:`run-${slot}`,dataset_id:`dataset-${slot}`,dataset_cursor:0,dataset_finished:false,
    lease_token:nonce,started_at:now,provider_terminal_status:null,actual_cost_usd:null,...patch};
}
const internal=(input:unknown)=>new Request('https://fixture.test/reconcile-jobs',{method:'POST',headers:{'content-type':'application/json','x-internal-secret':'synthetic-internal'},body:JSON.stringify(input)});
const callback=()=>new Request(`https://fixture.test/apify-webhook?job_id=${selected.id}&dispatch_nonce=${nonce}`,{method:'POST',headers:{'content-type':'application/json','x-webhook-secret':'synthetic-webhook'},body:JSON.stringify({run_id:selected.actor_run_id})});
beforeEach(()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(now));
  env={PROVIDER_MODE:'apify',APIFY_ACCOUNT_ID:'account-1',APIFY_REEL_ACTOR_RESOURCE_ID:'reel-actor',APIFY_PROFILE_ACTOR_RESOURCE_ID:'profile-actor',
    SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',REELRADAR_OWNER_USER_ID:owner,
    APIFY_WEBHOOK_SHARED_SECRET:'synthetic-webhook',INTERNAL_CRON_SECRET:'synthetic-internal',SCRAPING_ENABLED:'true',PROVIDER_VALIDATED:'true',
    RUN_CHARGE_CAP_VALIDATED:'true',ACCOUNT_USAGE_VALIDATED:'true',PROFILE_PROVIDER_VALIDATED:'true',CAROUSEL_PROVIDER_VALIDATED:'true'};
  for(let slot=1;slot<=5;slot++) env[slot===1?'APIFY_API_TOKEN':`APIFY_API_TOKEN_${slot}`]=`synthetic-token-${slot}`;
  accounts=[1,2,3,4,5].map(slot=>({owner_user_id:owner,account_slot:slot as ApifyAccountSlot,provider_user_id:`account-${slot}`,enabled:true,authorization_confirmed:true,
    usage_cycle_start_at:'2026-11-01T00:00:00Z',usage_cycle_end_at:'2026-12-01T00:00:00Z',usage_usd:0,limit_usd:5,usage_reconciled_at:now}));
  selected=job(1);queue=[];max=3;calls=[];reads=[];unexpected=[];startFailure=false;pageFailure=false;complete=false;dirty=false;runCost=.01;drainFailure=false;
  vi.stubGlobal('Deno',{env:{get:(key:string)=>env[key]},serve:vi.fn()});
  vi.spyOn(console,'info').mockImplementation(()=>undefined);
  vi.stubGlobal('fetch',vi.fn<typeof fetch>().mockImplementation(async(input,init)=>{
    const url=new URL(String(input)),headers=new Headers(init?.headers);
    if(url.origin==='https://fixture.supabase.co'){
      expect(headers.get('authorization')).toBe('Bearer synthetic-service');
      expect(headers.get('apikey')).toBe('synthetic-service');
      if(url.pathname==='/rest/v1/scrape_jobs'){
        expect(url.searchParams.get('owner_user_id')).toBe(`eq.${owner}`);
        expect(url.searchParams.get('id')).toBe(`eq.${selected.id}`);expect(url.searchParams.has('kind')).toBe(false);
        return json([selected]);
      }
      const name=url.pathname.split('/').at(-1)!,inputArgs=JSON.parse(String(init?.body));calls.push({name,args:inputArgs});
      if(name==='worker_accounts')return json(accounts);
      const runtime=()=>({max_active:max,max_starts_per_wake:max,wake_revision:dirty?1:0,drained_revision:0,wake_pending:dirty,
        eligible_kinds:['daily','weekly','profile','carousel','discovery','metrics','retry','manual','backfill'],
        executor_nonce:null,executor_revision:null,executor_expires_at:null,executor_starts:0,executor_start_limit:max,wake_retry_after:null});
      if(name==='worker_collection_runtime')return json(runtime());
      if(name==='worker_claim_collection_executor')return json({...runtime(),executor_nonce:nonce,executor_revision:dirty?1:0,
        executor_expires_at:'2026-11-15T12:01:30Z',claimed_revision:dirty?1:0,starts_remaining:max});
      if(name==='worker_begin_account_usage')return json({observation_id:creator,observed_at:now});
      if(['worker_renew_collection_executor','worker_release_collection_executor'].includes(name))return json(true);
      if(name==='worker_claim_next'){
        expect(inputArgs.p_owner_user_id).toBe(owner);expect(inputArgs.p_executor_nonce).toBe(nonce);expect(inputArgs.p_claimed_revision).toBe(dirty?1:0);
        const value=queue.shift();
        if(value){expect(inputArgs.p_actor_ids).toMatchObject({daily:'reel-actor'});expect(inputArgs.p_eligible_kinds).toContain(value.kind);}
        return json(value?{...context(value),max_total_charge_usd:.1}:{reason:'no_pending_jobs'});
      }
      if(name==='worker_claim_reconciliation')return json([{job:structuredClone(selected),callback_hint:{run_id:selected.actor_run_id,dispatch_nonce:nonce},reconciliation_token:nonce}]);
      if(name==='worker_record_callback_receipt')return json({accepted:true});
      if(name==='worker_reconcile_run')return json({...selected,status:complete?'succeeded':'processing',provider_terminal_status:'SUCCEEDED',actual_cost_usd:runCost});
      if(name==='worker_claim_processing')return json(context(selected));
      if(name==='worker_finish_processing'){complete=true;dirty=selected.collection_source==='ordinary';return json(null);}
      if(name==='worker_record_completion_wake')return json(dirty&&selected.collection_source==='ordinary');
      if(name==='worker_transcription_media_reconcile')return json({status:selected.collection_source==='target_media'?'completed':'not_linked'});
      if(name==='worker_isolate_collection_settlement'){selected.collection_source='operator_settle';return json(null);}
      if(name==='worker_drain_completion_wake'){
        expect(inputArgs).toEqual({p_owner_user_id:owner,p_executor_nonce:nonce,p_revision:dirty?1:0});
        if(drainFailure) return json(null,503);dirty=false;return json(true);
      }
      if(name==='worker_configure_collection_throughput')return json({max_active:inputArgs.p_max_active,max_starts_per_wake:inputArgs.p_max_starts_per_wake});
      if(name==='worker_invalidate_account_usage'){accounts[Number(inputArgs.p_account_slot)-1].usage_reconciled_at=null;return json(null);}
      if(name==='worker_get_collection_recovery_state')return json({input_digest:null,accepted_evidence:[],callback_hints:[]});
      if(name==='worker_record_accepted_evidence')return json({recorded:true});
      if(name==='worker_authorize_collection_submit')return json({authorized:true});
      if(name==='worker_cancel_pre_submit')return json({cancelled:true});
      if(name==='worker_claim_missing_run_recovery')return json([]);
      if(['worker_record_usage','worker_record_account_usage','worker_attach_run','worker_dispatch_failure','worker_ingest_page','worker_record_output_summary',
        'worker_release_processing','worker_complete_reconciliation','worker_expire_dispatches','worker_competitor_maintain','worker_carousel_maintain'].includes(name))return json(null);
      unexpected.push(`RPC ${name}`);throw new Error('Unexpected fake RPC');
    }
    if(url.origin==='https://api.apify.com'){
      const slot=Number(headers.get('authorization')?.match(/^Bearer synthetic-token-(\d)$/)?.[1]);
      if(!slot){unexpected.push('Unknown credential');throw new Error('Unknown synthetic credential');}
      reads.push({slot,path:url.pathname,method:init?.method??'GET'});
      if(url.pathname==='/v2/users/me')return json({data:{id:`account-${slot}`}});
      if(url.pathname==='/v2/users/me/limits')return json({data:{monthlyUsageCycle:{startAt:'2026-11-01T00:00:00Z',endAt:'2026-12-01T00:00:00Z'},current:{monthlyUsageUsd:.02},limits:{maxMonthlyUsageUsd:5}}});
      const actor=/^\/v2\/actors\/([^/]+)\/runs$/.exec(url.pathname)?.[1];
      if(actor&&init?.method==='POST'){
        if(startFailure) return json({error:'synthetic acceptance failure'},503);
        expect(url.searchParams.get('maxTotalChargeUsd')).toBe('0.1');
        return json({data:{id:`run-${slot}`,actId:actor,userId:`account-${slot}`,status:'RUNNING',defaultDatasetId:`dataset-${slot}`}});
      }
      if(url.pathname===`/v2/actor-runs/run-${slot}`)return json({data:{id:`run-${slot}`,actId:selected.expected_actor_id,userId:`account-${slot}`,status:'SUCCEEDED',
        defaultDatasetId:`dataset-${slot}`,defaultKeyValueStoreId:`store-${slot}`,usageTotalUsd:runCost}});
      if(url.pathname===`/v2/datasets/dataset-${slot}/items`){
        if(pageFailure)return json({error:'synthetic schema failure'});
        return json([{ownerUsername:'fixture',error:'no_items'}]);
      }
      if(url.pathname===`/v2/key-value-stores/store-${slot}/records/OUTPUT`)return json({ok:true,total_items:1,users:[{user:'fixture',count:1}]});
      unexpected.push(`Provider ${url.pathname}`);throw new Error('Unexpected fake provider request');
    }
    unexpected.push(`Origin ${url.origin}`);throw new Error('Unintercepted origin forbidden');
  }));
});
afterEach(()=>{expect(unexpected).toEqual([]);vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});

describe('bounded collection sessions and fair RPC dispatch',()=>{
  it.each([3,4])('starts max%s distinct pinned jobs without client-side candidate queries',async active=>{
    max=active;queue=[1,2,3,4,5].map(slot=>job(slot as ApifyAccountSlot,{actor_run_id:null}));
    const outcomes=await worker.dispatch(owner);
    expect(outcomes).toHaveLength(active);expect(starts().map(read=>read.slot)).toEqual(Array.from({length:active},(_,i)=>i+1));
    expect(args('worker_accounts')).toHaveLength(1);expect(args('worker_claim_next')).toHaveLength(active);
    expect(args('worker_record_usage')).toHaveLength(0);expect(args('worker_record_account_usage')).toHaveLength(0);
    expect(reads.filter(read=>read.path==='/v2/users/me')).toHaveLength(active);
  });
  it('one non-idempotent POST503 leaves uncertainty, no repetition or fallback starts',async()=>{
    queue=[job(2,{actor_run_id:null}),job(3,{actor_run_id:null})];startFailure=true;
    expect(await worker.dispatch(owner)).toContainEqual({job_id:'44444444-4444-4444-8444-000000000002',status:'uncertain'});
    expect(starts()).toHaveLength(1);expect(args('worker_claim_next')).toHaveLength(1);expect(args('worker_dispatch_failure')).toHaveLength(1);
  });
  it('does not drain durable wake if executor DB response fails',async()=>{
    dirty=true;drainFailure=true;
    await expect(worker.dispatch(owner)).rejects.toThrow('worker_drain_completion_wake');expect(dirty).toBe(true);
  });
  it('denied executor renewal prevents a paid start and keeps its exact reservation uncertain for durable recovery',async()=>{
    const reservedJob=job(2,{actor_run_id:null});dirty=true;queue=[reservedJob];
    const fetcher=vi.mocked(fetch),original=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(input,init)=>String(input).endsWith('/worker_authorize_collection_submit')
      ?json({authorized:false}):original(input,init));
    expect(await worker.dispatch(owner)).toContainEqual({job_id:'44444444-4444-4444-8444-000000000002',status:'cancelled'});
    expect(starts()).toHaveLength(0);expect(args('worker_attach_run')).toHaveLength(0);expect(args('worker_claim_next')).toHaveLength(1);
    expect(args('worker_dispatch_failure')).toEqual([]);expect(args('worker_cancel_pre_submit')).toHaveLength(1);
    expect(args('worker_drain_completion_wake')).toHaveLength(0);
    expect(args('worker_release_collection_executor')).toEqual([{p_owner_user_id:owner,p_executor_nonce:nonce,p_revision:1}]);
    expect(dirty).toBe(true);expect(reservedJob.reserved_usd).toBe(.1);expect(reservedJob.actual_cost_usd).toBeNull();
  });
  it.each(['executor_busy','wake_not_pending','wake_retry_deferred','wake_start_limit'])('%s performs no usage/provider/claim/drain work',async reason=>{
    const fetcher=vi.mocked(fetch),original=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(input,init)=>String(input).endsWith('/worker_claim_collection_executor')
      ?json({reason}):original(input,init));
    expect(await worker.dispatch(owner)).toEqual([{reason}]);expect(reads).toEqual([]);
    expect(args('worker_accounts')).toEqual([]);expect(args('worker_claim_next')).toEqual([]);expect(args('worker_drain_completion_wake')).toEqual([]);
  });
  it('one registry and one run read feed verification, processing and OUTPUT',async()=>{
    const session=new worker.CollectionSession(owner);
    await worker.verifyRun(selected,session);await worker.processJob(selected.id,session);
    expect(args('worker_accounts')).toHaveLength(1);expect(reads.filter(read=>read.path==='/v2/users/me')).toHaveLength(1);
    expect(reads.filter(read=>read.path.includes('/actor-runs/'))).toHaveLength(1);
    expect(reads.some(read=>read.path.endsWith('/OUTPUT'))).toBe(true);
    await expect(session.adapter({...selected,owner_user_id:creator})).rejects.toThrow('owner mismatch');
    expect(()=>session.run({...selected,actor_run_id:'foreign-run'})).toThrow('run identity');
  });
  it('usage refresh is bounded3 concurrent accounts and reuses once per invocation only',async()=>{
    accounts.forEach(account=>{account.usage_reconciled_at='2026-11-15T11:58:00Z';});
    let concurrent=0,peak=0;
    const fetcher=vi.mocked(fetch),original=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(input,init)=>{
      if(String(input).endsWith('/users/me')){
        concurrent++;peak=Math.max(peak,concurrent);await new Promise(resolve=>setTimeout(resolve,5));
        try{return await original(input,init);}finally{concurrent--;}
      }
      return original(input,init);
    });
    const session=new worker.CollectionSession(owner);
    await Promise.all([session.reconcileUsage(),session.reconcileUsage()]);
    expect(peak).toBe(3);expect(args('worker_accounts')).toHaveLength(1);
    expect(reads.filter(read=>read.path==='/v2/users/me/limits')).toHaveLength(5);
    expect(args('worker_record_account_usage')).toHaveLength(4);expect(args('worker_record_usage')).toHaveLength(1);
  });
  it('unknown identity invalidates enabled account and never claims from fallback',async()=>{
    accounts[0].usage_reconciled_at='2026-11-15T11:58:00Z';
    const fetcher=vi.mocked(fetch),original=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(input,init)=>String(input).endsWith('/v2/users/me')&&new Headers(init?.headers).get('authorization')==='Bearer synthetic-token-1'
      ?json({data:{id:'foreign-account'}}):original(input,init));
    queue=[job(2)];await expect(worker.dispatch(owner)).rejects.toThrow('Authoritative account usage');
    expect(args('worker_invalidate_account_usage')).toEqual([{p_owner_user_id:owner,p_account_slot:1,p_observation_id:creator}]);
    expect(args('worker_claim_next')).toHaveLength(0);expect(starts()).toHaveLength(0);
  });
  it('sanitized timing logs contain counts only, never owner/tokens/provider payloads',async()=>{
    await worker.dispatch(owner);const logged=JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(logged).toContain('duration_ms');expect(logged).not.toContain(owner);expect(logged).not.toContain('synthetic-token');expect(logged).not.toContain('synthetic-service');
  });
});
describe('ordinary continuation permission and isolated settlements',()=>{
  it('ordinary callback completion drains durable wake and starts next work immediately',async()=>{
    queue=[job(2,{actor_run_id:null})];
    const response=await webhook.handler(callback());expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({processing:'finished',next:expect.arrayContaining([{job_id:'44444444-4444-4444-8444-000000000002',status:'running'}])});
    expect(args('worker_record_completion_wake')).toHaveLength(1);expect(args('worker_accounts')).toHaveLength(1);
    expect(reads.filter(read=>read.path.includes('/actor-runs/'))).toHaveLength(1);
  });
  it('a later ordinary retry finishes processing and starts backlog without using operator-settle mode',async()=>{
    pageFailure=true;const failed=await webhook.handler(callback());expect(await failed.json()).toMatchObject({processing:'processing_retry_required',next:'not_dispatched'});
    expect(starts()).toHaveLength(0);pageFailure=false;queue=[job(3,{actor_run_id:null})];
    const retry=await reconcile.handler(internal({ordinary_callback_job_id:selected.id,continuation_budget:0}));expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({outcomes:[{state:'finished'}],next:expect.arrayContaining([expect.objectContaining({status:'running'})])});
    expect(args('worker_isolate_collection_settlement')).toHaveLength(0);expect(starts()).toHaveLength(1);
  });
  it('retry continuation explicitly carries ordinary mode rather than operator settlement',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date(now));pageFailure=true;
    const waiting:Promise<unknown>[]=[],payloads:Record<string,unknown>[]=[];
    vi.stubGlobal('EdgeRuntime',{waitUntil:(work:Promise<unknown>)=>{waiting.push(work);}});
    const fetcher=vi.mocked(fetch),original=fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async(input,init)=>{
      if(String(input)==='https://fixture.supabase.co/functions/v1/reconcile-jobs'){
        expect(new Headers(init?.headers).get('x-internal-secret')).toBe('synthetic-internal');
        payloads.push(JSON.parse(String(init?.body)));return json({accepted:true},202);
      }
      return original(input,init);
    });
    const response=await webhook.handler(callback());expect(response.status).toBe(202);
    await waiting[0];await vi.advanceTimersByTimeAsync(3000);await Promise.all(waiting);
    expect(payloads).toEqual([{continuation_budget:3,ordinary_callback_job_id:selected.id}]);
    expect(args('worker_drain_completion_wake')).toHaveLength(0);expect(starts()).toHaveLength(0);
  });
  it.each(['carousel_pilot','target_media','operator_settle','legacy'] as const)('%s callback does not wake ordinary dispatcher even with pilot env removed',async source=>{
    selected=job(1,{collection_source:source,...source==='carousel_pilot'?{kind:'carousel'}:{}});complete=true;queue=[job(2)];
    const response=await webhook.handler(callback());expect(response.status).toBe(200);
    expect(starts()).toHaveLength(0);expect(args('worker_record_completion_wake')).toHaveLength(0);expect(args('worker_claim_collection_executor')).toHaveLength(0);
  });
  it('explicit operator settlement stamps before work and cannot dispatch ordinary backlog',async()=>{
    complete=true;queue=[job(2)];
    const response=await reconcile.handler(internal({settle_job_id:selected.id,continuation_budget:0}));
    expect(await response.json()).toMatchObject({next:'settlement_only'});
    expect(calls[0].name).toBe('worker_isolate_collection_settlement');expect(args('worker_claim_next')).toHaveLength(0);expect(starts()).toHaveLength(0);
  });
  it('unknown-cost completion can start a verified alternate without releasing its hold',async()=>{
    runCost=null;queue=[job(2)];const response=await webhook.handler(callback());expect(response.status).toBe(200);
    expect(starts().map(read=>read.slot)).toEqual([2]);
    expect(args('worker_record_completion_wake')).toHaveLength(1);
    expect(selected.actual_cost_usd).toBeNull();expect(selected.reserved_usd).toBe(.1);
  });
  it('service throughput configuration only changes controls; no account/provider/start/cron work',async()=>{
    const response=await refresh.handler(internal({action:'configure_collection_throughput',max_active:3,max_starts_per_wake:3}));
    expect(await response.json()).toEqual({throughput:{max_active:3,max_starts_per_wake:3}});
    expect(reads).toEqual([]);expect(calls.map(call=>call.name)).toEqual(['worker_configure_collection_throughput']);
    expect((await refresh.handler(internal({action:'configure_collection_throughput',max_active:5,max_starts_per_wake:4}))).status).toBe(400);
  });
});

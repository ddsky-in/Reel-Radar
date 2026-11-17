import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';
let f:Awaited<ReturnType<typeof featureDatabase>>,id:string;
beforeAll(async()=>{f=await featureDatabase();},60000);
afterAll(async()=>{await f?.db.close();});
beforeEach(async()=>{
  await f.identity();await f.db.exec('begin');
  id=await f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,status,live,requested_profiles_count,results_limit,
    actor_run_id,expected_actor_id,expected_provider_user_id,apify_account_slot,provider_terminal_status,dataset_id,actual_cost_usd,reserved_usd,completed_at)
    values($1,'daily','succeeded',true,1,30,'charge-run','actor','fixture',1,'SUCCEEDED','dataset',0,0,clock_timestamp()) returning id v`,[fixtureOwner]);
  await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)',[id,f.creator]);await f.identity('service_role');
});
afterEach(async()=>{await f.db.exec('rollback');await f.identity();});
const observe=(amount:number|null,owner=fixtureOwner)=>f.rpc<Record<string,unknown>>('worker_observe_run_charge',[owner,id,'charge-run','actor','fixture','SUCCEEDED','dataset',amount]);
describe('delayed provider charge observations',()=>{
  it('audits a delayed zero-to-positive update and preserves exact replay',async()=>{
    await observe(0);expect(await observe(.00109)).toMatchObject({actual_cost_usd:.00109,billing_review_required:false});
    await observe(.00109);await f.identity();
    expect(await f.value('select count(*)::int v from collection_intents_private.charge_observations where job_id=$1',[id])).toBe(2);
  });
  it('retains protection and records review when the provider later reports a lower amount',async()=>{
    await observe(.02);expect(await observe(.01)).toMatchObject({actual_cost_usd:.02,billing_review_required:true});
  });
  it('preserves known cost when the latest metadata omits a total',async()=>{
    await observe(.02);expect(await observe(null)).toMatchObject({actual_cost_usd:.02});
  });
  it('revisits recent known terminal charges in the bounded billing-only selector',async()=>{
    expect(await f.rpc('worker_claim_billing_reconciliation',[fixtureOwner,id,10])).toMatchObject([{job:{id,actual_cost_usd:0}}]);
  });
  it('denies another owner and browser writes',async()=>{await expect(observe(.01,fixtureStranger)).rejects.toThrow('run_identity_mismatch');});
  it('denies browser observation writes',async()=>{await f.identity('authenticated');await expect(observe(.01)).rejects.toThrow('permission denied');});
  it('updates the existing ordinary run path without silently lowering a later charge',async()=>{
    await f.rpc('worker_reconcile_run',[id,'charge-run','actor','fixture','SUCCEEDED','dataset',.03]);
    expect(await f.rpc('worker_reconcile_run',[id,'charge-run','actor','fixture','SUCCEEDED','dataset',.02])).toMatchObject({actual_cost_usd:.03,billing_review_required:true});
  });
  it('reprocesses only the ingested profile summary, retaining the accepted run and charge',async()=>{
    await f.identity();
    const profile=await f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,status,live,requested_profiles_count,results_limit,manual_authorized_by,
      actor_run_id,expected_actor_id,expected_provider_user_id,apify_account_slot,provider_terminal_status,dataset_id,actual_cost_usd,reserved_usd,
      dispatch_phase,dispatch_nonce,attempt_count,dataset_cursor,dataset_finished,output_summary_reason)
      values($1,'profile','partial',true,1,1,$1,'profile-run','actor','fixture',1,'SUCCEEDED','dataset',.00109,0,
        'attached',gen_random_uuid(),1,1,true,'profile_output_contract_unverified') returning id v`,[fixtureOwner]);
    await f.db.query("insert into public.scrape_job_creators(job_id,creator_id,status,result_count,received_count,completion_status,error_message) values($1,$2,'active',1,1,'partial','profile_output_contract_unverified')",[profile,f.creator]);
    await f.identity('service_role');
    const args=[fixtureOwner,profile,'profile-run','11111111-1111-4111-8111-111111111111'];
    expect(await f.rpc('worker_reprocess_profile_output',args)).toMatchObject({status:'processing',actor_run_id:'profile-run',actual_cost_usd:.00109,dataset_cursor:1,dataset_finished:true,attempt_count:1});
    expect(await f.rpc('worker_reprocess_profile_output',args)).toMatchObject({status:'processing',attempt_count:1});
    const processing=await f.rpc<{job:{lease_token:string}}>('worker_claim_processing',[profile]);
    await f.rpc('worker_record_output_summary',[profile,processing.job.lease_token,JSON.stringify({ok:true,total_items:1,users:[{creator_id:f.creator,username:'backend_fixture',count:1,error:null}],complete:true,reason:null})]);
    await f.rpc('worker_finish_processing',[profile,processing.job.lease_token]);
    expect(await f.value('select status v from public.scrape_jobs where id=$1',[profile])).toBe('succeeded');
  });
});

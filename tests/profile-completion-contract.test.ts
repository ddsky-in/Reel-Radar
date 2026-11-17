import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const providers = await import('../supabase/functions/_shared/providers.ts' as string);
let rows: Record<string, unknown>[], output: Record<string, unknown>, metadata: Record<string, unknown>;
const context = () => ({ job: { id:'11111111-1111-4111-8111-111111111111', kind:'profile', live:true, apify_account_slot:1,
  expected_actor_id:'profile-actor',expected_provider_user_id:'account',actor_run_id:'run',dataset_id:'dataset',dataset_cursor:1,dataset_finished:true },
  creators:[{id:'22222222-2222-4222-8222-222222222222',username:'fixture'}] });
const run = {id:'run',actorId:'profile-actor',userId:'account',status:'SUCCEEDED',defaultDatasetId:'dataset',defaultKeyValueStoreId:'store',usageTotalUsd:.00109};
beforeEach(() => {
  const values: Record<string,string> = {APIFY_API_TOKEN:'synthetic',APIFY_ACCOUNT_ID:'account',APIFY_PROFILE_ACTOR_RESOURCE_ID:'profile-actor',PROFILE_OUTPUT_MAPPING_JSON:JSON.stringify({username:'username',followers:'followersCount'})};
  vi.stubGlobal('Deno',{env:{get:(key:string)=>values[key]}});
  rows=[{username:'fixture',followersCount:0}]; output={results:1,profilesFound:1,statsRead:1,detailsRead:1,statsUnavailable:0,detailsUnavailable:0,costStateUnreadable:false,stopReason:'maxResults'};
  metadata={id:'dataset',userId:'account',itemCount:1};
  vi.stubGlobal('fetch',vi.fn(async (input: unknown, init?: RequestInit) => {
    expect(init?.method ?? 'GET').toBe('GET'); const url = new URL(String(input));
    if(url.pathname==='/v2/users/me') return Response.json({data:{id:'account'}});
    if(url.pathname==='/v2/key-value-stores/store/records/OUTPUT') return Response.json(output);
    if(url.pathname==='/v2/datasets/dataset') return Response.json({data:metadata});
    if(url.pathname==='/v2/datasets/dataset/items') {expect(url.searchParams.get('limit')).toBe('2'); return Response.json(rows);}
    throw new Error('Unexpected provider operation');
  }));
});
afterEach(()=>vi.unstubAllGlobals());
const summary=()=>new providers.ApifyProfiles({accountSlot:1,expectedProviderUserId:'account'}).summary(context(),run);
describe('profile-specific aggregate OUTPUT and exact dataset proof',()=>{
  it('accepts one complete identity-verified profile, including a known zero follower count',async()=>{
    expect(await summary()).toMatchObject({ok:true,total_items:1,complete:true,users:[{username:'fixture',count:1,error:null}]});
  });
  it.each(['statsUnavailable','detailsUnavailable'])('rejects unavailable %s even with a successful run',async field=>{output[field]=1;expect((await summary()).complete).toBe(false);});
  it('rejects an unverified dataset owner',async()=>{metadata.userId='foreign';expect((await summary()).complete).toBe(false);});
  it('rejects a dataset count mismatch',async()=>{metadata.itemCount=2;expect((await summary()).complete).toBe(false);});
  it('rejects a foreign profile identity',async()=>{rows[0].username='foreign';expect((await summary()).complete).toBe(false);});
  it('does not turn missing followers into a successful profile',async()=>{rows[0].followersCount=null;expect((await summary()).complete).toBe(false);});
  it('does not reuse the unrelated Reels OUTPUT schema',async()=>{output={ok:true,total_items:1,users:[{user:'fixture',count:1}]};expect((await summary()).complete).toBe(false);});
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';
import { withCarouselMetrics } from '../src/lib/metrics';
import type { Carousel, CarouselDetail, PageResult, SavedCarouselFilter } from '../src/lib/types';
let f: Awaited<ReturnType<typeof featureDatabase>>;
let postId:string,jobId:string,lease:string;
const fetched='2026-11-01T00:00:00Z';
beforeAll(async()=>{
  f=await featureDatabase();
  await f.db.query("insert into public.creator_follower_snapshots(creator_id,captured_date,followers_count,source,captured_at) values($1,'2026-10-01',1000,'fixture','2026-10-01T00:00:00Z')",[f.creator]);
},60000);
afterAll(async()=>{await f?.db.close();});
async function processing() {
  await f.identity();
  return f.value<{id:string;lease_token:string}>("insert into public.scrape_jobs(owner_user_id,kind,status,results_limit,requested_profiles_count,estimated_cost_usd,lease_token,lease_expires_at,result_fetched_at,provider_terminal_status) values($1,'carousel','processing',30,1,0,gen_random_uuid(),now()+interval '5 minutes',$2,'SUCCEEDED') returning jsonb_build_object('id',id,'lease_token',lease_token) v",[fixtureOwner,fetched]);
}
function record(time=fetched) {
  return {creator_id:f.creator,username:'backend_fixture',content_type:'carousel',shortcode:'CAROUSEL_DB',reel_url:'https://www.instagram.com/p/CAROUSEL_DB/',caption_full:'Complete caption',published_at:'2026-10-01T00:00:00Z',published_at_basis:'explicit_offset',provider:'fixture',fetched_at:time,
    likes:100,comments:0,likes_state:'known',comments_state:'known',slides:[{position:1,media_type:'image',image_url:null,video_url:null},{position:2,media_type:'video',image_url:null,video_url:null}]};
}
describe('carousel database boundaries',()=>{
  it('ingests a leased page once and leaves Reels/transcription/freshness unchanged',async()=>{
    const before=await f.value<number>('select count(*)::int v from public.reels');
    const jobsBefore=await f.value<number>('select count(*)::int v from public.transcript_jobs');
    const freshness=await f.value<string|null>('select last_reels_fetch_at::text v from public.creators where id=$1',[f.creator]);
    const j=await processing();jobId=j.id;lease=j.lease_token;
    await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)',[jobId,f.creator]);
    await f.identity('service_role');
    const args=[jobId,lease,0,JSON.stringify([record()]),'[]',2,true,JSON.stringify({[f.creator]:2})];
    expect(await f.rpc('worker_ingest_page',args)).toMatchObject({accepted:1,duplicate:false});
    expect(await f.rpc('worker_ingest_page',args)).toMatchObject({duplicate:true});
    await f.rpc('worker_record_output_summary',[jobId,lease,JSON.stringify({ok:true,total_items:2,users:[{creator_id:f.creator,username:'backend_fixture',count:2,error:null}],complete:true,reason:null})]);
    expect(await f.rpc('worker_finish_processing',[jobId,lease])).toMatchObject({status:'succeeded',returned_records_count:1,actual_cost_usd:null});
    await f.identity();
    expect(await f.value<number>('select count(*)::int v from public.reels')).toBe(before);
    expect(await f.value<number>('select count(*)::int v from public.transcript_jobs')).toBe(jobsBefore);
    expect(await f.value<string|null>('select last_reels_fetch_at::text v from public.creators where id=$1',[f.creator])).toBe(freshness);
    postId=await f.value<string>("select id v from public.carousel_posts where shortcode='CAROUSEL_DB'");
    await f.identity('authenticated');
    const detail=await f.rpc<CarouselDetail>('get_carousel_detail',[f.workspace,postId]);
    expect(detail.carousel).toMatchObject({caption:'Complete caption',latest_likes:100,latest_comments:0,followers_count:1000,follower_engagement_pct:10});
    expect(detail.snapshots).toHaveLength(1);expect(detail.carousel.slides).toHaveLength(2);
  });
  it('preserves newer metrics, ordered slides and daily snapshots on an older delivery',async()=>{
    const j=await processing();await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)',[j.id,f.creator]);
    await f.identity('service_role');
    await f.rpc('worker_ingest_page',[j.id,j.lease_token,0,JSON.stringify([{...record('2026-10-31T00:00:00Z'),likes:1,slides:[]}]),'[]',1,true,JSON.stringify({[f.creator]:1})]);
    await f.identity('authenticated');
    const detail=await f.rpc<CarouselDetail>('get_carousel_detail',[f.workspace,postId]);
    expect(detail.carousel.latest_likes).toBe(100);expect(detail.carousel.slides).toHaveLength(2);expect(detail.snapshots).toHaveLength(2);
  });
  it('requires owner, workspace and active creator access for reads and saves',async()=>{
    await f.identity('anon');
    await expect(f.value<number>('select count(*)::int v from public.carousel_posts')).rejects.toThrow('permission denied');
    await expect(f.rpc('query_carousels',[f.workspace,'{}'])).rejects.toThrow();
    await expect(f.rpc('worker_finish_processing',[jobId,lease])).rejects.toThrow();
    await f.identity('authenticated',fixtureStranger);
    expect(await f.value<number>('select count(*)::int v from public.carousel_posts')).toBe(0);
    await expect(f.rpc('get_carousel_detail',[f.workspace,postId])).rejects.toThrow();
    await expect(f.rpc('set_carousel_bookmark',[f.workspace,postId,true,'secret','{}'])).rejects.toThrow();
    await f.identity('authenticated');
    const other=await f.rpc<{id:string}>('create_workspace',['Other carousel workspace']);
    await expect(f.rpc('get_carousel_detail',[other.id,postId])).rejects.toThrow();
    await expect(f.rpc('set_carousel_bookmark',[other.id,postId,true])).rejects.toThrow();
    await f.rpc('add_creator',[other.id,'backend_fixture']);
    await f.rpc('set_carousel_bookmark',[f.workspace,postId,true,'Hook note',['hook']]);
    expect((await f.rpc<CarouselDetail>('get_carousel_detail',[f.workspace,postId])).carousel.saved).toBe(true);
    expect((await f.rpc<CarouselDetail>('get_carousel_detail',[other.id,postId])).carousel.saved).toBe(false);
    await f.rpc('set_carousel_bookmark',[f.workspace,postId,false]);
    expect((await f.rpc<PageResult<Carousel>>('query_carousels',[f.workspace,'{"saved":true}'])).total).toBe(0);
  });
  it('calculates the complete prior baseline consistently before pagination or search',async()=>{
    await f.identity();
    for (let i=0;i<12;i++) await f.db.query("insert into public.carousel_posts(creator_id,shortcode,caption,published_at,latest_likes,latest_comments,likes_state,comments_state,latest_fetched_at,provider) values($1,$2,$3,$4,$5,0,'known','known',$6,'fixture')",
      [f.creator,'BASELINE_'+i,i===11 ? 'unique latest' : 'earlier',new Date(Date.UTC(2026,9,i+2)).toISOString(),i===11 ? 1000 : 100+i,fetched]);
    await f.identity('authenticated');
    const all=await f.rpc<PageResult<Carousel>>('query_carousels',[f.workspace,'{"limit":50}']);
    const filtered=await f.rpc<PageResult<Carousel>>('query_carousels',[f.workspace,'{"search":"unique latest","limit":1,"sort":"profile_outlier"}']);
    const expected=withCarouselMetrics(all.items).find(c=>c.caption==='unique latest')!;
    expect(filtered.total).toBe(1);expect(filtered.items[0].profile_baseline_sample).toBe(expected.profile_baseline_sample);
    expect(filtered.items[0].profile_outlier_score).toBeCloseTo(expected.profile_outlier_score!);
    expect(filtered.items[0].profile_baseline_interactions).toBe(expected.profile_baseline_interactions);
    await expect(f.rpc('query_carousels',[f.workspace,'{"views":100}'])).rejects.toThrow();
  });
  it('deduplicates manual queues and uses the shared transactional budget with unknown-cost holds',async()=>{
    await f.identity();await f.db.exec("update public.scrape_jobs set status='failed',actual_cost_usd=0,reserved_usd=0,completed_at=now();");
    await f.identity('authenticated');
    const q=await f.rpc<{job_ids:string[]}>('enqueue_carousel_refresh',[f.workspace,[f.creator]]);
    expect(await f.rpc('enqueue_carousel_refresh',[f.workspace,[f.creator]])).toEqual(q);
    await f.identity('service_role');
    const claimed=await f.rpc<{job:{id:string;reserved_usd:number;kind:string};max_total_charge_usd:number}>('worker_claim_dispatch',[fixtureOwner,true,'fixture-actor','carousel']);
    expect(claimed.job.id).toBe(q.job_ids[0]);expect(claimed.job.kind).toBe('carousel');
    expect(claimed.max_total_charge_usd).toBeGreaterThan(0);
    expect(claimed.job.reserved_usd).toBe(claimed.max_total_charge_usd);
    await f.identity();await f.db.query("update public.scrape_jobs set status='succeeded',actual_cost_usd=null,provider_terminal_status='SUCCEEDED' where id=$1",[claimed.job.id]);
    await f.identity('authenticated');await f.rpc('enqueue_carousel_refresh',[f.workspace,[f.creator]]);
    await f.identity('service_role');
    expect(await f.rpc('worker_claim_dispatch',[fixtureOwner,true,'fixture-actor','carousel'])).toMatchObject({reason:'unreconciled_charges'});
    await f.identity('authenticated',fixtureStranger);
    await expect(f.rpc('enqueue_carousel_refresh',[f.workspace,[f.creator]])).rejects.toThrow();
  });
  it('applies multiple channels, decimal score ranges and keywords without changing the prior baseline',async()=>{
    await f.identity('authenticated');
    const result=await f.rpc<PageResult<Carousel>>('query_carousels',[f.workspace,JSON.stringify({creator_ids:[f.creator],keywords:'UNIQUE LATEST',min_outlier:1,max_outlier:1,min_profile_outlier:5,max_profile_outlier:10,min_engagement:100,max_engagement:100,limit:1})]);
    expect(result.total).toBe(1);expect(result.items[0].follower_outlier_score).toBe(1);
    expect(result.items[0].profile_baseline_sample).toBe(12);
    expect((await f.rpc<PageResult<Carousel>>('query_carousels',[f.workspace,'{"creator_ids":[]}'])).total).toBe(0);
    expect((await f.rpc<PageResult<Carousel>>('query_carousels',[f.workspace,JSON.stringify({creator_ids:[fixtureStranger]})])).total).toBe(0);
    for (const query of [{min_outlier:2,max_outlier:1},{max_engagement:101},{max_profile_outlier:1000001},{posted_amount:13,posted_unit:'months'},{posted_amount:1},{creator_ids:null},{creator_ids:[f.creator,f.creator]},{creator:f.creator,creator_ids:[]},{min_outlier:'0'},{min_outlier:null},{keywords:null},{page:1.5}]) {
      await expect(f.rpc('query_carousels',[f.workspace,JSON.stringify(query)])).rejects.toThrow('invalid_query');
    }
  });
  it('excludes hidden metrics from zero ranges and uses inclusive IST calendar boundaries for the rolling period',async()=>{
    await f.identity();
    const boundary=Number(await f.value<number>("select (extract(epoch from (((current_timestamp at time zone 'Asia/Kolkata')::date-7)::timestamp at time zone 'Asia/Kolkata'))*1000)::bigint v"));
    const until=Number(await f.value<number>("select (extract(epoch from (((current_timestamp at time zone 'Asia/Kolkata')::date+1)::timestamp at time zone 'Asia/Kolkata'))*1000)::bigint v"));
    for (const [shortcode,time,likes,likesState] of [['FILTER_ZERO',boundary,0,'known'],['FILTER_HIDDEN',boundary+1000,null,'hidden'],['FILTER_BEFORE',boundary-1000,10,'known'],['FILTER_AFTER',until,10,'known']] as const) {
      await f.db.query("insert into public.carousel_posts(creator_id,shortcode,caption,published_at,latest_likes,latest_comments,likes_state,comments_state,latest_fetched_at,provider) values($1,$2,'period boundary',$3,$4,0,$5,'known',now(),'fixture')",[f.creator,shortcode,new Date(time).toISOString(),likes,likesState]);
    }
    await f.identity('authenticated');
    const period=await f.rpc<PageResult<Carousel>>('query_carousels',[f.workspace,'{"keywords":"period boundary","posted_amount":7,"posted_unit":"days"}']);
    expect(period.items.map(post=>post.shortcode).sort()).toEqual(['FILTER_HIDDEN','FILTER_ZERO']);
    const zero=await f.rpc<PageResult<Carousel>>('query_carousels',[f.workspace,'{"keywords":"period boundary","min_engagement":0,"max_engagement":0}']);
    expect(zero.items.map(post=>post.shortcode)).toEqual(['FILTER_ZERO']);
    const ratio=await f.rpc<PageResult<Carousel>>('query_carousels',[f.workspace,'{"keywords":"period boundary","min_outlier":0,"max_outlier":0}']);
    expect(ratio.items.map(post=>post.shortcode)).toEqual(['FILTER_ZERO']);
  });
  it('stores rolling carousel presets behind owner authorization with a separate atomic limit',async()=>{
    await f.identity('authenticated');
    const query={creator_ids:[f.creator],posted_amount:7,posted_unit:'days',min_profile_outlier:5};
    const preset=await f.rpc<SavedCarouselFilter>('create_carousel_filter',['  Strong hooks  ',JSON.stringify(query)]);
    expect(preset).toMatchObject({name:'Strong hooks',config:{version:1,query}});
    expect(await f.rpc<SavedCarouselFilter[]>('list_carousel_filters')).toEqual([preset]);
    expect(await f.rpc('list_reel_filters')).toEqual([]);
    await expect(f.rpc('create_carousel_filter',['strong HOOKS','{}'])).rejects.toThrow('carousel_filter_name_exists');
    for (const bad of [{page:2},{limit:30},{min_views:100},{posted_unit:'days'},{min_outlier:2,max_outlier:1}]) await expect(f.rpc('create_carousel_filter',['Invalid',JSON.stringify(bad)])).rejects.toThrow();
    await expect(f.db.exec("insert into public.saved_carousel_filters(owner_user_id,name,config) values(auth.uid(),'Bypass','{\"version\":1,\"query\":{}}')")).rejects.toThrow('permission denied');
    for (let i=1;i<50;i++) await f.rpc('create_carousel_filter',['Preset '+i,'{}']);
    await expect(f.rpc('create_carousel_filter',['Over limit','{}'])).rejects.toThrow('carousel_filter_limit_reached');
    await f.identity('authenticated',fixtureStranger);
    expect(await f.value<number>('select count(*)::int v from public.saved_carousel_filters')).toBe(0);
    await expect(f.rpc('list_carousel_filters')).rejects.toThrow('forbidden');
    await expect(f.rpc('create_carousel_filter',['Foreign','{}'])).rejects.toThrow('forbidden');
    await expect(f.rpc('delete_carousel_filter',[preset.id])).rejects.toThrow('forbidden');
    await f.identity('anon');await expect(f.rpc('list_carousel_filters')).rejects.toThrow();
    await f.identity('service_role');await expect(f.rpc('list_carousel_filters')).rejects.toThrow();
    await f.identity('authenticated');
    await f.rpc('delete_carousel_filter',[preset.id]);
    expect(await f.rpc<SavedCarouselFilter[]>('list_carousel_filters')).toHaveLength(49);
    await f.rpc('create_carousel_filter',['Replacement','{}']);
    expect(await f.rpc<SavedCarouselFilter[]>('list_carousel_filters')).toHaveLength(50);
  });
});

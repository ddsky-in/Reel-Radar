import { afterEach, describe, expect, it, vi } from 'vitest';
const model=await import('../supabase/functions/_shared/model.ts' as string);
const providers=await import('../supabase/functions/_shared/providers.ts' as string);
const creator='22222222-2222-4222-8222-222222222222';
const context={job:{kind:'carousel',results_limit:30,started_at:'2026-11-01T00:00:00Z',dataset_cursor:1},creators:[{id:creator,username:'fixture'}]};
const row={ownerUsername:'fixture',type:8,productType:'carousel_container',url:'https://www.instagram.com/p/CAROUSEL/',timestamp:'2026-10-01T12:00:00Z',likesCount:0,commentsCount:-1,caption:'Full caption',videoPlayCount:99999,
  childPosts:[{type:1,displayUrl:'https://scontent.cdninstagram.com/a.jpg'},{type:2,displayUrl:'https://scontent.cdninstagram.com/b.jpg',videoUrl:'https://scontent.cdninstagram.com/b.mp4'},{type:1,displayUrl:'https://evil.test/c.jpg'}]};
afterEach(()=>vi.unstubAllGlobals());
describe('carousel provider',()=>{
  it('maps the Actor child media_type, thumb and url_video fields in order with CDN validation',()=>{
    const result=model.normalizeCarousel({...row,childPosts:[
      {media_type:1,thumb:'https://scontent.cdninstagram.com/first.webp',url_video:null},
      {media_type:2,thumb:'https://scontent.cdninstagram.com/second.webp',url_video:'https://video.fbcdn.net/second.mp4'},
      {media_type:1,thumb:'https://evil.test/third.jpg',url_video:'https://evil.test/third.mp4'},
      {thumb:'https://scontent.cdninstagram.com/unknown.webp'},
    ]},context,'fixture').record;
    expect(result.slides).toEqual([
      {position:1,media_type:'image',image_url:'https://scontent.cdninstagram.com/first.webp',video_url:null},
      {position:2,media_type:'video',image_url:'https://scontent.cdninstagram.com/second.webp',video_url:'https://video.fbcdn.net/second.mp4'},
      {position:3,media_type:'image',image_url:null,video_url:null},
      {position:4,media_type:'unknown',image_url:'https://scontent.cdninstagram.com/unknown.webp',video_url:null},
    ]);
  });
  it('maps ordered slides, unknown metrics and omits Reel views/transcription fields',()=>{
    const result=model.normalizeCarousel(row,context,'fixture').record;
    expect(result).toMatchObject({content_type:'carousel',likes:0,likes_state:'known',comments:null,comments_state:'hidden',caption_full:'Full caption'});
    expect(result).not.toHaveProperty('views');expect(result).not.toHaveProperty('media_source_url');
    expect(result.slides).toMatchObject([{position:1,media_type:'image'},{position:2,media_type:'video'},{position:3,image_url:null}]);
    expect(model.normalizeCarousel({...row,type:1,productType:'feed'},context,'fixture')).toEqual({});
    expect(model.normalizeCarousel({...row,type:99,productType:null},context,'fixture').error).toBeTruthy();
    expect(()=>model.normalizeCarousel({...row,ownerUsername:'stranger'},context,'fixture')).toThrow();
    expect(()=>model.normalizeCarousel({...row,childPosts:Array(21).fill({})},context,'fixture')).toThrow();
  });
  it('blocks live carousel mapping by default and uses the bounded photos input after validation',()=>{
    const values: Record<string,string>={PROVIDER_MODE:'apify',APIFY_REEL_ACTOR_RESOURCE_ID:'actor'};
    vi.stubGlobal('Deno',{env:{get:(key:string)=>values[key]}});
    expect(()=>providers.validateProfileSetup('carousel')).toThrow('mapping');
    const adapter=new providers.ApifyCarousels();expect(()=>adapter.input(context)).toThrow('mapping');
    values.CAROUSEL_PROVIDER_VALIDATED='true';
    expect(adapter.input(context)).toEqual({directUrls:['fixture'],resultsType:'photos',resultsLimit:30,skipPinnedPosts:false,selectedFields:[]});
    expect(()=>adapter.input({...context,job:{...context.job,results_limit:100}})).toThrow();
  });
  it('reconciles empty photo feeds without inferring privacy or fabricated carousels',()=>{
    expect(providers.reconcileOutput({ok:true,total_items:0,users:[{user:'fixture',count:0,error:'no_items'}]},context)).toMatchObject({complete:true,total_items:1,users:[{count:1,error:null}]});
    expect(providers.reconcileOutput({ok:true,total_items:1,users:[{user:'stranger',count:1}]},context).complete).toBe(false);
  });
});

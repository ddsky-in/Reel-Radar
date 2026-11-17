import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoData } from '../src/lib/demo';
import { carouselFollowerEngagement, carouselInteractions, withCarouselMetrics } from '../src/lib/metrics';
import { carouselMediaUrl, carouselQueryString, readCarouselQuery } from '../src/lib/carousels';
import { DemoRepository } from '../src/lib/server/demo-repository';
import { safeCarousel, safeCarouselDetail } from '../src/lib/server/carousel-data';
import { CarouselGallery, CarouselCard } from '../src/components/carousels';
import { appPath } from '../src/lib/app-navigation';

afterEach(()=>vi.unstubAllGlobals());
describe('carousel research',()=>{
  it('keeps missing, hidden and zero metrics distinct without inventing views',()=>{
    expect(carouselInteractions(0,0)).toBe(0);
    expect(carouselInteractions(100,null)).toBeNull();
    expect(carouselInteractions(-1,5)).toBeNull();
    expect(carouselFollowerEngagement(50,10,1000)).toBe(6);
    expect(carouselFollowerEngagement(50,10,0)).toBeNull();
    const c=safeCarousel({...createDemoData().carousels[0],likes_state:'hidden',latest_likes:100});
    expect(c.latest_likes).toBeNull();expect(c.interactions).toBeNull();expect(c.profile_outlier_score).toBeNull();
  });
  it('uses only strictly earlier known carousels, at most 30, before filters',()=>{
    const seed=createDemoData().carousels[0];
    const posts=Array.from({length:42},(_,i)=>({...seed,id:String(i),published_at:new Date(Date.UTC(2026,0,i+1)).toISOString(),latest_likes:i===41 ? 1000 : i,latest_comments:0}));
    const latest=withCarouselMetrics(posts).at(-1)!;
    expect(latest.profile_baseline_sample).toBe(30);expect(latest.profile_baseline_interactions).toBe(25.5);expect(latest.profile_outlier_score).toBeCloseTo(1000/25.5);
    expect(withCarouselMetrics(posts.slice(0,10)).at(-1)?.profile_outlier_score).toBeNull();
    const zero=withCarouselMetrics(posts.map(p=>({...p,latest_likes:0}))).at(-1)!;
    expect(zero.profile_baseline_interactions).toBe(0);expect(zero.profile_outlier_score).toBeNull();
    const equal=withCarouselMetrics(posts.map(p=>({...p,published_at:seed.published_at})));
    expect(equal.every(p=>p.profile_baseline_sample===0)).toBe(true);
  });
  it('validates URL filters and rejects Reel-only and malformed filters',()=>{
    const q={search:'a & b',saved:true,sort:'profile_outlier' as const,min_interactions:0,page:2};
    expect(readCarouselQuery(new URLSearchParams(carouselQueryString(q)))).toEqual(q);
    for(const value of ['views=1','saved=yes','page=0','page=1&page=2','min_interactions=-1','limit=51','sort=views','min_interactions=9007199254740992']) expect(()=>readCarouselQuery(new URLSearchParams(value))).toThrow();
    expect(appPath('carousels')).toBe('/carousels');
  });
  it('allows only local demo assets and Instagram CDN media',()=>{
    expect(carouselMediaUrl('/demo/carousel-1.svg')).toBe('/demo/carousel-1.svg');
    expect(carouselMediaUrl('https://scontent.cdninstagram.com/image.jpg')).toBeTruthy();
    for (const value of ['http://scontent.cdninstagram.com/a','https://cdninstagram.com.evil.test/a','https://127.0.0.1/a','https://scontent.cdninstagram.com:443/a','https://a.fbcdn.net/a#fragment','data:image/svg+xml,foo','/api/auth/logout']) expect(carouselMediaUrl(value)).toBeNull();
    const c=createDemoData().carousels[0];
    const safe=safeCarousel({...c,...{secret:'hidden'},slides:[{position:1,media_type:'video',image_url:'https://evil.test/a',video_url:'https://evil.test/b'}]});
    expect(safe).not.toHaveProperty('secret');expect(safe.slides[0].video_url).toBeNull();
    expect(safeCarouselDetail({carousel:c,snapshots:[]}).carousel.post_url).toBeNull();
  });
  it('supports isolated demo saves, notes, tags, and guards collection',async()=>{
    const repo=new DemoRepository(),data=createDemoData(),a=data.workspaces[0].id,b=data.workspaces[2].id;
    const page=await repo.carousels(a,{limit:1,sort:'profile_outlier'}),c=page.items[0];
    await repo.saveCarousel(a,c.id,true,'Strong hook',['hook','hook']);
    expect((await repo.carouselDetail(a,c.id)).carousel).toMatchObject({saved:true,note:'Strong hook',tags:['hook']});
    expect((await repo.carouselDetail(b,c.id)).carousel.saved).toBe(false);
    expect((await repo.carousels(a,{saved:true})).items.some(item=>item.id===c.id)).toBe(true);
    await expect(repo.carouselDetail(data.workspaces[1].id,data.carousels.find(item=>item.username==='future.tools.demo')!.id)).rejects.toThrow();
    await expect(repo.refreshCarousels(a)).rejects.toThrow('synthetic');
    await repo.saveCarousel(a,c.id,false);
    expect((await repo.carouselDetail(a,c.id)).carousel.saved).toBe(false);
  });
  it('renders accessible media fallback, bounded gallery controls and save state',()=>{
    const c=createDemoData().carousels[0];
    const gallery=renderToStaticMarkup(createElement(CarouselGallery,{carousel:c}));
    expect(gallery).toContain('aria-label="Next slide"');expect(gallery).toContain('Slide 1 of 4');expect(gallery).toContain('aria-label="Previous slide" disabled');
    expect(renderToStaticMarkup(createElement(CarouselGallery,{carousel:{...c,slides:[]}}))).toContain('Slides unavailable');
    const card=renderToStaticMarkup(createElement(CarouselCard,{carousel:{...c,saved:true},busy:false,onOpen:()=>{},onSave:()=>{}}));
    expect(card).toContain('aria-label="Remove saved carousel"');expect(card).toContain('Follower engagement');expect(card).not.toContain('views');
  });
});

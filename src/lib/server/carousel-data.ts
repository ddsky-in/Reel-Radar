import type { Carousel, CarouselDetail, CarouselSlide, MetricState, PageResult, SavedCarouselFilter } from '../types';
import { carouselFilterQuerySchema, carouselMediaUrl } from '../carousels';
import { carouselFollowerEngagement, carouselFollowerOutlier, carouselInteractions, normalizeMetric } from '../metrics';
import { ApiError } from './errors';

function fail(): never { throw new ApiError(503,'INVALID_CAROUSEL_DATA','Carousel data could not be loaded.'); }
function text(value: unknown, limit: number): string { return typeof value==='string' ? value.slice(0,limit) : ''; }
function state(value: unknown): MetricState { return ['known','hidden','not_fetched','unavailable'].includes(String(value)) ? value as MetricState : 'unavailable'; }
function date(value: unknown): string | null { return typeof value==='string' && Number.isFinite(Date.parse(value)) ? value : null; }
function postUrl(value: unknown): string | null {
  try { const u=new URL(String(value)); return u.protocol==='https:' && !u.username && !u.password && !u.port && ['instagram.com','www.instagram.com'].includes(u.hostname) && /^\/p\/[A-Za-z0-9_-]{1,64}\/?$/.test(u.pathname) ? u.href : null; } catch { return null; }
}
export function safeCarousel(value: Carousel): Carousel {
  if (!value || !/^[0-9a-f-]{36}$/i.test(value.id) || !/^[0-9a-f-]{36}$/i.test(value.creator_id) || !/^[a-z0-9._]{1,30}$/i.test(value.username) || !Array.isArray(value.slides) || value.slides.length>20) fail();
  const likesState=state(value.likes_state),commentsState=state(value.comments_state);
  const likes=likesState==='known' ? normalizeMetric(value.latest_likes) : null, comments=commentsState==='known' ? normalizeMetric(value.latest_comments) : null;
  const followers=normalizeMetric(value.followers_count),sample=Math.min(30,Math.max(0,Number.isSafeInteger(value.profile_baseline_sample) ? value.profile_baseline_sample : 0));
  const baseline=sample>=10 ? normalizeMetric(value.profile_baseline_interactions) : null;
  const total=carouselInteractions(likes,comments);
  const slides: CarouselSlide[]=value.slides.map((slide,i)=>({
    position:i+1,media_type:['image','video','unknown'].includes(slide.media_type) ? slide.media_type : 'unknown',
    image_url:carouselMediaUrl(slide.image_url),video_url:slide.media_type==='video' ? carouselMediaUrl(slide.video_url) : null,
  }));
  return {
    id:value.id,creator_id:value.creator_id,shortcode:text(value.shortcode,64),post_url:postUrl(value.post_url),thumbnail_url:carouselMediaUrl(value.thumbnail_url),
    caption:text(value.caption,10000),published_at:date(value.published_at),published_at_raw:typeof value.published_at_raw==='string' ? text(value.published_at_raw,64) : null,
    published_at_basis:['explicit_offset','timezone_unverified','assumed_Asia/Kolkata'].includes(value.published_at_basis) ? value.published_at_basis : 'timezone_unverified',
    latest_likes:likes,latest_comments:comments,likes_state:likesState,comments_state:commentsState,latest_fetched_at:date(value.latest_fetched_at) ?? '',provider:text(value.provider,200),
    slides,username:value.username,display_name:typeof value.display_name==='string' ? text(value.display_name,200) : null,avatar_url:carouselMediaUrl(value.avatar_url),
    followers_count:followers,follower_captured_at:date(value.follower_captured_at),saved:value.saved===true,note:text(value.note,4000),
    tags:Array.isArray(value.tags) ? value.tags.filter(tag=>typeof tag==='string' && tag.length<=40).slice(0,20) : [],
    interactions:total,follower_engagement_pct:carouselFollowerEngagement(likes,comments,followers),follower_outlier_score:carouselFollowerOutlier(likes,comments,followers),profile_baseline_sample:sample,profile_baseline_interactions:baseline,
    profile_outlier_score:total!==null && baseline!==null && baseline>0 ? normalizeMetric(value.profile_outlier_score) : null,
  };
}
export function safeCarouselFilter(input: unknown): SavedCarouselFilter {
  const parsed = input as Partial<SavedCarouselFilter> | null;
  const query = carouselFilterQuerySchema.safeParse(parsed?.config?.query);
  if (!parsed || typeof parsed.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.id) || typeof parsed.name !== 'string' || !parsed.name.trim() || parsed.name.length > 80 || parsed.config?.version !== 1 || !date(parsed.created_at) || !query.success) {
    throw new ApiError(503, 'INVALID_FILTER_DATA', 'Saved carousel filters could not be loaded.');
  }
  return { id: parsed.id!, name: parsed.name, config: { version: 1, query: query.data }, created_at: parsed.created_at! };
}
export function safeCarouselPage(value: PageResult<Carousel>): PageResult<Carousel> {
  return {items:value.items.map(safeCarousel),total:value.total,page:value.page,limit:value.limit};
}
export function safeCarouselDetail(value: CarouselDetail): CarouselDetail {
  if (!value || !Array.isArray(value.snapshots)) fail();
  return {carousel:safeCarousel(value.carousel),snapshots:value.snapshots.slice(0,90).map(s=>({
    fetched_at:date(s.fetched_at) ?? '',likes:s.likes_state==='known' ? normalizeMetric(s.likes) : null,comments:s.comments_state==='known' ? normalizeMetric(s.comments) : null,
    likes_state:state(s.likes_state),comments_state:state(s.comments_state),followers_at_snapshot:normalizeMetric(s.followers_at_snapshot),follower_captured_at:date(s.follower_captured_at),
  }))};
}

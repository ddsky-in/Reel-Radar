export type MetricState = 'known' | 'hidden' | 'not_fetched' | 'unavailable';
export interface Metric { value: number | null; state: MetricState }
export interface CreatorRef { id: string; username: string }
export type ApifyAccountSlot = 1 | 2 | 3 | 4 | 5;
/** Public identity only. Credentials are resolved exclusively from fixed server env names. */
export interface ApifyAccountContext { readonly accountSlot: ApifyAccountSlot; readonly expectedProviderUserId: string }
export interface ApifyAccount {
  owner_user_id: string; account_slot: ApifyAccountSlot; provider_user_id: string | null;
  enabled: boolean; authorization_confirmed: boolean;
  usage_cycle_start_at: string | null; usage_cycle_end_at: string | null;
  usage_usd: number | null; limit_usd: number | null; usage_reconciled_at: string | null;
}
export interface Job {
  id: string; owner_user_id: string; kind: string; status: string; live: boolean;
  apify_account_slot?: ApifyAccountSlot | null;
  results_limit: number; actor_run_id: string | null; dispatch_nonce: string;
  expected_actor_id: string; expected_provider_user_id: string;
  dataset_id: string | null; dataset_cursor: number; dataset_finished: boolean;
  lease_token: string; started_at: string; result_fetched_at?: string | null; provider_terminal_status: string | null;
  actual_cost_usd: number | null;
  reserved_usd?: number | string;
  collection_source?: 'legacy' | 'ordinary' | 'carousel_pilot' | 'target_media' | 'operator_settle';
  /** Durable service-owned metadata from the authorized DB job, not request flags. */
  carousel_initial?: boolean; carousel_automatic?: boolean; carousel_initial_request_id?: string | null;
  manual_authorized_by?: string | null; requested_profiles_count?: number;
  competitor_run_id?: string | null; collection_since?: string | null; workflow_attempt?: number | null;
  /** Frozen metrics target count; request at most this count plus 50 feed results. */
  metrics_tracked_count?: number | null;
  /** Durable discovery provenance; new starts collect at most 50 feed results. */
  discovery_bounded?: boolean;
}
export interface Run {
  id: string; actorId: string; userId: string; status: string;
  defaultDatasetId: string | null; defaultKeyValueStoreId?: string | null; usageTotalUsd: number | null;
}
export interface OutputSummary {
  ok: boolean; total_items: number | null;
  users: { creator_id: string; username: string; count: number | null; error: string | null }[];
  complete: boolean; reason: string | null;
}
export interface AccountUsageObservation {
  /** DB-issued owner/slot-bound request-start checkpoint; never a provider billing watermark. */
  observationId: string; observedAt: string;
}
export interface AccountUsage {
  userId: string; cycleStart: string; cycleEnd: string; usageUsd: number; limitUsd: number;
  /** Optional only for legacy callers, whose writes cannot advance accounting. */
  observationId?: string; observedAt?: string;
  plan?: { tier?: string; monthlyUsageCreditsUsd?: number };
}
export interface Page { items: unknown[]; next: number; finished: boolean }
export interface Context { job: Job; creators: CreatorRef[] }
export interface Normalized {
  content_type?: 'carousel'; slides?: { position: number; media_type: 'image' | 'video' | 'unknown'; image_url: string | null; video_url: string | null }[];
  creator_id: string; username: string; fetched_at: string; provider: string;
  shortcode?: string; instagram_media_id?: string | null; reel_url?: string | null;
  thumbnail_url?: string | null; caption_preview?: string; caption_full?: string | null; published_at?: string | null;
  published_at_raw?: string | null; published_at_basis?: 'explicit_offset' | 'timezone_unverified' | 'assumed_Asia/Kolkata';
  duration_seconds?: number | null; views?: number | null; likes?: number | null;
  media_source_url?: string | null; media_candidates?: string[]; has_audio?: boolean | null;
  comments?: number | null; views_state?: MetricState; likes_state?: MetricState;
  comments_state?: MetricState; followers_count?: number | null;
  display_name?: string | null; avatar_url?: string | null;
}
export interface ProfileError { creator_id: string; status: 'failed' | 'private' | 'unavailable'; message: string }
export type CollectionSubmitScope = 'ordinary' | 'carousel_pilot' | 'target_media';
/** No provider text, request headers, credentials or arbitrary errors cross this boundary. */
export type StartOutcome =
  | { kind: 'accepted'; run: Run }
  | { kind: 'accepted_hint'; runId: string }
  | { kind: 'acceptance_unknown' }
  | { kind: 'not_authorized' }
  | { kind: 'authorization_unknown' };
export interface PreparedStart {
  readonly inputDigest: string;
  readonly inputProjection: Readonly<Record<string, unknown>>;
  /** One use. Authorization is awaited immediately before the sole paid POST. */
  submit(authorize: () => Promise<boolean>): Promise<StartOutcome>;
}
export interface Provider {
  actorId: string;
  prepare(context: Context, maxChargeUsd: number): Promise<PreparedStart>;
  /** Compatibility helper; live callers must provide the transactional SQL fence. */
  start(context: Context, maxChargeUsd: number, authorize?: () => Promise<boolean>): Promise<Run>;
  run(id: string): Promise<Run>;
  page(context: Context, limit: number): Promise<Page>;
  summary(context: Context, verifiedRun?: Run): Promise<OutputSummary>;
  normalize(item: unknown, context: Context): { record?: Normalized; error?: ProfileError };
}
export interface ReelProvider extends Provider { kind: 'reel' }
export interface CarouselProvider extends Provider { kind: 'carousel' }
export interface ProfileProvider extends Provider { kind: 'profile' }
export function metric(value: unknown): Metric {
  if (value === undefined || value === null) return { value: null, state: 'not_fetched' };
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return { value: null, state: 'unavailable' };
  if (value < 0) return { value: null, state: value === -1 ? 'hidden' : 'unavailable' };
  return { value, state: 'known' };
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider record');
  return value as Record<string, unknown>;
}
export function publicUrl(value: unknown, instagram = false): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (instagram && !['instagram.com', 'www.instagram.com'].includes(u.hostname)) return null;
    return u.href;
  } catch { return null; }
}
// Only the verified Reel provider's explicit video fields may supply transcription media.
export function instagramMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || value.trim() !== value || /[\\\s]/.test(value)) return null;
  try {
    const u = new URL(value);
    const authority = value.match(/^https:\/\/([^/?#]+)/)?.[1];
    if (!authority || authority.includes(':') || authority.includes('@') || u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return null;
    const host = u.hostname.toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..') ||
        !['.cdninstagram.com', '.fbcdn.net'].some(suffix => host.endsWith(suffix) && host.length > suffix.length)) return null;
    return u.href;
  } catch { return null; }
}
export function reelMedia(row: Record<string, unknown>, provider: string): { media_source_url: string | null; media_candidates: string[]; has_audio: boolean | null } {
  if (provider !== 'apify:esdrasdw/instagram-reels-scrapy-low-cost') return { media_source_url: null, media_candidates: [], has_audio: null };
  const values: unknown[] = [row.videoUrl];
  if (Array.isArray(row.videoVersions)) for (const version of row.videoVersions.slice(0, 10)) {
    if (version && typeof version === 'object' && !Array.isArray(version)) values.push((version as Record<string, unknown>).url);
  }
  const candidates = [...new Set(values.map(instagramMediaUrl).filter((url): url is string => url !== null))].slice(0, 4);
  return { media_source_url: candidates[0] ?? null, media_candidates: candidates, has_audio: typeof row.hasAudio === 'boolean' ? row.hasAudio : null };
}
export function identity(value: unknown, context: Context): CreatorRef {
  if (typeof value !== 'string') throw new Error('Provider identity missing');
  const username = value.toLowerCase().replace(/^@/, '');
  const creator = context.creators.find((c) => c.username === username);
  if (!creator) throw new Error('Provider creator mismatch');
  return creator;
}
function validTimestampCalendar(value: string): boolean {
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour <= 23 && minute <= 59 && second <= 59;
}
export function zonedTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !validTimestampCalendar(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export function timestampBasis(value: unknown): 'explicit_offset' | 'timezone_unverified' | 'invalid_or_missing' {
  if (zonedTimestamp(value)) return 'explicit_offset';
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/.test(value) && validTimestampCalendar(value) ? 'timezone_unverified' : 'invalid_or_missing';
}
export function publicationTimestamp(value: unknown): { instant: string | null; basis: 'explicit_offset' | 'assumed_Asia/Kolkata' | 'invalid_or_missing' } {
  const sourceBasis = timestampBasis(value);
  if (sourceBasis === 'explicit_offset') return { instant: zonedTimestamp(value), basis: 'explicit_offset' };
  if (sourceBasis === 'timezone_unverified') return { instant: zonedTimestamp(`${value}+05:30`), basis: 'assumed_Asia/Kolkata' };
  return { instant: null, basis: 'invalid_or_missing' };
}
export function normalizeReel(value: unknown, context: Context, provider: string): { record?: Normalized; error?: ProfileError } {
  const row = object(value);
  const creator = identity(row.ownerUsername, context);
  if (row.error || row.errorDescription) {
    const code = typeof row.error === 'string' && ['not_found', 'restricted', 'private', 'no_items'].includes(row.error) ? row.error : 'profile_error';
    return { error: { creator_id: creator.id, status: code === 'private' ? 'private' : code === 'not_found' || code === 'restricted' ? 'unavailable' : 'failed', message: `Provider reported ${code}; dataset error rows may be billable` } };
  }
  const url = publicUrl(row.url, true);
  const shortcode = url ? new URL(url).pathname.match(/^\/(?:reel|p)\/([A-Za-z0-9_-]{1,64})\/?$/)?.[1] : null;
  // An opaque numeric media ID is not interchangeable with an Instagram shortcode.
  if (!shortcode) return { error: { creator_id: creator.id, status: 'failed', message: 'Valid canonical Reel URL/shortcode missing' } };
  const { basis, instant: published } = publicationTimestamp(row.timestamp);
  if (basis === 'invalid_or_missing' || (published !== null && Date.parse(published) > Date.now() + 300000)) return { error: { creator_id: creator.id, status: 'failed', message: 'publish_timestamp_invalid: missing, invalid or future timestamp' } };
  const views = metric(row.videoPlayCount), likes = metric(row.likesCount), comments = metric(row.commentsCount);
  const caption = typeof row.caption === 'string' && row.caption.length <= 20_000 ? row.caption : null;
  return { record: {
    creator_id: creator.id, username: creator.username, fetched_at: context.job.result_fetched_at ?? context.job.started_at, provider,
    shortcode, instagram_media_id: typeof row.id === 'string' && /^\d{1,40}(?:_\d{1,40})?$/.test(row.id) ? row.id : null,
    reel_url: url, thumbnail_url: publicUrl(row.displayUrl),
    caption_preview: typeof row.title === 'string' ? row.title.slice(0, 500) : caption?.slice(0, 500) ?? '', caption_full: caption, published_at: published,
    published_at_raw: row.timestamp as string, published_at_basis: basis,
    ...reelMedia(row, provider),
    duration_seconds: typeof row.videoDuration === 'number' && Number.isFinite(row.videoDuration) && row.videoDuration >= 0 ? row.videoDuration : null,
    views: views.value, likes: likes.value, comments: comments.value,
    views_state: views.state, likes_state: likes.state, comments_state: comments.state,
  } };
}

/** Published Actor contract. Live use stays blocked until child media fields are pilot validated. */
export function normalizeCarousel(value: unknown, context: Context, provider: string): { record?: Normalized; error?: ProfileError } {
  const row=object(value),creator=identity(row.ownerUsername,context);
  if (row.error || row.errorDescription) return {error:{creator_id:creator.id,status:'failed',message:'Provider carousel error; existing records preserved'}};
  if (row.type!==8 && row.productType!=='carousel_container') {
    // The photos feed intentionally includes single images; reject unknown types rather than silently succeeding.
    if (row.type===1) return {};
    return {error:{creator_id:creator.id,status:'failed',message:'Unknown photo post type'}};
  }
  const url=publicUrl(row.url,true),shortcode=url ? new URL(url).pathname.match(/^\/p\/([A-Za-z0-9_-]{1,64})\/?$/)?.[1] : null;
  if (!shortcode) return {error:{creator_id:creator.id,status:'failed',message:'Canonical carousel URL missing'}};
  if (row.childPosts!==undefined && (!Array.isArray(row.childPosts) || row.childPosts.length>20)) throw new Error('Invalid carousel slides');
  const slides=(Array.isArray(row.childPosts) ? row.childPosts : []).map((item,index)=>{
    const child=object(item),mediaType=child.media_type ?? child.type,video=mediaType===2 || child.isVideo===true;
    return {position:index+1,media_type:video ? 'video' as const : mediaType===1 || child.isVideo===false ? 'image' as const : 'unknown' as const,
      image_url:instagramMediaUrl(child.thumb) ?? instagramMediaUrl(child.displayUrl),
      video_url:video ? instagramMediaUrl(child.url_video) ?? instagramMediaUrl(child.videoUrl) : null};
  });
  const likes=metric(row.likesCount),comments=metric(row.commentsCount),published=publicationTimestamp(row.timestamp);
  return {record:{content_type:'carousel',creator_id:creator.id,username:creator.username,fetched_at:context.job.result_fetched_at ?? context.job.started_at,provider,
    shortcode,reel_url:url,thumbnail_url:instagramMediaUrl(row.displayUrl),caption_full:typeof row.caption==='string' ? row.caption.slice(0,10000) : typeof row.title==='string' ? row.title.slice(0,10000) : null,
    published_at:published.instant,published_at_raw:typeof row.timestamp==='string' ? row.timestamp.slice(0,64) : null,
    published_at_basis:published.basis==='invalid_or_missing' ? 'timezone_unverified' : published.basis,
    likes:likes.value,comments:comments.value,likes_state:likes.state,comments_state:comments.state,slides}};
}

import type { CollectionCapacity, CollectionHold, CollectionHolds, CollectionJobRecovery, BillingSyncResult } from '../types';
import { z } from 'zod';
import type { CreatorCollectionSummary, CreatorDirectoryEntry, CarouselSummary, Carousel } from '../types';
import { safeCarousel } from './carousel-data';
import type { AppSettings, Bootstrap, Creator, Job, Overview, PageResult, Reel, ReelDetail, ReelProcessingReason, SavedReelFilter, ReelTranscript, TranscriptOverview, TranscriptSegment, TranscriptStatus, TranscriptionJob, Usage, Workspace } from '../types';
import { reelPlaybackUrl } from '../reel-detail';
import { reelQueryKeys, validateReelFilterQuery } from '../reel-filters';
import { ApiError } from './errors';
import { isTimedSegment, transcriptStatuses } from '../transcript';
import type { CreatorSourceRefresh, JobStatus } from '../types';
import type { ReelNeighbors } from '../types';
import { normalizeMetric, PROFILE_BASELINE_LIMIT, PROFILE_BASELINE_MINIMUM } from '../metrics';

import { collectionReasons, collectionJobStatuses } from '../collection-status';
import type { CreatorCollectionState } from '../types';

import type { ApifyAccountsStatus, ApifyAccountReason } from '../types';

import type { ProfileAutomationStatus } from '../types';

export function safeProfileAutomation(input: unknown): ProfileAutomationStatus {
  const value = record(input);
  const reasons: ProfileAutomationStatus['reason'][] = [null, 'disabled', 'setup_required', 'paused', 'scraping_disabled', 'concurrency_limit', 'unreconciled_charges', 'budget_paused', 'usage_unverified'];
  if (typeof value.enabled !== 'boolean' || typeof value.provider_validated !== 'boolean' || typeof value.paused !== 'boolean' || !reasons.includes(value.reason as ProfileAutomationStatus['reason']) ||
      value.interval_hours !== 24 || value.batch_limit !== 20 || ['due_creators', 'pending_jobs', 'active_jobs'].some(key => typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || Number(value[key]) < 0) ||
      ['last_fetch_at', 'next_due_at'].some(key => value[key] !== null && (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(String(value[key])))))) {
    throw new ApiError(503, 'INVALID_PROFILE_AUTOMATION_STATUS', 'Daily profile refresh status could not be loaded.');
  }
  return { enabled: value.enabled, provider_validated: value.provider_validated, paused: value.paused, reason: value.reason as ProfileAutomationStatus['reason'],
    interval_hours: 24, batch_limit: 20, due_creators: value.due_creators as number, pending_jobs: value.pending_jobs as number, active_jobs: value.active_jobs as number,
    last_fetch_at: publicDate(value.last_fetch_at), next_due_at: publicDate(value.next_due_at) };
}

export function safeApifyAccounts(input: unknown): ApifyAccountsStatus {
  const value = record(input);
  const reasons: (ApifyAccountReason | null)[] = [null, 'disabled', 'setup_required', 'usage_unverified', 'unreconciled_charges', 'allowance_exhausted', 'account_capacity_full'];
  const nonnegative = (item: unknown) => typeof item === 'number' && Number.isFinite(item) && item >= 0;
  const date = (item: unknown) => item === null || typeof item === 'string' && Number.isFinite(Date.parse(item));
  if (!Array.isArray(value.accounts) || ![3, 5].includes(value.accounts.length) || !Number.isSafeInteger(value.ready_accounts) || Number(value.ready_accounts) < 0 || Number(value.ready_accounts) > value.accounts.length) throw new ApiError(503, 'INVALID_ACCOUNT_STATUS', 'Provider account status could not be loaded.');
  const accounts = value.accounts.map(item => {
    const row = record(item);
    if (![1, 2, 3, 4, 5].includes(Number(row.slot)) || typeof row.slot !== 'number' || typeof row.enabled !== 'boolean' || typeof row.configured !== 'boolean' || !reasons.includes(row.reason as ApifyAccountReason | null) ||
        row.usage_usd !== null && !nonnegative(row.usage_usd) || row.limit_usd !== null && !nonnegative(row.limit_usd) ||
        !nonnegative(row.reserved_usd) || !Number.isSafeInteger(row.unreconciled_jobs) || Number(row.unreconciled_jobs) < 0 || !date(row.usage_checked_at) || !date(row.cycle_end_at)) throw new ApiError(503, 'INVALID_ACCOUNT_STATUS', 'Provider account status could not be loaded.');
    return { slot: row.slot as 1 | 2 | 3 | 4 | 5, label: `Account ${row.slot}`, enabled: row.enabled, configured: row.configured,
      reason: row.reason as ApifyAccountReason | null, usage_usd: row.usage_usd as number | null, limit_usd: row.limit_usd as number | null,
      usage_checked_at: publicDate(row.usage_checked_at), cycle_end_at: publicDate(row.cycle_end_at), reserved_usd: row.reserved_usd as number, unreconciled_jobs: row.unreconciled_jobs as number,
      ...(row.risk_released_exposure_usd !== undefined && nonnegative(row.risk_released_exposure_usd) ? { risk_released_exposure_usd: row.risk_released_exposure_usd as number } : {}),
      ...(row.monthly_report !== undefined ? { monthly_report: safeMonthlyReport(row.monthly_report) } : {}) };
  }).sort((a, b) => a.slot - b.slot);
  if (new Set(accounts.map(account => account.slot)).size !== value.accounts.length || accounts.some((account, index) => account.slot !== index + 1) || accounts.filter(account => account.reason === null).length !== value.ready_accounts ||
      accounts.some(account => account.reason === null && (!account.enabled || !account.configured))) throw new ApiError(503, 'INVALID_ACCOUNT_STATUS', 'Provider account status could not be loaded.');
  return { accounts, ready_accounts: value.ready_accounts as number, ...(value.capacity !== undefined ? { capacity: safeCollectionCapacity(value.capacity) } : {}) };
}

function safeMonthlyReport(input: unknown): import('../types').ApifyMonthlyReport | null {
  if (input === null) return null;
  const schema = z.object({ source: z.literal('apify_monthly_usage'), cycle_start_at: readDate.refine(Boolean), cycle_end_at: readDate.refine(Boolean),
    checked_at: readDate.refine(Boolean), before_discount_usd: z.number().finite().min(0).max(999999), after_discount_usd: z.number().finite().min(0).max(999999),
    service_amounts: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/), z.number().finite().min(0).max(999999).nullable()).refine(value => Object.keys(value).length <= 100),
  });
  const value = readDto(schema, selectedRead(schema, input), 'INVALID_MONTHLY_REPORT');
  if (Date.parse(value.cycle_start_at!) >= Date.parse(value.cycle_end_at!)) throw new ApiError(503, 'INVALID_MONTHLY_REPORT', 'Monthly usage could not be loaded.');
  return { ...value, cycle_start_at: value.cycle_start_at!, cycle_end_at: value.cycle_end_at!, checked_at: value.checked_at! };
}

import type { CarouselCollectionStatus } from '../types';

export function safeCarouselCollectionStatus(input: unknown): CarouselCollectionStatus {
  const value = record(input);
  if (typeof value.enabled !== 'boolean' || typeof value.provider_validated !== 'boolean' || typeof value.paused !== 'boolean' ||
      ![null, 'disabled', 'setup_required', 'paused', 'scraping_disabled'].includes(value.reason as CarouselCollectionStatus['reason']) ||
      !Number.isSafeInteger(value.pending_jobs) || Number(value.pending_jobs) < 0 || !Number.isSafeInteger(value.active_jobs) || Number(value.active_jobs) < 0 ||
      value.interval_hours !== 24 || value.window_limit !== 30 || ['last_fetch_at', 'next_due_at'].some(key => value[key] !== null && (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(String(value[key])))))) throw new ApiError(503, 'INVALID_COLLECTION_STATUS', 'Carousel collection status could not be loaded.');
  return { enabled: value.enabled, provider_validated: value.provider_validated, paused: value.paused, reason: value.reason as CarouselCollectionStatus['reason'],
    pending_jobs: value.pending_jobs as number, active_jobs: value.active_jobs as number, last_fetch_at: publicDate(value.last_fetch_at), next_due_at: publicDate(value.next_due_at), interval_hours: 24, window_limit: 30 };
}

export function safeCollectionState(input: unknown): CreatorCollectionState {
  const value = record(input);
  const ids = (items: unknown) => Array.isArray(items) && items.every(publicId);
  if (value.reason !== null && !collectionReasons.some(reason => reason === value.reason) ||
      value.blocking_job_id !== null && !publicId(value.blocking_job_id) || !ids(value.pending_job_ids) || !ids(value.active_job_ids) ||
      !Array.isArray(value.profiles) || value.profiles.some(item => {
        const row = record(item);
        return !publicId(row.creator_id) || !publicId(row.job_id) || !collectionJobStatuses.includes(row.status as JobStatus);
      })) throw new ApiError(503, 'INVALID_COLLECTION_STATE', 'Collection status could not be loaded.');
  return {
    reason: value.reason as CreatorCollectionState['reason'], blocking_job_id: value.blocking_job_id as string | null,
    pending_job_ids: [...new Set(value.pending_job_ids as string[])], active_job_ids: [...new Set(value.active_job_ids as string[])],
    profiles: value.profiles.map(item => { const row = record(item); return { creator_id: row.creator_id as string, job_id: row.job_id as string, status: row.status as JobStatus }; }),
    ...(value.account_info !== undefined ? { account_info: safeApifyAccounts(value.account_info) } : {}),
  };
}

const readId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const readDate = z.string().refine(value => publicDate(value) !== null).nullable();
const readCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const readMetric = z.number().finite().min(0).nullable();
const creatorStatus = z.enum(['active', 'pending', 'unavailable', 'private', 'failed', 'paused']);
const jobStatus = z.enum(collectionJobStatuses);
const capacityReadSchema = z.object({ occupied_slots: readCount, uncertain_slots: readCount, max_active: readCount.refine(value => value > 0), paid_starts_gated: z.boolean() }).strict();
export function safeCollectionCapacity(input: unknown): CollectionCapacity {
  const value = readDto(capacityReadSchema, selectedRead(capacityReadSchema, input), 'INVALID_COLLECTION_CAPACITY');
  if (value.uncertain_slots > value.occupied_slots) throw new ApiError(503, 'INVALID_COLLECTION_CAPACITY', 'Collection capacity could not be loaded.');
  return value;
}
const holdReadSchema = z.object({
  id: readId, kind: z.enum(['daily', 'weekly', 'backfill', 'profile', 'manual', 'retry', 'discovery', 'metrics', 'carousel']), status: jobStatus,
  account_slot: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).nullable(),
  reserved_usd: z.number().finite().min(0), claimed_cap_usd: readMetric, reservation_started_at: readDate, uncertain_since: readDate,
  dispatch_phase: z.enum(['legacy', 'prepared', 'submission_authorized', 'request_unknown', 'accepted_save_pending', 'attached', 'cancelled_before_submit']),
  operational_disposition: z.enum(['protected', 'risk_released']), actual_cost_usd: readMetric,
  recovery_reason: z.string().max(1000).nullable(), recovery_attempts: readCount, expected_version: readCount,
  creators: z.array(z.object({ id: readId, username: z.string().regex(/^[a-z0-9_.]{1,30}$/i) }).strict()).max(1000),
}).strict();
const recoveryReasonLabels: Record<string, string> = {
  historical_submission_unknown: 'Historical submission outcome is unknown.',
  submission_unknown: 'Provider acceptance could not be confirmed.', request_unknown: 'Provider acceptance could not be confirmed.',
  accepted_save_pending: 'An accepted run is awaiting local attachment.',
  reconciliation_required: 'Authoritative provider billing is still required.',
};
export function safeCollectionHold(input: unknown): CollectionHold {
  const raw = record(input);
  const selected = selectedRead(holdReadSchema, raw);
  if (Array.isArray(raw.creators)) selected.creators = raw.creators.map(item => { const row = record(item); return { id: row.id, username: row.username }; });
  const value = readDto(holdReadSchema, selected, 'INVALID_COLLECTION_HOLD');
  return { ...value, recovery_reason: value.recovery_reason === null ? null : recoveryReasonLabels[value.recovery_reason] ?? 'Recovery or authoritative billing review is required.' };
}
export function safeCollectionHolds(input: unknown): CollectionHolds {
  const row = record(input);
  const page = researchPage(row, safeCollectionHold);
  const schema = z.object({ reconciled_month_spend_usd: z.number().finite().min(0), risk_released_exposure_usd: z.number().finite().min(0) }).strict();
  return { ...page, capacity: safeCollectionCapacity(row.capacity), usage: readDto(schema, selectedRead(schema, row.usage), 'INVALID_COLLECTION_USAGE') };
}
export function safeCollectionJobRecovery(input: unknown): CollectionJobRecovery {
  const row = record(input);
  if (!Array.isArray(row.audit) || row.audit.length > 100) throw new ApiError(503, 'INVALID_COLLECTION_RECOVERY', 'Collection recovery could not be loaded.');
  const schema = z.object({ created_at: readDate.refine(value => value !== null), outcome: z.enum(['risk_release', 'verified_no_start']), released_usd: z.number().finite().min(0), reason: z.string().max(1000) }).strict();
  return { ...safeCollectionHold(row), audit: row.audit.map(item => readDto(schema, selectedRead(schema, item), 'INVALID_COLLECTION_RECOVERY')) as CollectionJobRecovery['audit'] };
}
export function safeBillingSync(input: unknown): BillingSyncResult {
  const row = record(input), sync = record(row.sync);
  const accountSchema = z.object({ accountSlot: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]), enabled: z.boolean(), success: z.boolean(), syncedAt: readDate,
    error: z.enum(['usage_unverified', 'usage_persistence_failed']).nullable(), monthlyReportSyncedAt: readDate.optional(), monthlyReportError: z.literal('monthly_report_unavailable').nullable().optional() }).strict();
  const runsSchema = z.object({ checked: readCount, reconciled: readCount, unknown: readCount, failed: readCount }).strict();
  if (sync.paidStarts !== 0 || !Array.isArray(sync.accounts) || sync.accounts.length > 5) throw new ApiError(503, 'INVALID_BILLING_SYNC', 'Billing status could not be confirmed. Refresh stored status before checking again.');
  const accounts = sync.accounts.map(item => readDto(accountSchema, selectedRead(accountSchema, item), 'INVALID_BILLING_SYNC'));
  if (new Set(accounts.map(account => account.accountSlot)).size !== accounts.length) throw new ApiError(503, 'INVALID_BILLING_SYNC', 'Billing status could not be confirmed.');
  return { sync: { accounts, runs: readDto(runsSchema, selectedRead(runsSchema, sync.runs), 'INVALID_BILLING_SYNC'), paidStarts: 0,
    syncedAt: readDto(readDate.refine(value => value !== null), sync.syncedAt, 'INVALID_BILLING_SYNC')! } };
}
const directoryShape = {
  id: readId, username: z.string().regex(/^[a-z0-9_.]{1,30}$/i), display_name: z.string().nullable(),
  avatar_url: z.string().nullable(), status: creatorStatus,
};
const directoryReadSchema = z.object(directoryShape).strict();
const creatorReadSchema = z.object({
  ...directoryShape, followers_count: readMetric, last_profile_fetch_at: readDate, last_reels_fetch_at: readDate,
  last_error: z.string().nullable(), tracked_reels: readCount, tracked_carousels: readCount.optional(), latest_reel_date: readDate,
  initial_backfill_job_id: readId.nullable(), initial_backfill_status: jobStatus.nullable(),
  profile_job_status: jobStatus.optional(),
}).strict();
function readDto<T>(schema: z.ZodType<T>, input: unknown, code: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApiError(503, code, 'Research data could not be loaded.');
  return parsed.data;
}
function selectedRead(schema: z.ZodObject, input: unknown): Record<string, unknown> {
  const row = record(input);
  return Object.fromEntries(Object.keys(schema.shape).filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
}
function researchPage<T>(input: unknown, item: (value: unknown) => T): PageResult<T> {
  const row = record(input);
  const metadata = readDto(z.object({ total: readCount, page: z.number().int().min(1).max(10_000), limit: z.number().int().min(1).max(50) }).strict(),
    { total: row.total, page: row.page, limit: row.limit }, 'INVALID_RESEARCH_PAGE');
  if (!Array.isArray(row.items) || row.items.length !== Math.min(metadata.limit, Math.max(0, metadata.total - (metadata.page - 1) * metadata.limit))) {
    throw new ApiError(503, 'INVALID_RESEARCH_PAGE', 'Research data could not be loaded.');
  }
  return { items: row.items.map(item), ...metadata };
}
export function safeCreatorRead(input: unknown): Creator {
  return safeCreator(readDto(creatorReadSchema, selectedRead(creatorReadSchema, input), 'INVALID_CREATOR_DATA'));
}
export function safeCreatorPage(input: unknown): PageResult<Creator> {
  return researchPage(input, safeCreatorRead);
}
export function safeCreatorDirectory(input: unknown): CreatorDirectoryEntry[] {
  if (!Array.isArray(input)) throw new ApiError(503, 'INVALID_CREATOR_DIRECTORY', 'Competitor directory could not be loaded.');
  return input.map(row => readDto(directoryReadSchema, selectedRead(directoryReadSchema, row), 'INVALID_CREATOR_DIRECTORY'));
}
export function safeCollectionSummary(input: unknown): CreatorCollectionSummary {
  const schema = z.object({ reason: z.enum(collectionReasons).nullable(), blocking_job_id: readId.nullable(), pending_jobs: readCount, active_jobs: readCount }).strict();
  return readDto(schema, selectedRead(schema, input), 'INVALID_COLLECTION_SUMMARY');
}
const carouselSummaryReadSchema = z.object({
  id: readId, creator_id: readId, shortcode: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), post_url: z.string().nullable(), thumbnail_url: z.string().nullable(),
  caption_preview: z.string().refine(value => Array.from(value).length <= 500), slide_count: z.number().int().min(0).max(20), published_at: readDate, published_at_raw: z.string().nullable(),
  published_at_basis: z.enum(['explicit_offset', 'timezone_unverified', 'assumed_Asia/Kolkata']),
  latest_likes: readMetric, latest_comments: readMetric, likes_state: z.enum(['known', 'hidden', 'not_fetched', 'unavailable']), comments_state: z.enum(['known', 'hidden', 'not_fetched', 'unavailable']),
  latest_fetched_at: readDate.refine(value => value !== null), provider: z.string(), username: directoryShape.username,
  display_name: z.string().nullable(), avatar_url: z.string().nullable(), followers_count: readMetric, follower_captured_at: readDate,
  saved: z.boolean(), note: z.string().max(4000), tags: z.array(z.string().max(40)).max(20),
  interactions: readMetric, follower_engagement_pct: readMetric, follower_outlier_score: readMetric, profile_outlier_score: readMetric,
  profile_baseline_interactions: readMetric, profile_baseline_sample: z.number().int().min(0).max(30),
}).strict();
export function safeCarouselSummary(input: unknown): CarouselSummary {
  const row = readDto(carouselSummaryReadSchema, selectedRead(carouselSummaryReadSchema, input), 'INVALID_CAROUSEL_DATA');
  if ((row.likes_state === 'known') !== (row.latest_likes !== null) || (row.comments_state === 'known') !== (row.latest_comments !== null)) {
    throw new ApiError(503, 'INVALID_CAROUSEL_DATA', 'Carousel data could not be loaded.');
  }
  // Reuse centralized metric/media sanitization, without fabricating slides or a count.
  const sanitized = safeCarousel({ ...row, caption: row.caption_preview, slides: [] } as Carousel);
  return { ...pick(sanitized, ['id', 'creator_id', 'shortcode', 'post_url', 'thumbnail_url', 'published_at', 'published_at_raw', 'published_at_basis',
    'latest_likes', 'latest_comments', 'likes_state', 'comments_state', 'latest_fetched_at', 'provider', 'username', 'display_name', 'avatar_url', 'followers_count',
    'follower_captured_at', 'saved', 'note', 'tags', 'interactions', 'follower_engagement_pct', 'follower_outlier_score', 'profile_outlier_score', 'profile_baseline_interactions', 'profile_baseline_sample']),
    caption_preview: row.caption_preview, slide_count: row.slide_count };
}
export function safeCarouselSummaryPage(input: unknown): PageResult<CarouselSummary> {
  return researchPage(input, safeCarouselSummary);
}

function pick<T, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map(key => [key, value[key]])) as Pick<T, K>;
}
export function safeWorkspace(value: Workspace): Workspace {
  return pick(value, ['id', 'name', 'slug', 'created_at', 'archived_at']);
}
export function safeCreator(value: Creator): Creator {
  return { ...pick(value, ['id', 'username', 'display_name', 'avatar_url', 'followers_count', 'last_profile_fetch_at', 'status', 'last_reels_fetch_at', 'tracked_reels', 'latest_reel_date', 'initial_backfill_job_id', 'initial_backfill_status']),
    ...(Object.hasOwn(value, 'tracked_carousels') ? { tracked_carousels: readDto(readCount, value.tracked_carousels, 'INVALID_CREATOR_DATA') } : {}),
    ...(value.profile_job_status !== undefined && collectionJobStatuses.includes(value.profile_job_status) ? { profile_job_status: value.profile_job_status } : {}),
    ...(Array.isArray(value.profile_job_ids) ? { profile_job_ids: value.profile_job_ids.filter(publicId).slice(0, 50) } : {}),
    last_error: value.last_error ? 'The last provider update failed. Existing data has been preserved.' : null };
}
export function safeReel(value: Reel): Reel {
  const sample = value.published_at && Number.isFinite(Date.parse(value.published_at)) && Number.isInteger(value.profile_baseline_sample) && value.profile_baseline_sample >= 0 && value.profile_baseline_sample <= PROFILE_BASELINE_LIMIT ? value.profile_baseline_sample : 0;
  const baseline = sample >= PROFILE_BASELINE_MINIMUM ? normalizeMetric(value.profile_baseline_views) : null;
  return { ...pick(value, ['id', 'creator_id', 'shortcode', 'reel_url', 'thumbnail_url', 'caption_preview', 'published_at', 'published_at_raw', 'published_at_basis', 'duration_seconds', 'latest_views', 'latest_likes', 'latest_comments', 'views_state', 'likes_state', 'comments_state', 'latest_fetched_at', 'first_seen_at', 'provider', 'username', 'display_name', 'avatar_url', 'followers_count', 'follower_captured_at', 'creator_status', 'engagement_rate_pct', 'saved', 'note', 'tags']),
    profile_outlier_score: value.views_state === 'known' && normalizeMetric(value.latest_views) !== null && baseline !== null && baseline > 0 ? normalizeMetric(value.profile_outlier_score) : null,
    profile_baseline_views: baseline, profile_baseline_sample: sample,
    completion_status: value.saved && value.completion_status === 'done' ? 'done' : 'pending', ...(value.platform === 'instagram' ? { platform: value.platform } : {}), follower_outlier_score: value.followers_count !== null && Number.isFinite(value.followers_count) && value.followers_count > 0 ? value.follower_outlier_score : null };
}
export function safeReelNeighbors(input: unknown): ReelNeighbors {
  const value = record(input);
  if (!Number.isSafeInteger(value.total) || Number(value.total)<0 || value.position !== null && (!Number.isSafeInteger(value.position) || Number(value.position)<1 || Number(value.position)>Number(value.total)) ||
    ['previous_id','next_id'].some(key => value[key] !== null && !publicId(value[key]))) throw new ApiError(503, 'INVALID_REEL_DATA', 'Reel navigation could not be loaded.');
  return { previous_id: value.previous_id as string | null, next_id: value.next_id as string | null, position: value.position as number | null, total: value.total as number };
}
export function safeReelDetail(input: unknown): ReelDetail {
  const value = record(input), reel = record(value.reel), media = record(value.media), processing = record(value.processing);
  if (!publicId(reel.id) || !publicId(reel.creator_id)) throw new ApiError(503, 'INVALID_REEL_DATA', 'Reel details could not be loaded.');
  const reasons: readonly ReelProcessingReason[] = ['setup_required', 'paused', 'budget_paused', 'media_recovery_disabled', 'creator_unavailable', 'review_required', 'provider_review_required', 'retry_limit_reached', 'demo'];
  const reason = reasons.includes(processing.reason as ReelProcessingReason) ? processing.reason as ReelProcessingReason : processing.reason === null ? null : 'setup_required';
  const rawEstimate = record(processing.estimate);
  const min = rawEstimate.min_seconds, max = rawEstimate.max_seconds, samples = rawEstimate.sample_count, date = publicDate(rawEstimate.estimated_at);
  const estimate = typeof min === 'number' && typeof max === 'number' && Number.isSafeInteger(min) && Number.isSafeInteger(max) && min >= 1 && max >= min && max <= 86_400 && typeof samples === 'number' && Number.isSafeInteger(samples) && samples >= 5 && samples <= 50 && date
    ? { min_seconds: min, max_seconds: max, sample_count: samples, estimated_at: date } : null;
  const transcript = safeTranscript(value.transcript);
  const retryAttemptId = transcript.status === 'uncertain' && ['review_required', 'provider_review_required', 'paused', 'budget_paused', null].includes(reason) ? publicId(processing.retry_attempt_id) || null : null;
  if (transcript.reel_id !== reel.id) throw new ApiError(503, 'INVALID_REEL_DATA', 'Reel details could not be loaded.');
  return {
    reel: safeReel(reel as unknown as Reel),
    caption_full: typeof value.caption_full === 'string' && value.caption_full.length <= 20_000 ? value.caption_full : null,
    media: { urls: [...new Set((Array.isArray(media.urls) ? media.urls.slice(0, 16) : []).map(reelPlaybackUrl).filter((url): url is string => url !== null))].slice(0, 4), observed_at: publicDate(media.observed_at) },
    transcript,
    processing: { request_allowed: !['demo','creator_unavailable','review_required','retry_limit_reached'].includes(reason ?? '') && processing.request_allowed === true && ['not_requested', 'awaiting_media', 'queued', 'budget_paused', 'failed', 'media_unavailable'].includes(transcript.status) && (reason !== 'provider_review_required' || ['not_requested', 'awaiting_media', 'queued', 'budget_paused'].includes(transcript.status)), reason,
      estimate: reason === null && ['queued', 'submitting', 'processing'].includes(transcript.status) ? estimate : null,
      priority: processing.priority === 'high' ? 'high' : 'normal',
      retry_attempt_id: retryAttemptId,
      queue_position: Number.isSafeInteger(processing.queue_position) && Number(processing.queue_position)>0 ? Number(processing.queue_position) : null,
      retry_after_seconds: Number.isSafeInteger(processing.retry_after_seconds) && Number(processing.retry_after_seconds)>=0 ? Number(processing.retry_after_seconds) : 0 },
  };
}
export function safeJob(value: Job): Job {
  const statusErrors: Partial<Record<JobStatus, string>> = {
    failed: 'This collection failed. Existing data has been preserved.',
    partial: 'Only part of this collection completed. Existing data has been preserved.',
    budget_paused: 'This collection is on a budget hold. A reservation is not a billed charge.',
    uncertain: 'Submission may have been accepted and billed. Review is required before another paid attempt.',
  };
  return { ...pick(value, ['id', 'kind', 'status', 'scheduled_for', 'started_at', 'completed_at', 'actor_run_id', 'requested_profiles_count', 'returned_records_count', 'estimated_cost_usd', 'actual_cost_usd', 'attempt_count', 'results_limit', 'discovery_bounded', 'metrics_tracked_count']),
    ...([1, 2, 3, 4, 5].includes(value.apify_account_slot ?? 0) ? { apify_account_slot: value.apify_account_slot } : {}),
    ...(value.operational_disposition === 'risk_released' || value.operational_disposition === 'protected' ? { operational_disposition: value.operational_disposition } : {}),
    ...(['legacy', 'prepared', 'submission_authorized', 'request_unknown', 'accepted_save_pending', 'attached', 'cancelled_before_submit'].includes(value.dispatch_phase ?? '') ? { dispatch_phase: value.dispatch_phase } : {}),
    error_message: value.error_message ? statusErrors[value.status] ?? 'This update encountered a provider or processing error. Existing data has been preserved.' : null };
}
export function safeCreatorSourceRefresh(input: unknown): CreatorSourceRefresh | null {
  if (input === null) return null;
  const value = record(input);
  const statuses: JobStatus[] = ['pending', 'dispatching', 'running', 'processing', 'succeeded', 'partial', 'failed', 'budget_paused', 'uncertain'];
  const keys = ['results_limit', 'returned_reels', 'missing_reels', 'missing_captions', 'missing_media'] as const;
  if (!publicId(value.job_id) || !statuses.includes(value.status as JobStatus) ||
      keys.some(key => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0 || Number(value[key]) > 100) ||
      value.expected_reels !== null && (!Number.isSafeInteger(value.expected_reels) || Number(value.expected_reels) < 0 || Number(value.expected_reels) > 100) ||
      !Array.isArray(value.missing) || value.missing.length > 100) throw new ApiError(503, 'INVALID_SOURCE_REPORT', 'Collection coverage could not be loaded.');
  return {
    job_id: value.job_id as string, status: value.status as JobStatus, source_refresh: value.source_refresh === true,
    results_limit: value.results_limit as number, coverage_recorded: value.coverage_recorded === true,
    expected_reels: value.expected_reels as number | null, returned_reels: value.returned_reels as number,
    missing_reels: value.missing_reels as number, missing_captions: value.missing_captions as number, missing_media: value.missing_media as number,
    completed_at: publicDate(value.completed_at),
    missing: value.missing.map(item => {
      const row = record(item);
      if (!publicId(row.reel_id) || typeof row.shortcode !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(row.shortcode)) throw new ApiError(503, 'INVALID_SOURCE_REPORT', 'Collection coverage could not be loaded.');
      return { reel_id: row.reel_id as string, shortcode: row.shortcode, not_returned: row.not_returned === true, caption_missing: row.caption_missing === true, media_missing: row.media_missing === true };
    }),
  };
}
export function safeSettings(value: AppSettings): AppSettings {
  return { ...pick(value, ['daily_limit', 'weekly_limit', 'monthly_budget_usd', 'budget_warning_pct', 'paused', 'timezone', 'capacity', 'scraping_enabled', 'initial_backfill_enabled']),
    ...(value.collection_job_cap_usd !== undefined ? { collection_job_cap_usd: readDto(z.number().finite().min(0).max(10_000), value.collection_job_cap_usd, 'INVALID_COLLECTION_CAP') } : {}), initial_backfill_limit: 100 };
}
export function safeUsage(value: Usage): Usage {
  return { ...pick(value, ['estimated_month_spend', 'actual_month_spend', 'reserved_usd', 'unreconciled_jobs', 'remaining_allowance', 'provider_usage_usd', 'provider_limit_usd', 'provider_cycle_start_at', 'provider_cycle_end_at', 'provider_usage_checked_at']),
    ...(value.reconciled_month_spend_usd !== undefined ? { reconciled_month_spend_usd: readDto(z.number().finite().min(0), value.reconciled_month_spend_usd, 'INVALID_COLLECTION_USAGE') } : {}),
    ...(value.risk_released_exposure_usd !== undefined ? { risk_released_exposure_usd: readDto(z.number().finite().min(0), value.risk_released_exposure_usd, 'INVALID_COLLECTION_USAGE') } : {}), provider_balance_usd: null };
}
export function safeBootstrap(value: Bootstrap): Bootstrap {
  return { mode: value.mode, email: value.email, workspaces: value.workspaces.map(safeWorkspace), settings: safeSettings(value.settings), usage: safeUsage(value.usage), jobs: value.jobs.map(safeJob), ...(value.collection_capacity !== undefined ? { collection_capacity: safeCollectionCapacity(value.collection_capacity) } : {}) };
}
export function safePage(value: PageResult<Reel>): PageResult<Reel> {
  return { items: value.items.map(safeReel), total: value.total, page: value.page, limit: value.limit };
}
export function safeOverview(value: Overview): Overview {
  return { ...pick(value, ['active_competitors', 'tracked_reels', 'outliers', 'average_engagement', 'last_refresh', 'stale_reels']), leaderboard: value.leaderboard.map(row => ({ creator: safeCreator(row.creator), outliers: row.outliers, best_score: row.best_score })), recent: value.recent.map(safeReel) };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function transcriptStatus(value: unknown): TranscriptStatus {
  return transcriptStatuses.includes(value as TranscriptStatus) ? value as TranscriptStatus : 'uncertain';
}
function publicId(value: unknown): string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : '';
}
function publicDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function amount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function transcriptError(value: unknown, status: TranscriptStatus): string | null {
  if (value && status === 'media_unavailable') return 'Video or audio download failed before transcription. An available retry checks the stored links again.';
  return value && ['failed', 'uncertain', 'media_unavailable'].includes(status) ? 'Transcription encountered an error. Check job status or contact the administrator; viewing will not submit another job.' : null;
}

export function safeReelFilter(input: unknown): SavedReelFilter {
  const value = record(input), config = record(value.config), rawQuery = record(config.query);
  try {
    if (config.version !== 1 || !publicId(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 || !publicDate(value.created_at)) throw new Error('Invalid preset.');
    const query = validateReelFilterQuery(Object.fromEntries(reelQueryKeys.filter(key => Object.hasOwn(rawQuery, key)).map(key => [key, rawQuery[key]])));
    return { id: publicId(value.id), name: value.name, config: { version: 1, query }, created_at: publicDate(value.created_at)! };
  } catch { throw new ApiError(503, 'INVALID_FILTER_DATA', 'Saved reel filters could not be loaded.'); }
}

/** Explicit public contract: never spread RPC rows or expose source/provider identifiers. */
export function safeTranscript(input: unknown): ReelTranscript {
  const value = record(input);
  const status = transcriptStatus(value.status);
  const candidates = Array.isArray(value.segments) ? value.segments.slice(0, 5_000) : [];
  let remaining = 200_000;
  // Malformed timing disables timed output rather than silently exporting partial/guessed cues.
  const segments: TranscriptSegment[] = status === 'ready' && candidates.every(isTimedSegment) ? candidates.flatMap(segment => {
    if (!remaining) return [];
    const text = segment.text.slice(0, remaining);
    remaining -= text.length;
    return text.trim() ? [{ start_ms: segment.start_ms, end_ms: segment.end_ms, text }] : [];
  }) : [];
  return {
    reel_id: publicId(value.reel_id), status,
    text: status === 'ready' && typeof value.text === 'string' ? value.text.slice(0, 200_000) : null,
    language: typeof value.language === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(value.language) ? value.language : null,
    segments, model: value.model === 'scribe_v2' ? 'scribe_v2' : null,
    completed_at: publicDate(value.completed_at), error_message: transcriptError(value.error_message, status),
  };
}

export function safeTranscriptionOverview(input: unknown): TranscriptOverview {
  const value = record(input);
  const jobs: TranscriptionJob[] = Array.isArray(value.jobs) ? value.jobs.slice(0, 100).map(input => {
    const job = record(input);
    return {
      id: publicId(job.id), reel_id: publicId(job.reel_id),
      username: typeof job.username === 'string' && /^[a-z0-9_.]{1,30}$/i.test(job.username) ? job.username : 'unknown',
      status: transcriptStatus(job.status), attempt_count: count(job.attempt_count),
      created_at: publicDate(job.created_at) ?? '', completed_at: publicDate(job.completed_at), error_message: transcriptError(job.error_message, transcriptStatus(job.status)),
    };
  }) : [];
  const jobCounts: Partial<Record<TranscriptStatus, number>> = {};
  const completeCounts = value.job_counts !== null && typeof value.job_counts === 'object' && !Array.isArray(value.job_counts);
  if (completeCounts) {
    const rawCounts = record(value.job_counts);
    for (const status of transcriptStatuses) if (Object.hasOwn(rawCounts, status)) jobCounts[status] = count(rawCounts[status]);
  } else {
    for (const job of jobs) jobCounts[job.status] = (jobCounts[job.status] ?? 0) + 1;
  }
  const warning = typeof value.budget_warning_pct === 'number' && Number.isInteger(value.budget_warning_pct) && value.budget_warning_pct >= 1 && value.budget_warning_pct <= 100 ? value.budget_warning_pct : 80;
  const accounted = amount(value.accounted_month_spend ?? value.estimated_month_spend);
  return {
    enabled: value.enabled === true, paused: value.paused !== false,
    monthly_budget_usd: amount(value.monthly_budget_usd), pilot_limit_usd: amount(value.pilot_limit_usd),
    phase: value.phase === 'automatic' ? 'automatic' : 'pilot',
    estimated_month_spend: amount(value.estimated_month_spend), reserved_usd: amount(value.reserved_usd),
    // No authoritative speech-invoice reconciliation contract exists yet.
    actual_month_spend: null,
    unreconciled_jobs: count(value.unreconciled_jobs), jobs,
    budget_warning_pct: warning, accounted_month_spend: accounted, job_counts: jobCounts, job_counts_complete: completeCounts,
    spending_warning: value.spending_warning === true || accounted + amount(value.reserved_usd) >= amount(value.monthly_budget_usd) * warning / 100,
    ...(typeof value.preferences_editable === 'boolean' ? { preferences_editable: value.preferences_editable } : {}),
    ...(typeof value.pilot_verified === 'boolean' ? { pilot_verified: value.pilot_verified } : {}),
    ...(typeof value.account_pricing_validated === 'boolean' ? { account_pricing_validated: value.account_pricing_validated } : {}),
    ...(typeof value.processing_ready === 'boolean' ? { processing_ready: value.processing_ready && value.enabled === true && value.paused === false } : {}),
  };
}

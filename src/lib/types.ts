export type CreatorStatus = 'active' | 'pending' | 'unavailable' | 'private' | 'failed' | 'paused';
export type JobStatus = 'pending' | 'dispatching' | 'running' | 'processing' | 'succeeded' | 'partial' | 'failed' | 'budget_paused' | 'uncertain';
export type InitialBackfillStatus = JobStatus | 'not_queued' | 'disabled' | 'blocked';
export type QueueProcessing = 'queued' | 'configuration_required' | 'blocked' | 'in_progress';
export type CollectionReason = 'unreconciled_charges' | 'scraping_disabled' | 'initial_import_disabled' | 'usage_unverified' | 'budget_paused' | 'concurrency_limit';
export interface CreatorCollectionState {
  reason: CollectionReason | null; blocking_job_id: string | null;
  pending_job_ids: string[]; active_job_ids: string[];
  profiles: { creator_id: string; job_id: string; status: JobStatus }[];
  account_info?: ApifyAccountsStatus;
}
export interface CreatorCollectionSummary {
  reason: CollectionReason | null; blocking_job_id: string | null;
  pending_jobs: number; active_jobs: number;
}
export type ApifyAccountReason = 'disabled' | 'setup_required' | 'usage_unverified' | 'unreconciled_charges' | 'allowance_exhausted' | 'account_capacity_full';
export interface ApifyAccountStatus {
  slot: 1 | 2 | 3 | 4 | 5; label: string; enabled: boolean; configured: boolean; reason: ApifyAccountReason | null;
  usage_usd: number | null; limit_usd: number | null; usage_checked_at: string | null; cycle_end_at: string | null;
  reserved_usd: number; unreconciled_jobs: number;
  occupied_slots?: number; uncertain_slots?: number; max_active?: number;
  risk_released_exposure_usd?: number; usage_error?: 'usage_check_failed' | null;
  monthly_report?: ApifyMonthlyReport | null;
}
export interface ApifyMonthlyReport {
  source: 'apify_monthly_usage'; cycle_start_at: string; cycle_end_at: string; checked_at: string;
  before_discount_usd: number; after_discount_usd: number; service_amounts: Record<string, number | null>;
}
export interface ApifyAccountsStatus { accounts: ApifyAccountStatus[]; ready_accounts: number; capacity?: CollectionCapacity }
export interface CollectionCapacity {
  occupied_slots: number; uncertain_slots: number; max_active: number; paid_starts_gated: boolean;
}
export type CollectionDispatchPhase = 'legacy' | 'prepared' | 'submission_authorized' | 'request_unknown' | 'accepted_save_pending' | 'attached' | 'cancelled_before_submit';
export type CollectionDisposition = 'protected' | 'risk_released';
export interface CollectionHold {
  id: string; kind: Job['kind']; status: JobStatus; account_slot: 1 | 2 | 3 | 4 | 5 | null;
  reserved_usd: number; claimed_cap_usd: number | null; reservation_started_at: string | null; uncertain_since: string | null;
  dispatch_phase: CollectionDispatchPhase; operational_disposition: CollectionDisposition; actual_cost_usd: number | null;
  recovery_reason: string | null; recovery_attempts: number; expected_version: number;
  creators: { id: string; username: string }[];
}
export interface CollectionJobRecovery extends CollectionHold {
  audit: { created_at: string; outcome: 'risk_release' | 'verified_no_start'; reason: string; released_usd: number }[];
}
export interface CollectionHolds extends PageResult<CollectionHold> {
  capacity: CollectionCapacity;
  usage: { reconciled_month_spend_usd: number; risk_released_exposure_usd: number };
}
/** Browser declaration never certifies that a provider request did not start. */
export interface CollectionSettlementRequest {
  outcome: 'risk_release'; reason: string; idempotency_key: string; expected_version: number; acknowledge_unknown: true;
}
export interface BillingSyncResult {
  sync: {
    accounts: { accountSlot: 1 | 2 | 3 | 4 | 5; enabled: boolean; success: boolean; syncedAt: string | null; error: 'usage_unverified' | 'usage_persistence_failed' | null;
      monthlyReportSyncedAt?: string | null; monthlyReportError?: 'monthly_report_unavailable' | null }[];
    runs: { checked: number; reconciled: number; unknown: number; failed: number };
    paidStarts: 0; syncedAt: string;
  };
}
export interface CarouselCollectionStatus {
  enabled: boolean; provider_validated: boolean; paused: boolean;
  reason: 'disabled' | 'setup_required' | 'paused' | 'scraping_disabled' | null;
  pending_jobs: number; active_jobs: number; last_fetch_at: string | null; next_due_at: string | null;
  interval_hours: 24; window_limit: 30;
}
export type MetricState = 'known' | 'hidden' | 'not_fetched' | 'unavailable';
export interface CarouselSlide {
  position: number; media_type: 'image' | 'video' | 'unknown'; image_url: string | null; video_url: string | null;
}
export interface CarouselMetrics {
  interactions: number | null; follower_engagement_pct: number | null; follower_outlier_score: number | null;
  profile_outlier_score: number | null; profile_baseline_interactions: number | null; profile_baseline_sample: number;
}
export interface Carousel extends CarouselMetrics {
  id: string; creator_id: string; shortcode: string; post_url: string | null; thumbnail_url: string | null;
  caption: string; published_at: string | null; published_at_raw: string | null;
  published_at_basis: 'explicit_offset' | 'timezone_unverified' | 'assumed_Asia/Kolkata';
  latest_likes: number | null; latest_comments: number | null; likes_state: MetricState; comments_state: MetricState;
  latest_fetched_at: string; provider: string; slides: CarouselSlide[];
  username: string; display_name: string | null; avatar_url: string | null;
  followers_count: number | null; follower_captured_at: string | null; saved: boolean; note: string; tags: string[];
}
export interface CarouselSummary extends Omit<Carousel, 'caption' | 'slides'> {
  caption_preview: string; slide_count: number;
}
export interface CarouselSnapshot {
  fetched_at: string; likes: number | null; comments: number | null; likes_state: MetricState; comments_state: MetricState;
  followers_at_snapshot: number | null; follower_captured_at: string | null;
}
export interface CarouselDetail { carousel: Carousel; snapshots: CarouselSnapshot[] }
export interface CarouselQuery {
  search?: string; keywords?: string; creator?: string; creator_ids?: string[]; saved?: boolean; min_interactions?: number;
  min_outlier?: number; max_outlier?: number; min_profile_outlier?: number; max_profile_outlier?: number;
  min_engagement?: number; max_engagement?: number; posted_amount?: number; posted_unit?: 'days' | 'weeks' | 'months';
  sort?: 'latest' | 'likes' | 'comments' | 'profile_outlier' | 'follower_engagement'; page?: number; limit?: number;
}
export interface SavedCarouselFilter {
  id: string; name: string; config: { version: 1; query: CarouselQuery }; created_at: string;
}
export type ReelCompletionStatus = 'pending' | 'done';
export interface ReelNeighbors { previous_id: string | null; next_id: string | null; position: number | null; total: number }
export interface Workspace { id: string; name: string; slug: string; created_at: string; archived_at: string | null }
export interface CreatorDirectoryEntry {
  id: string; username: string; display_name: string | null; avatar_url: string | null; status: CreatorStatus;
}
export interface CreatorQuery { search?: string; page?: number; limit?: number }
export interface Creator {
  id: string; username: string; display_name: string | null; avatar_url: string | null;
  followers_count: number | null; last_profile_fetch_at: string | null; status: CreatorStatus;
  last_reels_fetch_at: string | null; last_error: string | null; tracked_reels?: number; tracked_carousels?: number; latest_reel_date?: string | null;
  initial_backfill_job_id?: string | null; initial_backfill_status?: InitialBackfillStatus | null;
  profile_job_ids?: string[]; profile_job_status?: JobStatus;
  processing?: QueueProcessing; message?: string;
}
export interface BulkRemoveCreatorsResult {
  removed_ids: string[];
  already_removed_ids: string[];
  failed: { creator_id: string; error: { code: string; message: string } }[];
}
export interface ProfileOutlierMetrics {
  profile_outlier_score: number | null;
  profile_baseline_views: number | null;
  profile_baseline_sample: number;
}
export interface Reel extends ProfileOutlierMetrics {
  id: string; creator_id: string; shortcode: string; reel_url: string | null; thumbnail_url: string | null; platform?: 'instagram';
  caption_preview: string; published_at: string | null; published_at_raw?: string | null;
  published_at_basis?: 'explicit_offset' | 'timezone_unverified' | 'assumed_Asia/Kolkata'; duration_seconds: number | null;
  latest_views: number | null; latest_likes: number | null; latest_comments: number | null;
  views_state: MetricState; likes_state: MetricState; comments_state: MetricState;
  latest_fetched_at: string; first_seen_at: string; provider: string;
  username: string; display_name: string | null; avatar_url: string | null; followers_count: number | null;
  follower_captured_at: string | null; creator_status: CreatorStatus;
  follower_outlier_score: number | null; engagement_rate_pct: number | null;
  saved: boolean; note: string; tags: string[]; completion_status?: ReelCompletionStatus;
}
export interface Job {
  id: string; kind: 'daily' | 'weekly' | 'backfill' | 'profile' | 'manual' | 'retry' | 'discovery' | 'metrics' | 'carousel'; status: JobStatus;
  scheduled_for: string; started_at: string | null; completed_at: string | null; actor_run_id: string | null;
  requested_profiles_count: number; returned_records_count: number; estimated_cost_usd: number;
  actual_cost_usd: number | null; error_message: string | null; attempt_count: number; results_limit?: number; discovery_bounded?: boolean; metrics_tracked_count?: number | null; apify_account_slot?: 1 | 2 | 3 | 4 | 5 | null;
  operational_disposition?: CollectionDisposition; dispatch_phase?: CollectionDispatchPhase;
}
export interface CreatorSourceRefresh {
  job_id: string; status: JobStatus; source_refresh: boolean; results_limit: number;
  coverage_recorded: boolean; expected_reels: number | null; returned_reels: number;
  missing_reels: number; missing_captions: number; missing_media: number; completed_at: string | null;
  missing: { reel_id: string; shortcode: string; not_returned: boolean; caption_missing: boolean; media_missing: boolean }[];
}
export interface ProfileAutomationStatus {
  enabled: boolean; provider_validated: boolean; paused: boolean;
  reason: 'disabled' | 'setup_required' | 'paused' | 'scraping_disabled' | 'concurrency_limit' | 'unreconciled_charges' | 'budget_paused' | 'usage_unverified' | null;
  interval_hours: 24; batch_limit: 20; due_creators: number; pending_jobs: number; active_jobs: number;
  last_fetch_at: string | null; next_due_at: string | null;
}
export interface AppSettings {
  daily_limit: number; weekly_limit: number; monthly_budget_usd: number; budget_warning_pct: number;
  paused: boolean; timezone: string; capacity: number; scraping_enabled: boolean;
  initial_backfill_limit?: 100; initial_backfill_enabled?: boolean;
  collection_job_cap_usd?: number;
}
export interface Usage {
  estimated_month_spend: number; actual_month_spend: number | null; reserved_usd: number;
  unreconciled_jobs: number; remaining_allowance: number; provider_balance_usd: number | null;
  provider_usage_usd?: number | null; provider_limit_usd?: number | null;
  provider_cycle_start_at?: string | null; provider_cycle_end_at?: string | null; provider_usage_checked_at?: string | null;
  reconciled_month_spend_usd?: number; risk_released_exposure_usd?: number;
}
export interface Bootstrap {
  mode: 'demo' | 'supabase'; workspaces: Workspace[]; settings: AppSettings;
  usage: Usage; jobs: Job[]; email: string; collection_capacity?: CollectionCapacity;
}
export interface ReelQuery {
  search?: string; keywords?: string; creator_id?: string; creator_ids?: string[]; platform?: 'instagram';
  min_views?: number; max_views?: number; min_engagement?: number; max_engagement?: number; min_outlier?: number; max_outlier?: number;
  min_profile_outlier?: number; max_profile_outlier?: number;
  from?: string; to?: string; posted_amount?: number; posted_unit?: 'days' | 'weeks' | 'months';
  saved?: boolean; freshness?: 'all' | 'fresh' | 'stale'; status?: CreatorStatus;
  sort?: 'published_at' | 'views' | 'likes' | 'comments' | 'engagement' | 'outlier' | 'profile_outlier'; page?: number; limit?: number;
}
export interface SavedReelFilter {
  id: string; name: string; config: { version: 1; query: ReelQuery }; created_at: string;
}
export interface PageResult<T> { items: T[]; total: number; page: number; limit: number }
export interface Overview {
  active_competitors: number; tracked_reels: number; outliers: number; average_engagement: number | null;
  last_refresh: string | null; stale_reels: number; leaderboard: { creator: Creator; outliers: number; best_score: number | null }[];
  recent: Reel[];
}
export type TranscriptStatus = 'not_requested' | 'awaiting_media' | 'queued' | 'submitting' | 'processing' | 'ready' | 'no_speech' | 'media_unavailable' | 'failed' | 'budget_paused' | 'uncertain';
export interface TranscriptSegment { start_ms: number; end_ms: number; text: string }
export interface ReelTranscript {
  reel_id: string; status: TranscriptStatus; text: string | null; language: string | null;
  segments: TranscriptSegment[]; model: string | null; completed_at: string | null; error_message: string | null;
}
export type ReelProcessingReason = 'setup_required' | 'paused' | 'budget_paused' | 'media_recovery_disabled' | 'creator_unavailable' | 'review_required' | 'provider_review_required' | 'retry_limit_reached' | 'demo';
export interface TranscriptEstimate { min_seconds: number; max_seconds: number; sample_count: number; estimated_at: string }
export type TranscriptRequest = Record<string, never> | { retry_attempt_id: string; accept_duplicate_charge: true };
export interface ReelDetail {
  reel: Reel;
  caption_full?: string | null;
  media: { urls: string[]; observed_at: string | null };
  transcript: ReelTranscript;
  processing: { request_allowed: boolean; reason: ReelProcessingReason | null; estimate: TranscriptEstimate | null;
    priority?: 'normal' | 'high'; queue_position?: number | null; retry_after_seconds?: number; retry_attempt_id?: string | null };
}
export interface TranscriptionJob {
  id: string; reel_id: string; username: string; status: TranscriptStatus; attempt_count: number;
  created_at: string; completed_at: string | null; error_message: string | null;
}
export interface TranscriptOverview {
  enabled: boolean; paused: boolean; monthly_budget_usd: number; pilot_limit_usd: number;
  phase: 'pilot' | 'automatic'; estimated_month_spend: number; reserved_usd: number;
  actual_month_spend: number | null; unreconciled_jobs: number; jobs: TranscriptionJob[];
  budget_warning_pct?: number; preferences_editable?: boolean; pilot_verified?: boolean;
  account_pricing_validated?: boolean; processing_ready?: boolean;
  accounted_month_spend?: number; job_counts?: Partial<Record<TranscriptStatus, number>>; job_counts_complete?: boolean; spending_warning?: boolean;
}
export interface TranscriptionSettingsPatch {
  paused?: boolean; monthly_budget_usd?: number; budget_warning_pct?: number;
}
export interface ImportRow { row: number; input: string; username: string | null; workspace: string; status: 'ready' | 'duplicate' | 'invalid'; error?: string }

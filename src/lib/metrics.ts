import type { AppSettings, Carousel, CarouselMetrics, CollectionCapacity, CollectionHold, Job, ProfileOutlierMetrics, Reel, Usage } from './types';

/** Amounts for budgeting are provisional; never infer confirmed bills from reservations. */
export function collectionBudgetMetrics(settings: AppSettings, usage: Usage, capacity?: CollectionCapacity) {
  const subtotal = normalizeMetric(usage.reconciled_month_spend_usd) ?? normalizeMetric(usage.actual_month_spend);
  const reserved = normalizeMetric(usage.reserved_usd) ?? 0;
  const exposure = normalizeMetric(usage.risk_released_exposure_usd);
  const cap = normalizeMetric(settings.collection_job_cap_usd);
  const budget = normalizeMetric(settings.monthly_budget_usd) ?? 0;
  const accounted = (normalizeMetric(usage.estimated_month_spend) ?? 0) + reserved;
  return { subtotal, reserved, exposure, cap, accounted,
    allocation_pct: budget > 0 ? Math.min(100, accounted / budget * 100) : 100,
    // Released reservations do not establish available money or a maximum liability.
    remaining_guaranteed: false,
    paid_starts_gated: !settings.scraping_enabled || budget === 0 || cap === null || cap === 0 || capacity?.paid_starts_gated !== false,
  };
}
export function collectionReservationAge(hold: Pick<CollectionHold, 'reservation_started_at'>, now = Date.now()): number | null {
  const started = Date.parse(hold.reservation_started_at ?? '');
  return Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 60_000)) : null;
}
export function syntheticCollectionCapacity(jobs: Job[], maxActive = 5): CollectionCapacity {
  const occupied = jobs.filter(job => ['dispatching', 'running', 'processing', 'uncertain'].includes(job.status) && job.operational_disposition !== 'risk_released');
  const uncertain = occupied.filter(job => job.status === 'uncertain').length;
  return { occupied_slots: occupied.length, uncertain_slots: uncertain, max_active: maxActive, paid_starts_gated: true };
}


export const PROFILE_BASELINE_LIMIT = 30;
export const PROFILE_BASELINE_MINIMUM = 10;

export function normalizeMetric(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return value;
}

export function carouselInteractions(likes: number | null, comments: number | null): number | null {
  const l = normalizeMetric(likes), c = normalizeMetric(comments);
  return l !== null && c !== null ? normalizeMetric(l + c) : null;
}

/** Followers are the captured basis, not reach or views. */
export function carouselFollowerEngagement(likes: number | null, comments: number | null, followers: number | null): number | null {
  const total = carouselInteractions(likes, comments), f = normalizeMetric(followers);
  return total !== null && f !== null && f > 0 ? normalizeMetric(100 * total / f) : null;
}

/** Carousel follower outlier uses known interactions, with no invented views. */
export function carouselFollowerOutlier(likes: number | null, comments: number | null, followers: number | null): number | null {
  const total = carouselInteractions(likes, comments), f = normalizeMetric(followers);
  return total !== null && f !== null && f > 0 ? normalizeMetric(total / f) : null;
}

/** Calculate before filtering/pagination, using only strictly earlier carousels. */
export function withCarouselMetrics<T extends Pick<Carousel, 'id' | 'creator_id' | 'published_at' | 'latest_likes' | 'latest_comments' | 'likes_state' | 'comments_state' | 'followers_count'>>(posts: T[]): (T & CarouselMetrics)[] {
  const totals = posts.map(post => ({ post, time: Date.parse(post.published_at ?? ''), total: carouselInteractions(post.likes_state === 'known' ? post.latest_likes : null, post.comments_state === 'known' ? post.latest_comments : null) }));
  return totals.map(({ post, time, total }) => {
    const earlier = totals.filter(candidate => candidate.post.creator_id === post.creator_id && candidate.post.id !== post.id && candidate.time < time && candidate.total !== null)
      .sort((a, b) => b.time - a.time || a.post.id.localeCompare(b.post.id)).map(candidate => candidate.total);
    const baseline = profileOutlier(total, earlier);
    return { ...post, interactions: total, follower_engagement_pct: carouselFollowerEngagement(post.likes_state === 'known' ? post.latest_likes : null, post.comments_state === 'known' ? post.latest_comments : null, post.followers_count),
      follower_outlier_score: carouselFollowerOutlier(post.likes_state === 'known' ? post.latest_likes : null, post.comments_state === 'known' ? post.latest_comments : null, post.followers_count),
      profile_outlier_score: baseline.profile_outlier_score, profile_baseline_interactions: baseline.profile_baseline_views, profile_baseline_sample: baseline.profile_baseline_sample };
  });
}

export function engagementRate(views: number | null, likes: number | null, comments: number | null): number | null {
  const v = normalizeMetric(views), l = normalizeMetric(likes), c = normalizeMetric(comments);
  return v !== null && v > 0 && l !== null && c !== null ? 100 * (l + c) / v : null;
}

export function followerOutlier(views: number | null, likes: number | null, comments: number | null, followers: number | null): number | null {
  const v = normalizeMetric(views), l = normalizeMetric(likes), c = normalizeMetric(comments), f = normalizeMetric(followers);
  return v !== null && l !== null && c !== null && f !== null && f > 0 ? (v + l + c) / f : null;
}

export function relativePerformance(views: number | null, previousViews: (number | null)[]): { score: number | null; sample: number; estimated: boolean } {
  const result = profileOutlier(views, previousViews);
  return { score: result.profile_outlier_score, sample: result.profile_baseline_sample, estimated: result.profile_baseline_sample < PROFILE_BASELINE_LIMIT };
}

/** Prior views must be newest first. Known zeroes count; missing values do not. */
export function profileOutlier(views: number | null, previousViews: (number | null)[]): ProfileOutlierMetrics {
  const sample = previousViews.filter((n): n is number => normalizeMetric(n) !== null).slice(0, PROFILE_BASELINE_LIMIT).sort((a, b) => a - b);
  const midpoint = Math.floor(sample.length / 2);
  const median = sample.length < PROFILE_BASELINE_MINIMUM ? null : sample.length % 2 ? sample[midpoint] : sample[midpoint - 1] / 2 + sample[midpoint] / 2;
  const score = normalizeMetric(views) !== null && median !== null && median > 0 ? normalizeMetric(views! / median) : null;
  return { profile_outlier_score: score, profile_baseline_views: median, profile_baseline_sample: sample.length };
}

type ProfileReel = Pick<Reel, 'id' | 'creator_id' | 'published_at' | 'latest_views' | 'views_state'>;

/** Pass the complete authorized history, before user filters or pagination.
 * Equal/unknown publication times cannot establish an earlier comparison. */
export function withProfileOutliers<T extends ProfileReel>(reels: T[]): (T & ProfileOutlierMetrics)[] {
  const groups = new Map<string, { reel: T; time: number }[]>();
  for (const reel of reels) {
    const time = reel.published_at ? Date.parse(reel.published_at) : NaN;
    if (!Number.isFinite(time) || reel.views_state !== 'known' || normalizeMetric(reel.latest_views) === null) continue;
    const group = groups.get(reel.creator_id) ?? [];
    group.push({ reel, time });
    groups.set(reel.creator_id, group);
  }
  for (const group of groups.values()) group.sort((a, b) => b.time - a.time || a.reel.id.localeCompare(b.reel.id));
  return reels.map(reel => {
    const time = reel.published_at ? Date.parse(reel.published_at) : NaN;
    const previous = (groups.get(reel.creator_id) ?? []).filter(candidate => candidate.reel.id !== reel.id && candidate.time < time).slice(0, PROFILE_BASELINE_LIMIT);
    return { ...reel, ...profileOutlier(reel.views_state === 'known' ? reel.latest_views : null, previous.map(candidate => candidate.reel.latest_views)) };
  });
}

export function isStale(timestamp: string | null, now: number | Date = Date.now()): boolean {
  if (!timestamp) return true;
  const parsed = Date.parse(timestamp);
  const reference = now instanceof Date ? now.getTime() : now;
  return !Number.isFinite(parsed) || reference - parsed > 48 * 60 * 60 * 1000;
}

export function qualifiesEngagement(value: number | null): boolean { return value !== null && Number.isFinite(value) && value >= 5; }
export function qualifiesOutlier(value: number | null): boolean { return value !== null && Number.isFinite(value) && value >= 5; }


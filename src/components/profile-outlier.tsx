import type { Reel } from '../lib/types';
import { PROFILE_BASELINE_LIMIT, PROFILE_BASELINE_MINIMUM, qualifiesOutlier } from '../lib/metrics';
import { formatNumber, formatScore } from '../lib/format';

export function ProfileOutlierValue({ reel }: { reel: Reel }) {
  const score = reel.profile_outlier_score ?? null;
  const sample = reel.profile_baseline_sample ?? 0;
  const baseline = reel.profile_baseline_views ?? null;
  const status = !reel.published_at ? 'Date unverified' : reel.views_state !== 'known' || reel.latest_views === null ? 'Views unavailable'
    : sample < PROFILE_BASELINE_MINIMUM ? 'Insufficient data' : baseline === 0 ? 'Zero baseline'
    : score === null ? 'Unavailable' : sample < PROFILE_BASELINE_LIMIT ? 'Limited sample' : null;
  const tooltip = `Profile Outlier Score: ${formatScore(score)}. ${reel.views_state === 'known' ? formatNumber(reel.latest_views) : 'Unavailable'} views · Profile typical: ${formatNumber(baseline)} views. Median of ${sample} earlier Reels with known views (up to ${PROFILE_BASELINE_LIMIT}); excludes this Reel. At least ${PROFILE_BASELINE_MINIMUM} comparisons required. Latest snapshots; not adjusted for Reel age.${status ? ` ${status}.` : ''}`;
  return <span className="profile-outlier-value" title={tooltip} tabIndex={0} aria-label={tooltip}>
    <span className={`metric-value${qualifiesOutlier(score) ? ' metric-highlight' : ''}${score === null ? ' metric-unknown' : ''}`}>{formatScore(score)}</span>
    {status && <small className="profile-outlier-status">{status}</small>}
  </span>;
}

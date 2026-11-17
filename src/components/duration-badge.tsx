import { formatDuration } from '../lib/format';

export function DurationBadge({ seconds }: { seconds: number | null | undefined }) {
  const duration = formatDuration(seconds);
  if (duration === null) return null;
  return <span className="thumbnail-duration" aria-label={`Video duration: ${duration}`} title={`${seconds} seconds`}>{duration}</span>;
}

import type { ReelDetail, ReelProcessingReason, TranscriptStatus } from './types';
import { transcriptPlainText } from './transcript';

/** A short source excerpt, never a generated claim about unseen video content. */
export function reelOverview(detail: Pick<ReelDetail, 'reel' | 'transcript' | 'caption_full'>): { text: string; source: 'Transcript excerpt' | 'Caption excerpt' } | null {
  const spoken = transcriptPlainText(detail.transcript);
  const text = (spoken || detail.caption_full || detail.reel.caption_preview).replace(/\s+/gu, ' ').trim();
  if (!text) return null;
  const sentences = Array.from(new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text), item => item.segment.trim());
  let excerpt = '';
  for (const sentence of sentences.slice(0, 3)) {
    if (excerpt && excerpt.length + sentence.length > 460) break;
    excerpt += `${excerpt ? ' ' : ''}${sentence}`;
    if (excerpt.length >= 460) break;
  }
  if (excerpt.length > 480) {
    const words = excerpt.slice(0, 480).replace(/\s+\S*$/u, '');
    excerpt = `${words || excerpt.slice(0, 480)}…`;
  }
  return { text: excerpt, source: spoken ? 'Transcript excerpt' : 'Caption excerpt' };
}

export function transcriptWordCount(text: string | null): number {
  if (!text) return 0;
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)).filter(word => word.isWordLike).length;
}

/** Only previously captured Instagram CDN media; never proxy an arbitrary URL. */
export function reelPlaybackUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192 || /[\\\s]/.test(value)) return null;
  try {
    const url = new URL(value);
    const authority = value.match(/^https:\/\/([^/?#]+)/)?.[1];
    if (!authority || authority.includes(':') || authority.includes('@') || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:cdninstagram\.com|fbcdn\.net)$/i.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

export function transcriptIsPending(status: TranscriptStatus): boolean {
  return ['awaiting_media', 'queued', 'submitting', 'processing', 'budget_paused'].includes(status);
}

export function processingMessage(reason: ReelProcessingReason | null, priority?: 'normal' | 'high'): string | null {
  switch (reason) {
    case 'demo': return 'Synthetic demo Reel. Live video and transcription are unavailable in demo mode.';
    case 'setup_required': return 'Transcription setup is required before this Reel can be processed.';
    case 'paused': return 'Transcription is paused. Resume it in Settings to continue.';
    case 'budget_paused': return 'Waiting for transcription budget allowance. Your spending limit stays in place.';
    case 'media_recovery_disabled': return 'No usable video is stored yet. Media recovery needs to be enabled before transcription can continue.';
    case 'creator_unavailable': return 'This creator is private, unavailable or paused. Processing cannot continue right now.';
    case 'review_required': return 'Processing needs review in Jobs. A failed or uncertain request will not be submitted again automatically.';
    case 'provider_review_required': return priority === 'high'
      ? 'This Reel is prioritized, but transcription is blocked while earlier provider requests are reconciled. Queue position is the order of waiting Reels, not an active processing slot. No completion estimate is available yet.'
      : 'Transcription is blocked while earlier provider requests are reconciled. You can prioritize this Reel; processing resumes after the provider review is resolved.';
    case 'retry_limit_reached': return 'The retry limit has been reached. Check Jobs for the last failure before another attempt can be authorized.';
    default: return null;
  }
}

export function transcriptEstimateLabel(estimate: ReelDetail['processing']['estimate']): string | null {
  if (!estimate) return null;
  function duration(seconds: number) {
    return seconds < 60 ? `${Math.ceil(seconds / 5) * 5} sec` : `${Math.ceil(seconds / 60)} min`;
  }
  const low = duration(estimate.min_seconds), high = duration(estimate.max_seconds);
  return `Estimated wait: about ${low === high ? low : `${low} – ${high}`}. Based on recent completed jobs; queue times can vary.`;
}

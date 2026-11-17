import type { ReelTranscript, TranscriptSegment, TranscriptStatus } from './types';

export const transcriptStatuses: readonly TranscriptStatus[] = ['not_requested', 'awaiting_media', 'queued', 'submitting', 'processing', 'ready', 'no_speech', 'media_unavailable', 'failed', 'budget_paused', 'uncertain'];

/** Elapsed time, not a Date: durations must never wrap at 24 hours. */
export function formatElapsedMs(value: number, separator: '.' | ',' = '.'): string | null {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor(value / 60_000) % 60;
  const seconds = Math.floor(value / 1_000) % 60;
  const milliseconds = value % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(milliseconds).padStart(3, '0')}`;
}

export function isTimedSegment(value: unknown): value is TranscriptSegment {
  if (!value || typeof value !== 'object') return false;
  const segment = value as Partial<TranscriptSegment>;
  return typeof segment.start_ms === 'number' && Number.isSafeInteger(segment.start_ms) && segment.start_ms >= 0 &&
    typeof segment.end_ms === 'number' && Number.isSafeInteger(segment.end_ms) && segment.end_ms > segment.start_ms &&
    typeof segment.text === 'string' && segment.text.trim().length > 0;
}

export function transcriptPlainText(value: ReelTranscript): string | null {
  if (value.status !== 'ready') return null;
  if (value.text?.trim()) return value.text;
  const text = value.segments.map(segment => segment.text).join('\n');
  return text.trim() ? text : null;
}

/** Presentation only: preserve every spoken word and its order; exports keep the raw text. */
export function transcriptParagraphs(text: string): string[] {
  const blocks = text.split(/\r?\n[\t ]*\r?\n+/).filter(block => block.trim());
  const paragraphs: string[] = [];
  for (const block of blocks) {
    const sentences = Array.from(new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(block), item => item.segment);
    let paragraph = '';
    for (const sentence of sentences) {
      if (paragraph.length >= 150 && paragraph.length + sentence.length > 320) {
        paragraphs.push(paragraph.trim()); paragraph = '';
      }
      // Long speech without punctuation is grouped at whitespace, never mid-word.
      if (sentence.length > 480) {
        for (const word of sentence.match(/\S+\s*|\s+/gu) ?? []) {
          if (paragraph.length >= 320) { paragraphs.push(paragraph.trim()); paragraph = ''; }
          paragraph += word;
        }
      } else paragraph += sentence;
    }
    if (paragraph.trim()) paragraphs.push(paragraph.trim());
  }
  return paragraphs;
}

export function transcriptTimeLabel(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Group word-level provider cues into readable phrases using recorded boundaries only. */
export function groupTranscriptSegments(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  const groups: TranscriptSegment[] = [];
  let group: TranscriptSegment | null = null;
  let previousStart = -1;
  for (const segment of segments) {
    if (!isTimedSegment(segment) || segment.start_ms < previousStart) return [];
    previousStart = segment.start_ms;
    const text = segment.text.trim();
    const sentenceEnd = group && /[.!?।。！？؟]["'”’)]?\s*$/u.test(group.text) && group.text.length >= 45;
    if (group && (segment.start_ms < group.end_ms || segment.start_ms - group.end_ms > 1200 ||
      segment.end_ms - group.start_ms > 8000 || group.text.length + text.length > 130 || sentenceEnd)) {
      groups.push(group); group = null;
    }
    if (group) { group.text += ` ${text}`; group.end_ms = segment.end_ms; }
    else group = { start_ms: segment.start_ms, end_ms: segment.end_ms, text };
  }
  if (group) groups.push(group);
  return groups;
}

/** No proportional/guessed timestamps, reordering, or silent malformed cue export. */
export function transcriptSrt(segments: readonly TranscriptSegment[]): string | null {
  if (!segments.length || segments.length > 5_000) return null;
  let previousStart = -1;
  const cues: string[] = [];
  for (const segment of segments) {
    if (!isTimedSegment(segment) || segment.start_ms < previousStart) return null;
    previousStart = segment.start_ms;
    // Blank lines and control characters cannot create additional SRT cues.
    const text = segment.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n').trim().replace(/\n[\t ]*\n+/g, '\n');
    if (!text) return null;
    cues.push(`${cues.length + 1}\n${formatElapsedMs(segment.start_ms, ',')} --> ${formatElapsedMs(segment.end_ms, ',')}\n${text}`);
  }
  return `${cues.join('\n\n')}\n`;
}

export function transcriptStatusMessage(status: TranscriptStatus): string {
  switch (status) {
    case 'not_requested': return 'No transcript has been requested for this Reel yet.';
    case 'awaiting_media': return 'Waiting for usable video before the original audio can be transcribed.';
    case 'queued': return 'Your requested transcription is queued.';
    case 'submitting': return 'Your transcription request is being submitted.';
    case 'processing': return 'The original audio is being transcribed.';
    case 'ready': return 'AI transcript of the original audio. It may contain mistakes; wording has not been translated or rewritten.';
    case 'no_speech': return 'No speech was detected in the processed audio.';
    case 'media_unavailable': return 'The stored video could not be downloaded with a valid audio track within the media limits.';
    case 'failed': return 'Transcription failed. Check transcription activity in Jobs; viewing does not retry the job.';
    case 'budget_paused': return 'Transcription is waiting for budget allowance. Viewing does not bypass the budget gate.';
    case 'uncertain': return 'The transcription outcome is uncertain. Check Jobs; viewing does not submit another job.';
  }
}

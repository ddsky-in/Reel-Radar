import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReelTranscript, TranscriptOverview } from '../src/lib/types';
import { formatElapsedMs, groupTranscriptSegments, isTimedSegment, transcriptParagraphs, transcriptPlainText, transcriptSrt, transcriptStatusMessage, transcriptStatuses } from '../src/lib/transcript';
import { safeTranscript, safeTranscriptionOverview } from '../src/lib/server/public-data';
import { DemoRepository } from '../src/lib/server/demo-repository';
import { SupabaseRepository } from '../src/lib/server/supabase-repository';
import { TranscriptButton, TranscriptContent, TranscriptViewer } from '../src/components/transcript-viewer';
import { TranscriptionUsage } from '../src/components/operations';

// ui.tsx's existing alias export is not configured in the plain Vitest runner.
vi.mock('@/lib/use-resource', async () => await import('../src/lib/use-resource'));

const reelId = 'a0000000-0000-4000-8000-000000000001';
const workspaceId = 'a0000000-0000-4000-8000-000000000002';
const transcript: ReelTranscript = {
  reel_id: reelId, status: 'ready', text: '<script>alert("x")</script>\nOriginal speech', language: 'en',
  segments: [{ start_ms: 1_234, end_ms: 5_678, text: '<img onerror="evil">' }],
  model: 'scribe_v2', completed_at: '2026-11-08T12:00:00Z', error_message: null,
};
const overview: TranscriptOverview = {
  enabled: false, paused: true, monthly_budget_usd: 5, pilot_limit_usd: 0.25, phase: 'pilot',
  estimated_month_spend: 0.01, reserved_usd: 0.02, actual_month_spend: null, unreconciled_jobs: 1, jobs: [],
};

describe('transcript elapsed time and export', () => {
  it.each([[0, '00:00:00.000'], [999, '00:00:00.999'], [1_000, '00:00:01.000'], [59_999, '00:00:59.999'], [60_000, '00:01:00.000'], [3_600_001, '01:00:00.001'], [90_061_007, '25:01:01.007']])('formats integer milliseconds %s without Date wrapping', (input, output) => {
    expect(formatElapsedMs(Number(input))).toBe(output);
  });
  it.each([-1, NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1])('rejects invalid elapsed value %s', input => {
    expect(formatElapsedMs(input)).toBeNull();
  });
  it('exports exact recorded SRT milliseconds, not rounded seconds or guessed timing', () => {
    expect(transcriptSrt([{ start_ms: 1_234, end_ms: 5_678, text: 'Hello' }, { start_ms: 90_061_007, end_ms: 90_062_008, text: 'Next' }])).toBe('1\n00:00:01,234 --> 00:00:05,678\nHello\n\n2\n25:01:01,007 --> 25:01:02,008\nNext\n');
  });
  it('rejects missing, reversed, fractional, negative and non-monotonic cue timing', () => {
    for (const segment of [{ start_ms: null, end_ms: 1, text: 'x' }, { start_ms: 1, end_ms: 1, text: 'x' }, { start_ms: -1, end_ms: 1, text: 'x' }, { start_ms: 0.5, end_ms: 1, text: 'x' }, { start_ms: 0, end_ms: Infinity, text: 'x' }, { start_ms: 0, end_ms: 1, text: ' ' }]) {
      expect(isTimedSegment(segment)).toBe(false);
      expect(transcriptSrt([segment as never])).toBeNull();
    }
    expect(transcriptSrt([])).toBeNull();
    expect(transcriptSrt([{ start_ms: 2, end_ms: 3, text: 'x' }, { start_ms: 1, end_ms: 2, text: 'y' }])).toBeNull();
  });
  it('prevents blank-line/control cue injection but preserves original wording', () => {
    expect(transcriptSrt([{ start_ms: 0, end_ms: 1, text: 'One\r\n\r\nTwo\u0000' }])).toBe('1\n00:00:00,000 --> 00:00:00,001\nOne\nTwo\n');
  });
  it('never derives timing from text and allows plain text without segments', () => {
    expect(transcriptPlainText({ ...transcript, segments: [] })).toBe(transcript.text);
    expect(transcriptSrt([])).toBeNull();
    expect(transcriptPlainText({ ...transcript, status: 'no_speech' })).toBeNull();
    expect(transcriptPlainText({ ...transcript, text: null })).toBe(transcript.segments[0].text);
  });
});

describe('transcript public boundary', () => {
  it('does not present routine media or budget waiting states as errors', () => {
    for (const status of ['awaiting_media', 'queued', 'budget_paused', 'ready'] as const) {
      expect(safeTranscript({ ...transcript, status, error_message: 'internal waiting detail' }).error_message).toBeNull();
    }
    expect(safeTranscript({ ...transcript, status: 'failed', error_message: 'internal failure' }).error_message).toContain('Transcription encountered an error');
  });
  it('whitelists exact public fields, bounds transcript and segments, hides source and provider data', () => {
    const value = safeTranscript({ ...transcript, text: 't'.repeat(200_001), source_url: 'https://secret.test/video', provider_job_id: 'internal-id', api_key: 'secret-key', segments: Array.from({ length: 5_001 }, (_, index) => ({ start_ms: index, end_ms: index + 1, text: 's', source_url: 'private', provider_id: 'private' })), error_message: 'https://secret.test/?token=secret-key', language: 'https://secret.test', model: 'internal-provider-model' });
    expect(Object.keys(value).sort()).toEqual(['reel_id', 'status', 'text', 'language', 'segments', 'model', 'completed_at', 'error_message'].sort());
    expect(value.text).toHaveLength(200_000);
    expect(value.segments).toHaveLength(5_000);
    expect(Object.keys(value.segments[0]).sort()).toEqual(['end_ms', 'start_ms', 'text']);
    expect(value.language).toBeNull(); expect(value.model).toBeNull();
    expect(JSON.stringify(value)).not.toMatch(/secret\.test|internal-id|secret-key|source_url|provider_id/);
    expect(safeTranscript(transcript).model).toBe('scribe_v2');
  });
  it('bounds total segment text and refuses malformed or guessed timings', () => {
    const bounded = safeTranscript({ ...transcript, segments: [{ start_ms: 0, end_ms: 1, text: 's'.repeat(200_001) }] });
    expect(bounded.segments[0].text).toHaveLength(200_000);
    expect(safeTranscript({ ...transcript, segments: [transcript.segments[0], { start_ms: null, end_ms: 3, text: 'bad' }] }).segments).toEqual([]);
    expect(safeTranscript({ ...transcript, status: 'processing' })).toMatchObject({ text: null, segments: [] });
    expect(safeTranscript({ ...transcript, reel_id: 'https://private', completed_at: 'internal' })).toMatchObject({ reel_id: '', completed_at: null });
  });
  it('returns safe disabled defaults for malformed contracts, with all known statuses supported', () => {
    expect(safeTranscript(null)).toMatchObject({ status: 'uncertain', text: null, segments: [], language: null, model: null });
    expect(safeTranscriptionOverview(null)).toMatchObject({ enabled: false, paused: true, phase: 'pilot', actual_month_spend: null, jobs: [] });
    for (const status of transcriptStatuses) {
      expect(safeTranscript({ ...transcript, status }).status).toBe(status);
      expect(transcriptStatusMessage(status)).toBeTruthy();
    }
  });
  it('whitelists overview/job fields and rejects arbitrary gate, phase, cost and provider payloads', () => {
    const value = safeTranscriptionOverview({ ...overview, phase: 'internal-phase', enabled: 'true', paused: 'false', actual_month_spend: NaN, estimated_month_spend: -1, api_key: 'secret', jobs: [{ id: reelId, reel_id: reelId, username: 'https://secret.test', status: 'queued', attempt_count: 1, created_at: '2026-11-08T12:00:00Z', completed_at: null, error_message: 'token=secret', provider_job_id: 'private' }] });
    expect(value).toMatchObject({ enabled: false, paused: true, phase: 'pilot', actual_month_spend: null, estimated_month_spend: 0 });
    expect(value.jobs[0]).toMatchObject({ username: 'unknown', status: 'queued' });
    expect(JSON.stringify(value)).not.toMatch(/secret|private|provider_job_id|api_key/);
    expect(safeTranscriptionOverview({ ...overview, phase: 'automatic' }).phase).toBe('automatic');
    expect(safeTranscriptionOverview({ ...overview, jobs: Array(101).fill(value.jobs[0]) }).jobs).toHaveLength(100);
  });
});

describe('transcript SSR and read-only viewer', () => {
  it('renders a keyboard-accessible on-demand button with no preloaded dialog/transcript', () => {
    const markup = renderToStaticMarkup(createElement(TranscriptButton, { workspaceId, reelId, username: 'fixture' }));
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('View transcript for Reel by @fixture');
    expect(markup).toContain('Transcript</button>');
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain('Original speech');
  });
  it('renders dialog/loading without initiating work during SSR', () => {
    const markup = renderToStaticMarkup(createElement(TranscriptViewer, { workspaceId, reelId, username: 'fixture', onClose: () => {} }));
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('Original AI transcript');
    expect(markup).toContain('Loading transcript');
    expect(markup).toContain('never starts transcription');
  });
  it('escapes original transcript text and offers reading/timeline formats and exports', () => {
    const markup = renderToStaticMarkup(createElement(TranscriptContent, { transcript, reelId }));
    expect(markup).toContain('&lt;script&gt;'); expect(markup).not.toContain('<script>');
    expect(markup).toContain('Reading'); expect(markup).toContain('Timeline');
    expect(markup).toContain('transcript-reading');
    expect(markup).toContain('Copy text'); expect(markup).toContain('>TXT</button>'); expect(markup).toContain('>SRT</button>');
    expect(markup).not.toContain('<video');
  });
  it('keeps text-only/no-speech distinct and disables SRT without valid timing', () => {
    const textOnly = renderToStaticMarkup(createElement(TranscriptContent, { transcript: { ...transcript, segments: [] }, reelId }));
    expect(textOnly).toMatch(/disabled=""[^>]*>[\s\S]*?SRT<\/button>/);
    expect(textOnly).not.toContain('Recorded timestamp segments');
    const silent = renderToStaticMarkup(createElement(TranscriptContent, { transcript: { ...transcript, status: 'no_speech', text: null, segments: [] }, reelId }));
    expect(silent).toContain('No speech was detected in the processed audio'); expect(silent).not.toContain('Copy text');
  });
  it('shows the configured ceiling, reservations and unknown speech billing separately', () => {
    const markup = renderToStaticMarkup(createElement(TranscriptionUsage, { overview, demo: false }));
    expect(markup).toContain('Disabled on server'); expect(markup).toContain('Monthly allowance accounting');
    expect(markup).toContain('$5.00'); expect(markup).toContain('Unknown');
    expect(markup).toContain('Allowance used this month'); expect(markup).toContain('Actual speech charges');
    expect(markup).toContain('Reserved for pending work'); expect(markup).toContain('Pilot validation');
    expect(markup).toContain('not billed charges');
  });
  it('shows on-demand processing and complete requested totals without treating the latest 100 jobs as the backlog', () => {
    const markup = renderToStaticMarkup(createElement(TranscriptionUsage, { overview: { ...overview, enabled: true, paused: false, phase: 'automatic', monthly_budget_usd: 25, processing_ready: true, job_counts_complete: true, job_counts: { queued: 350, ready: 200, failed: 1 } }, demo: false }));
    expect(markup).toContain('Ready for transcript requests');
    expect(markup).toContain('On demand');
    expect(markup).toContain('350'); expect(markup).toContain('200'); expect(markup).toContain('$25.00');
    expect(markup).toContain('Only Reels requested with Get transcript are processed');
    expect(markup).toContain('aria-label="Transcription totals"');
  });
  it('marks older backend readiness as unverified and fallback counts as recent', () => {
    const markup = renderToStaticMarkup(createElement(TranscriptionUsage, { overview: { ...overview, enabled: true, paused: false, phase: 'automatic', job_counts: { queued: 1 }, job_counts_complete: false }, demo: false }));
    expect(markup).toContain('Readiness unverified');
    expect(markup).toContain('Recent queued'); expect(markup).toContain('aria-label="Recent transcription totals"');
    expect(markup).not.toContain('Ready for transcript requests');
  });
  it('keeps synthetic activity disabled and marks a lowered exhausted ceiling as waiting', () => {
    const demo = renderToStaticMarkup(createElement(TranscriptionUsage, { overview: { ...overview, enabled: true, paused: false }, demo: true }));
    expect(demo).toContain('Synthetic demo'); expect(demo).toContain('Transcription is disabled in this demo');
    const waiting = renderToStaticMarkup(createElement(TranscriptionUsage, { overview: { ...overview, enabled: true, paused: false, monthly_budget_usd: .01, reserved_usd: .08 }, demo: false }));
    expect(waiting).toContain('Allowance reached');
    expect(waiting).toContain('New paid work waits until allowance is available');
  });
  it('keeps GET branches read-only and settings PATCH strict/same-origin', () => {
    const route = readFileSync(join(process.cwd(), 'src/app/api/[...path]/route.ts'), 'utf8');
    const transcriptBranch = route.match(/if \(path.length === 5 && path\[2\] === 'reels' && path\[4\] === 'transcript' && request.method === 'GET'\)[\s\S]*?\n      }/)?.[0];
    expect(transcriptBranch).toContain('safeTranscript(await repo.transcript');
    expect(transcriptBranch).not.toMatch(/scheduleDispatcherWake|after\(|enqueue|refresh\(/);
    const preferenceBranch = route.match(/if \(path.length === 1 && path\[0\] === 'transcription' && request.method === 'PATCH'\)[\s\S]*?\n    }/)?.[0];
    expect(preferenceBranch).toContain('validate(transcriptionSettingsSchema');
    expect(preferenceBranch).toContain('repo.transcriptionSettings');
    expect(preferenceBranch).not.toMatch(/scheduleDispatcherWake|enqueue/);
    expect(route.indexOf('assertMutationOrigin(request)')).toBeLessThan(route.indexOf("path[0] === 'transcription'"));
    const viewer = readFileSync(join(process.cwd(), 'src/components/transcript-viewer.tsx'), 'utf8');
    expect(viewer).toContain('useResource<ReelTranscript>');
    expect(viewer).toContain('Could not copy. Select the transcript text manually');
    expect(viewer).toContain("role={feedback.error ? 'alert' : 'status'}");
    expect(viewer).not.toMatch(/dangerouslySetInnerHTML|\/api\/refresh|access_token|source_url|video_url|scheduleDispatcherWake/);
  });
});

describe('transcript reading structure', () => {
  it('groups word cues into readable phrases without changing words or inventing timing', () => {
    const words = 'Aaj hum shuru karte hain. Choose one small habit and keep practising every day. '.repeat(8).trim().split(' ');
    const cues = words.map((text, index) => ({ text, start_ms: index * 400, end_ms: index * 400 + 350 }));
    const groups = groupTranscriptSegments(cues);
    expect(groups.length).toBeLessThan(cues.length / 4);
    expect(groups.map(group => group.text).join(' ')).toBe(words.join(' '));
    for (const group of groups) {
      expect(cues.some(cue => cue.start_ms === group.start_ms)).toBe(true);
      expect(cues.some(cue => cue.end_ms === group.end_ms)).toBe(true);
      expect(group.end_ms - group.start_ms).toBeLessThanOrEqual(8000);
    }
    expect(cues[0].text).toBe('Aaj');
    expect(transcriptSrt(cues)?.split('\n\n')).toHaveLength(cues.length);
  });
  it('does not merge across long gaps, overlapping speech or invalid timings', () => {
    const cues = [{ start_ms: 0, end_ms: 1000, text: 'First' }, { start_ms: 2500, end_ms: 3500, text: 'Later' }, { start_ms: 3000, end_ms: 4000, text: 'Overlap' }];
    expect(groupTranscriptSegments(cues)).toEqual(cues);
    expect(groupTranscriptSegments([{ start_ms: 1000, end_ms: 2000, text: 'One' }, { start_ms: 500, end_ms: 900, text: 'Two' }])).toEqual([]);
    expect(groupTranscriptSegments([{ start_ms: -1, end_ms: 10, text: 'Invalid' }])).toEqual([]);
  });
  it('preserves words, punctuation and order across English, Hindi and Hinglish', () => {
    for (const text of [
      'Keep the original wording. '.repeat(45),
      'आज हम शुरुआत करेंगे। इस बात को याद रखिए। '.repeat(35),
      'Ab ye step follow karo, then move ahead! '.repeat(35),
      'Unpunctuated speech with several words '.repeat(50),
      'Original first paragraph.\n\nSecond paragraph stays separate.\r\n\r\nThird block.',
    ]) {
      const paragraphs = transcriptParagraphs(text);
      expect(paragraphs.length).toBeGreaterThan(1);
      expect(paragraphs.join(' ').match(/\S+/gu)).toEqual(text.match(/\S+/gu));
      expect(transcriptPlainText({ ...transcript, text })).toBe(text);
    }
  });
  it('keeps existing short paragraphs and long unbroken tokens intact', () => {
    expect(transcriptParagraphs('First line.\n\nSecond line.')).toEqual(['First line.', 'Second line.']);
    expect(transcriptParagraphs('x'.repeat(900))).toEqual(['x'.repeat(900)]);
    expect(transcriptParagraphs(' \n\n ')).toEqual([]);
  });
});

describe('transcript repository contracts without hosted calls', () => {
  it('returns demo not_requested without fixtures and enforces workspace association', async () => {
    const repo = new DemoRepository();
    const bootstrap = await repo.bootstrap();
    const workspace = bootstrap.workspaces[0].id;
    const reel = (await repo.reels(workspace, { limit: 1 })).items[0];
    const before = (await repo.jobs()).jobs;
    expect(await repo.transcript(workspace, reel.id)).toMatchObject({ status: 'not_requested', text: null, segments: [], model: null });
    expect((await repo.jobs()).jobs).toEqual(before);
    expect(await repo.transcription()).toMatchObject({ ...overview, estimated_month_spend: 0, reserved_usd: 0, unreconciled_jobs: 0, preferences_editable: false, processing_ready: false });
    const empty = await repo.createWorkspace('Transcript access test');
    await expect(repo.transcript(empty.id, reel.id)).rejects.toMatchObject({ status: 404 });
    await expect(repo.transcript(workspace, workspaceId)).rejects.toMatchObject({ status: 404 });
  });
  it('passes only approved RPC parameters and no queue/write on transcript GET', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: transcript, error: null });
    const repo = new SupabaseRepository({ rpc } as unknown as SupabaseClient, reelId, 'owner@example.test');
    vi.spyOn(repo, 'workspace').mockResolvedValue({ id: workspaceId, name: 'Test', slug: 'test', created_at: '2026-11-08T12:00:00Z', archived_at: null });
    expect(await repo.transcript(workspaceId, reelId)).toEqual(transcript);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_reel_transcript', { p_workspace_id: workspaceId, p_reel_id: reelId });
    rpc.mockResolvedValue({ data: overview as never, error: null });
    await repo.transcriptionPreferences(true);
    expect(rpc).toHaveBeenCalledWith('update_transcription_preferences', { p_paused: true });
    expect(rpc).toHaveBeenCalledWith('get_transcription_overview', undefined);
  });
});

import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoData } from '../src/lib/demo';
import { DemoRepository } from '../src/lib/server/demo-repository';
import { safeReelDetail } from '../src/lib/server/public-data';
import { reelOverview, reelPlaybackUrl, transcriptEstimateLabel, transcriptWordCount } from '../src/lib/reel-detail';
import type { ReelDetail } from '../src/lib/types';
import { ReelCard, ReelTable } from '../src/components/reels';
import { ReelPlayback, ReelDetailDialog, ReelResearchPanels } from '../src/components/reel-detail';
import { ReelNavigationContext } from '../src/components/reel-navigation';
import type { ResourceState } from '../src/lib/resource-cache';
const resourceFixture = vi.hoisted(() => ({ state: null as ResourceState<ReelDetail> | null }));
vi.mock('@/lib/use-resource', async () => {
  const actual = await import('../src/lib/use-resource');
  return { ...actual, useResource: (...args: Parameters<typeof actual.useResource>) => resourceFixture.state ?? actual.useResource(...args) };
});
afterEach(() => { resourceFixture.state = null; });

const reel = createDemoData().reels[0];
const detail: ReelDetail = { reel, media: { urls: ['https://video.cdninstagram.com/reel.mp4'], observed_at: null }, transcript: { reel_id: reel.id, status: 'queued', text: null, language: null, segments: [], model: 'scribe_v2', completed_at: null, error_message: null }, processing: { request_allowed: false, reason: null, estimate: { min_seconds: 30, max_seconds: 90, sample_count: 5, estimated_at: '2026-11-09T12:00:00Z' } } };

describe('Reel detail contracts', () => {
  it('keeps eligible transcript actions enabled when cached details refresh on revisit or polling', () => {
    const waiting = { ...detail, processing: { ...detail.processing, request_allowed: true, priority: 'normal' as const } };
    for (const refreshing of [false, true]) {
      resourceFixture.state = { data: waiting, loading: false, refreshing, error: null };
      const markup = renderToStaticMarkup(createElement(ReelDetailDialog, { reel, workspaceId: 'fixture', onSave: () => {}, onClose: () => {} }));
      const button = markup.match(/<button\b[^>]*class="[^"]*transcript-header-action[^"]*"[^>]*>[\s\S]*?<\/button>/)![0];
      expect(button).toContain('Get transcript');
      expect(button).not.toContain('disabled');
    }
    const markup = renderToStaticMarkup(createElement(ReelResearchPanels, { reel, detail: waiting, loading: false, requesting: true, retry: () => {}, request: async () => {}, videoRef: createRef<HTMLVideoElement>(), onSave: () => {} }));
    const button = markup.match(/<button\b[^>]*class="[^"]*transcript-header-action[^"]*"[^>]*>[\s\S]*?<\/button>/)![0];
    expect(button).toContain('Requesting');
    expect(button).toContain('disabled');
    resourceFixture.state = { data: null, loading: true, refreshing: false, error: null };
    expect(renderToStaticMarkup(createElement(ReelDetailDialog, { reel, workspaceId: 'fixture', onSave: () => {}, onClose: () => {} }))).not.toContain('transcript-header-action');
  });
  it('places an explicit uncertain retry in the transcript header and hides unsafe or stale retry offers', () => {
    const waiting = safeReelDetail({ ...detail, transcript: { ...detail.transcript, status: 'uncertain' }, processing: { request_allowed: false, reason: 'review_required', retry_attempt_id: reel.id } });
    const markup = renderToStaticMarkup(createElement(ReelResearchPanels, { reel, detail: waiting, loading: false, retry: () => {}, request: async () => {}, videoRef: createRef<HTMLVideoElement>(), onSave: () => {} }));
    const header = markup.match(/<section[^>]*id="reel-transcript"[^>]*><div class="reel-detail-section-heading">[\s\S]*?<div class="reel-research-panel-body">/)![0];
    expect(header).toContain('Retry transcript');
    expect(header).toContain('aria-describedby="transcript-retry-notice"');
    expect(markup).toContain('may incur another charge');
    expect(markup).not.toContain('reel-media-retry');
    for (const status of ['ready', 'queued', 'processing', 'submitting']) expect(safeReelDetail({ ...waiting, transcript: { ...waiting.transcript, status } }).processing.retry_attempt_id).toBeNull();
    expect(safeReelDetail({ ...waiting, processing: { ...waiting.processing, reason: 'retry_limit_reached' } }).processing.retry_attempt_id).toBeNull();
    expect(safeReelDetail({ ...waiting, processing: { ...waiting.processing, retry_attempt_id: 'invalid' } }).processing.retry_attempt_id).toBeNull();
  });
  it('shows free priority promotion during provider review and distinguishes it from status refresh', () => {
    const waiting = safeReelDetail({ ...detail, processing: { request_allowed: true, reason: 'provider_review_required', priority: 'normal', estimate: detail.processing.estimate, queue_position: 5549 } });
    expect(waiting.processing).toMatchObject({ request_allowed: true, reason: 'provider_review_required', estimate: null });
    const render = (value: ReelDetail) => renderToStaticMarkup(createElement(ReelResearchPanels, { reel, detail: value, loading: false, retry: () => {}, request: async () => {}, videoRef: createRef<HTMLVideoElement>(), onSave: () => {} }));
    const markup = render(waiting);
    expect(markup).toContain('Get transcript');
    const header = markup.match(/<section[^>]*id="reel-transcript"[^>]*><div class="reel-detail-section-heading">[\s\S]*?<div class="reel-research-panel-body">/)![0];
    expect(header).toContain('Get transcript');
    expect(markup).toContain('Blocked by provider review');
    expect(markup).toContain('processing resumes after the provider review is resolved');
    expect(markup).not.toContain('Refresh Reel details and transcript status');
    expect(markup).not.toContain('reel-media-retry');
    expect(markup).not.toContain('Estimated wait:');
    const prioritized = render({ ...waiting, processing: { ...waiting.processing, priority: 'high', queue_position: 1 } });
    expect(prioritized).toMatch(/disabled=""[^>]*>.*?Transcript requested/s);
    expect(prioritized).toContain('Queue position is the order of waiting Reels, not an active processing slot');
    for (const status of ['uncertain', 'failed', 'processing', 'submitting', 'ready', 'no_speech']) {
      expect(safeReelDetail({ ...waiting, transcript: { ...waiting.transcript, status } }).processing.request_allowed).toBe(false);
    }
  });
  it.each(['http://video.cdninstagram.com/x', 'https://cdninstagram.com/x', 'https://evil.test/x', 'https://video.cdninstagram.com.evil.test/x', 'https://video.cdninstagram.com:443/x', 'https://user@video.cdninstagram.com/x', 'https://video.cdninstagram.com/x#fragment', 'https://127.0.0.1/x', 'https://video..cdninstagram.com/x'])('rejects unsafe media: %s', value => expect(reelPlaybackUrl(value)).toBeNull());
  it('only exposes validated playback data and plausible measured estimates', () => {
    const safe = safeReelDetail({ ...detail, private_secret: 'secret', media: { ...detail.media, source_url: 'private', urls: [...detail.media.urls, ...detail.media.urls, 'https://evil.test/x'], candidates: ['private'] } });
    expect(safe.media.urls).toEqual(detail.media.urls);
    expect(safe.processing.estimate).toEqual({ ...detail.processing.estimate, estimated_at: '2026-11-09T12:00:00.000Z' });
    expect(JSON.stringify(safe)).not.toMatch(/private|secret|evil/);
    expect(safeReelDetail({ ...detail, processing: { ...detail.processing, estimate: { ...detail.processing.estimate, sample_count: 4 } } }).processing.estimate).toBeNull();
    expect(safeReelDetail({ ...detail, processing: { ...detail.processing, reason: 'unrecognized' } }).processing).toMatchObject({ request_allowed: false, reason: 'setup_required', estimate: null });
    expect(() => safeReelDetail({ ...detail, transcript: { ...detail.transcript, reel_id: 'bad' } })).toThrow('Reel details could not be loaded');
    expect(transcriptEstimateLabel(detail.processing.estimate)).toContain('queue times can vary');
    expect(transcriptEstimateLabel(null)).toBeNull();
  });
  it('does not enqueue or invent live transcripts in demo mode', async () => {
    const repo = new DemoRepository();
    const workspace = (await repo.bootstrap()).workspaces[0];
    const first = (await repo.reels(workspace.id, {})).items[0];
    const before = await repo.jobs();
    expect((await repo.requestTranscript(workspace.id, first.id)).processing).toEqual({ request_allowed: false, reason: 'demo', estimate: null });
    expect(await repo.jobs()).toEqual(before);
    await expect(repo.reelDetail(workspace.id, 'missing')).rejects.toThrow('Reel not found');
  });
  it('exposes full source captions and only explicitly authorized definitive retries', () => {
    const caption_full = 'Complete caption.\n\n' + 'More source words '.repeat(70);
    const safe = safeReelDetail({ ...detail, caption_full, transcript: { ...detail.transcript, status: 'media_unavailable' }, processing: { request_allowed: true, reason: null, estimate: null } });
    expect(safe.caption_full).toBe(caption_full); expect(safe.processing.request_allowed).toBe(true);
    expect(safeReelDetail({ ...safe, caption_full: 'x'.repeat(20001) }).caption_full).toBeNull();
    expect(safeReelDetail({ ...safe, transcript: { ...safe.transcript, status: 'failed' } }).processing.request_allowed).toBe(true);
    for (const status of ['uncertain', 'processing', 'submitting']) expect(safeReelDetail({ ...safe, transcript: { ...safe.transcript, status } }).processing.request_allowed).toBe(false);
    expect(safeReelDetail({ ...safe, transcript: { ...safe.transcript, status: 'failed' }, processing: { ...safe.processing, request_allowed: false, reason: 'retry_limit_reached' } }).processing.request_allowed).toBe(false);
    const markup = renderToStaticMarkup(createElement(ReelResearchPanels, { reel, detail: safe, loading: false, retry: () => {}, request: async () => {}, videoRef: createRef<HTMLVideoElement>(), onSave: () => {} }));
    expect(markup).toContain(caption_full); expect(markup).toContain('Retry transcript');
    expect(markup).not.toContain('Full caption has not been collected');
  });

  it.each([
    { caption_full: null, loading: false, error: null, message: 'Full caption has not been collected for this Reel yet.' },
    { caption_full: '', loading: false, error: null, message: 'This Reel has no caption.' },
    { caption_full: undefined, loading: true, error: null, message: 'Loading full caption…' },
    { caption_full: 'Previously loaded caption', loading: false, error: 'Request failed', message: 'Caption could not be loaded.' },
  ])('keeps caption state distinct from the short title: $message', ({ caption_full, loading, error, message }) => {
    const current = { ...reel, caption_preview: 'Short provider title…' };
    const markup = renderToStaticMarkup(createElement(ReelResearchPanels, { reel: current, detail: { ...detail, reel: current, caption_full }, loading, error, retry: () => {}, request: async () => {}, videoRef: createRef<HTMLVideoElement>(), onSave: () => {} }));
    const section = markup.match(/<section[^>]*id="reel-caption"[\s\S]*?<\/section>/)![0];
    expect(section).toContain(message);
    expect(section).not.toContain(current.caption_preview);
    expect(section).not.toContain('Previously loaded caption');
    expect(section).toContain('aria-label="Copy caption" disabled=""');
  });
});

describe('compact Reel activation and playback', () => {
  it('keeps the requested metric order and formats followers like the other compact counts', () => {
    const current = { ...reel, followers_count: 52600 };
    const markup = renderToStaticMarkup(createElement(ReelResearchPanels, { reel: current, detail: { ...detail, reel: current }, loading: false, retry: () => {}, request: async () => {}, videoRef: createRef<HTMLVideoElement>(), onSave: () => {} }));
    const stats = markup.match(/<dl class="reel-detail-stats">[\s\S]*?<\/dl>/)![0];
    expect(stats).toContain('52.6K</dd>'); expect(stats).toContain('52,600 followers');
    const labels = ['Followers', 'Outlier score', 'Engagement rate', 'Profile outlier', 'Views', 'Likes', 'Comments'];
    expect([...stats.matchAll(/<dt>([\s\S]*?)<\/dt>/g)].map(match => match[1].replace(/<[^>]+>/g, ''))).toEqual(labels);
  });
  it('uses page navigation inside the app without mounting or declaring a dialog', () => {
    const card = createElement(ReelCard, { reel, workspaceId: 'fixture', onSave: () => {} });
    const markup = renderToStaticMarkup(createElement(ReelNavigationContext.Provider, { value: () => {} }, card));
    expect(markup).toContain(`Open Reel by @${reel.username}`);
    const activation = markup.match(/<button\b[^>]*class="reel-card-open"[^>]*>/)![0];
    expect(activation).not.toContain('aria-haspopup="dialog"');
    expect(markup).toContain('class="reel-preview-button"');
    expect(markup).not.toContain('role="dialog"');
    expect(markup).not.toContain('<video');
  });

  it('shows source summaries, original transcript and multiline caption without inventing unavailable speech', () => {
    const ready = { ...detail, caption_full: 'A recorded caption.\n\nA second paragraph.', transcript: { ...detail.transcript, status: 'ready' as const, text: 'Keep your opening clear. Show the result first. Explain each step.', segments: [] } };
    expect(reelOverview(ready)).toEqual({ text: ready.transcript.text, source: 'Transcript excerpt' });
    expect(transcriptWordCount('Hello, world! नमस्ते दुनिया')).toBe(4);
    const markup = renderToStaticMarkup(createElement(ReelResearchPanels, { reel: ready.reel, detail: ready, loading: false, retry: () => {}, request: async () => {}, videoRef: createRef<HTMLVideoElement>(), onSave: () => {} }));
    expect(markup).toContain('Transcript excerpt');
    expect(markup).toContain('11 words');
    expect(markup).toContain('A recorded caption.\n\nA second paragraph.');
    expect(markup).toContain('Copy caption');
    expect(reelOverview(detail)?.source).toBe('Caption excerpt');
    expect(reelOverview({ ...detail, reel: { ...reel, caption_preview: '' } })).toBeNull();
    expect(transcriptWordCount(null)).toBe(0);
    expect(reelOverview({ ...ready, transcript: { ...ready.transcript, text: 'longword '.repeat(200) } })!.text.length).toBeLessThanOrEqual(481);
  });

  it('offers native keyboard buttons on cards and table previews, without mounting detail work', () => {
    for (const markup of [renderToStaticMarkup(createElement(ReelCard, { reel, workspaceId: 'fixture', onSave: () => {} })), renderToStaticMarkup(createElement(ReelTable, { reels: [reel], workspaceId: 'fixture', onSave: () => {} }))]) {
      expect(markup).toContain(`Open Reel by @${reel.username}`);
      expect(markup).toContain('aria-haspopup="dialog"');
      expect(markup).not.toContain('<video');
      expect(markup).not.toContain('role="dialog"');
    }
  });
  it('loads real media as video and keeps synthetic unavailable previews honest', () => {
    const playable = renderToStaticMarkup(createElement(ReelPlayback, { reel, detail, loading: false, videoRef: createRef<HTMLVideoElement>() }));
    expect(playable).toContain('<video'); expect(playable).toContain('controls=""'); expect(playable).toContain('reel.mp4');
    const synthetic = renderToStaticMarkup(createElement(ReelPlayback, { reel, detail: { ...detail, media: { urls: [], observed_at: null }, processing: { ...detail.processing, reason: 'demo' } }, loading: false, videoRef: createRef<HTMLVideoElement>() }));
    expect(synthetic).toContain('Synthetic Reel preview'); expect(synthetic).not.toContain('<iframe');
  });
  it('renders the detail dialog with metric and caption sections before the request finishes', () => {
    const markup = renderToStaticMarkup(createElement(ReelDetailDialog, { reel, workspaceId: 'fixture', onSave: () => {}, onClose: () => {} }));
    expect(markup).toContain('role="dialog"'); expect(markup).toContain('Loading Reel details');
    expect(markup).toContain('Views'); expect(markup).toContain('Caption'); expect(markup).toContain('More details');
  });
});

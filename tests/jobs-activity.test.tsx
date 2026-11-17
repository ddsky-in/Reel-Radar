import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Jobs } from '../src/components/operations';
import { createDemoData } from '../src/lib/demo';
import { safeBootstrap } from '../src/lib/server/public-data';
import type { Bootstrap, Job, JobStatus } from '../src/lib/types';

const fixtures = vi.hoisted(() => ({
  data: null as Bootstrap | null, loading: false, refreshing: false, error: null as string | null,
  active: false, slots: [] as unknown[], cursor: 0, reads: [] as { path: string; revision: number }[],
}));
vi.mock('@/lib/use-resource', () => ({ useResource: (path: string, revision: number) => {
  fixtures.reads.push({ path, revision });
  return { data: path === '/api/bootstrap' ? fixtures.data : null, loading: path === '/api/bootstrap' && fixtures.loading, refreshing: fixtures.refreshing, error: path === '/api/bootstrap' ? fixtures.error : null };
} }));
vi.mock('react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  return { ...react, useState: (initial: unknown) => {
    if (!fixtures.active) return react.useState(initial);
    const index = fixtures.cursor++;
    if (!(index in fixtures.slots)) fixtures.slots[index] = initial;
    return [fixtures.slots[index], (next: unknown) => { fixtures.slots[index] = typeof next === 'function' ? next(fixtures.slots[index]) : next; }];
  } };
});

const demo = createDemoData();
const bootstrap: Bootstrap = { mode: 'supabase', workspaces: demo.workspaces, settings: { ...demo.settings, scraping_enabled: true }, usage: { estimated_month_spend: 0, actual_month_spend: null, reserved_usd: 0, unreconciled_jobs: 0, remaining_allowance: 4, provider_balance_usd: null }, email: 'fixture@example.invalid', jobs: [] };
function job(status: JobStatus, overrides: Partial<Job> = {}): Job {
  return { id: `job-${status}`, kind: 'manual', status, scheduled_for: '2026-11-14T17:30:00Z', started_at: null, completed_at: null,
    actor_run_id: null, requested_profiles_count: 2, returned_records_count: 0, estimated_cost_usd: 0, actual_cost_usd: null,
    error_message: null, attempt_count: 0, results_limit: 30, ...overrides };
}
const notify = vi.fn(), paidRefresh = vi.fn(async () => {});
function render() {
  fixtures.active = true; fixtures.cursor = 0;
  try { return Jobs({ bootstrap: fixtures.data ?? bootstrap, notify, refresh: paidRefresh, revision: 7 }); }
  finally { fixtures.active = false; }
}
type Props = { children?: ReactNode; onClick?: () => void; onToggle?: (event: { currentTarget: { open: boolean } }) => void; onChange?: (event: { target: { value: string } }) => void; disabled?: boolean; revision?: number; showJobs?: boolean; 'aria-pressed'?: boolean; className?: string };
function nodes(tree: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!isValidElement<Props>(tree)) return [];
  return [tree, ...nodes(tree.props.children)];
}
function button(tree: ReactNode, text: string) {
  return nodes(tree).find(node => node.type === 'button' && (node.props.children === text || Array.isArray(node.props.children) && node.props.children.includes(text)))!;
}
function rowIds(tree: ReactNode) { return nodes(tree).filter(node => node.type === 'li').map(node => node.key); }
function markup() { return renderToStaticMarkup(render()); }

beforeEach(() => {
  fixtures.data = { ...bootstrap, jobs: [] }; fixtures.loading = false; fixtures.refreshing = false; fixtures.error = null;
  fixtures.active = false; fixtures.slots = []; fixtures.cursor = 0; fixtures.reads = []; notify.mockClear(); paidRefresh.mockClear();
});

describe('compact read-only Job Activity', () => {
  it('keeps recent-only counters and classifies every job status without mixing holds into running', () => {
    const statuses: JobStatus[] = ['pending', 'dispatching', 'running', 'processing', 'succeeded', 'partial', 'failed', 'budget_paused', 'uncertain'];
    fixtures.data!.jobs = statuses.map(status => job(status));
    let tree = render();
    for (const [label, count] of [['All activity', 9], ['Queued', 1], ['Running', 3], ['Needs attention', 4], ['Completed', 1]] as const) {
      expect((button(tree, label).props.children as ReactNode[])[1]).toMatchObject({ props: { children: count } });
    }
    button(tree, 'Queued').props.onClick!(); tree = render(); expect(rowIds(tree)).toEqual(['job-pending']);
    button(tree, 'Running').props.onClick!(); tree = render(); expect(rowIds(tree)).toEqual(['job-dispatching', 'job-running', 'job-processing']);
    button(tree, 'Needs attention').props.onClick!(); tree = render(); expect(rowIds(tree)).toEqual(['job-partial', 'job-failed', 'job-budget_paused', 'job-uncertain']);
    expect(button(tree, 'Needs attention').props['aria-pressed']).toBe(true);
    button(tree, 'Completed').props.onClick!(); tree = render(); expect(rowIds(tree)).toEqual(['job-succeeded']);
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('not the complete backlog'); expect(html).toContain('Showing 1 of 9 recent jobs');
    expect(html).not.toContain('Actual billed this month'); expect(html).not.toContain('Run workspace refresh');
    expect(html).not.toContain('jobs-table');
  });

  it('searches returned kind/status/ID metadata without promising unavailable accounts or raw errors', () => {
    fixtures.data = safeBootstrap({ ...bootstrap, jobs: [job('running', { kind: 'profile', actor_run_id: 'known-provider-run' }), job('failed', { kind: 'carousel', error_message: 'Provider timed out token=secret' })] });
    let tree = render();
    const search = () => nodes(tree).find(node => node.type === 'input')!;
    search().props.onChange!({ target: { value: ' PROFILE ' } }); tree = render(); expect(rowIds(tree)).toEqual(['job-running']);
    search().props.onChange!({ target: { value: 'known-provider-run' } }); tree = render(); expect(rowIds(tree)).toEqual(['job-running']);
    search().props.onChange!({ target: { value: 'FAILED' } }); tree = render(); expect(rowIds(tree)).toEqual(['job-failed']);
    button(tree, 'Running').props.onClick!(); tree = render(); expect(rowIds(tree)).toEqual([]);
    expect(renderToStaticMarkup(tree)).toContain('No matching jobs');
    button(tree, 'Clear filters').props.onClick!(); tree = render(); expect(rowIds(tree)).toHaveLength(2);
    search().props.onChange!({ target: { value: 'TIMED OUT' } }); tree = render(); expect(rowIds(tree)).toEqual([]);
    button(tree, 'Clear filters').props.onClick!(); tree = render();
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('Recent jobs across your workspaces');
    expect(html).toContain('Creator names are not included');
    expect(html).toContain('Search kind, status or job ID');
    expect(html).not.toContain('Search kind, account or error');
    expect(html).not.toContain('token=secret'); expect(html).not.toContain('Apify account');
  });

  it('refreshes only the read resource and preserves legacy callback compatibility and separate transcription', () => {
    let tree = render(); button(tree, 'Refresh activity').props.onClick!(); tree = render();
    expect(fixtures.reads).toEqual([{ path: '/api/bootstrap', revision: 7 }, { path: '/api/bootstrap', revision: 8 }]);
    expect(paidRefresh).not.toHaveBeenCalled(); expect(notify).toHaveBeenCalledWith('Refreshing job activity.');
    const transcriptionNode = () => nodes(tree).find(node => typeof node.type === 'function' && node.type.name === 'TranscriptionSection');
    expect(transcriptionNode()).toBeUndefined();
    expect(fixtures.reads.every(read => read.path === '/api/bootstrap' || read.path === '/api/jobs/holds?page=1&limit=25')).toBe(true);
    const toggle = nodes(tree).find(node => node.props.className === 'jobs-transcription-toggle')!;
    toggle.props.onToggle!({ currentTarget: { open: true } }); tree = render();
    expect(transcriptionNode()!.props).toMatchObject({ revision: 8, showJobs: true });
    toggle.props.onToggle!({ currentTarget: { open: false } }); tree = render(); expect(transcriptionNode()).toBeUndefined();
    fixtures.refreshing = true; tree = render(); expect(button(tree, 'Refresh activity').props.disabled).toBe(true);
    expect(renderToStaticMarkup(tree)).toContain('Updating activity…');
    expect(renderToStaticMarkup(tree)).not.toContain('Last updated');
  });

  it('uses actual IST event timestamps, unknown billing badges and full protected-hold details', () => {
    fixtures.data = safeBootstrap({ ...bootstrap, jobs: [job('uncertain', { kind: 'carousel', apify_account_slot: 2, error_message: 'Submission accepted? Needs review', returned_records_count: 8,
      started_at: '2026-11-14T18:00:00Z', actor_run_id: 'provider-run-known' })] });
    const html = markup();
    expect(html).toContain('Protected hold'); expect(html).toContain('Submission may have been accepted and billed');
    expect(html).toContain('Review is required before another paid attempt'); expect(html).toContain('Cost unknown');
    expect(html).toContain('8 records returned'); expect(html).toContain('14 Nov 2026'); expect(html).toContain('11:30 pm IST');
    expect(html).toContain('dateTime="2026-11-14T18:00:00Z"'); expect(html).toContain('provider-run-known');
    expect(html).toContain('<summary aria-label="Details for Carousel fetch job job-uncertain">Details</summary>');
    expect(html).toContain('Status details'); expect(html).toContain('Requested posts / profile');
    expect(html).not.toContain('$0.00'); expect(html).not.toContain('<progress');
    fixtures.data!.jobs = [job('succeeded', { completed_at: '2026-11-14T18:30:00Z', actual_cost_usd: 0.12 })];
    expect(markup()).toContain('$0.12 billed'); expect(markup()).toContain('15 Nov 2026');
  });

  it.each([0, 8])('shows bounded discovery as a capped recent window with %i actual returns, not 50 guaranteed', returned => {
    fixtures.data = safeBootstrap({ ...bootstrap, jobs: [job('succeeded', { kind: 'discovery', discovery_bounded: true, results_limit: 50,
      requested_profiles_count: 1, returned_records_count: returned })] });
    const html = markup();
    expect(html).toContain('<h3>Discovery collection</h3>');
    expect(html).toContain('<dt>Maximum discovery scan / profile</dt><dd>50</dd>');
    expect(html).toContain('recent window capped at 50 Reels per profile');
    expect(html).toContain('not 50 guaranteed returns or 50 new Reels');
    expect(html).toContain('older Reels outside that window may be missed');
    expect(html).toContain(`${returned} records returned`);
    for (const text of ['Historical discovery scan', '<dt>Requested posts / profile</dt>', 'Extra Reel buffer', '<dt>Tracked Reels</dt>']) expect(html).not.toContain(text);
    expect(html).toContain('Cost unknown'); expect(paidRefresh).not.toHaveBeenCalled();
    expect(fixtures.reads.every(read => read.path === '/api/bootstrap' || read.path === '/api/jobs/holds?page=1&limit=25')).toBe(true);
  });

  it.each([
    [undefined, 10_000], [false, 10_000], [true, 10_000], [undefined, 50], [false, 50],
  ] as const)('retains historical discovery when flag is %s and original limit is %i', (bounded, limit) => {
    fixtures.data = safeBootstrap({ ...bootstrap, jobs: [job('succeeded', { kind: 'discovery', discovery_bounded: bounded, results_limit: limit })] });
    const html = markup();
    expect(html).toContain('Historical discovery scan: this job retains its original request limit');
    expect(html).toContain(`<dt>Requested posts / profile</dt><dd>${limit.toLocaleString('en-US')}</dd>`);
    expect(html).not.toContain('Maximum discovery scan / profile');
    expect(html).not.toContain('recent window capped at 50 Reels per profile');
  });

  it.each(['daily', 'weekly', 'backfill', 'profile', 'manual', 'retry', 'carousel'] as const)('does not apply discovery metadata to %s jobs', kind => {
    fixtures.data = safeBootstrap({ ...bootstrap, jobs: [job('pending', { kind, discovery_bounded: true, results_limit: 50 })] });
    const html = markup();
    expect(html).toContain(`<dt>Requested posts / profile</dt><dd>50${kind === 'carousel' ? ' photo posts' : ''}</dd>`);
    expect(html).not.toContain('Maximum discovery scan / profile'); expect(html).not.toContain('Historical discovery scan');
  });

  it.each([
    [1, 51], [73, 123], [9_950, 10_000], [9_951, 10_000], [10_000, 10_000], [10_050, 10_000],
  ])('shows the frozen tracked count %i and bounded requested maximum %i for metrics jobs', (tracked, maximum) => {
    fixtures.data = safeBootstrap({ ...bootstrap, jobs: [job('pending', { kind: 'metrics', metrics_tracked_count: tracked, results_limit: maximum, requested_profiles_count: 1 })] });
    const html = markup();
    expect(html).toContain('<h3>Metrics refresh</h3>'); expect(html).toContain('<p>1 profile</p>');
    expect(html).toContain(`<dt>Tracked Reels</dt><dd>${tracked.toLocaleString('en-US')}</dd>`);
    expect(html).toContain('<dt>Extra Reel buffer</dt><dd>50</dd>');
    expect(html).toContain(`<dt>Maximum requested / profile</dt><dd>${maximum.toLocaleString('en-US')}</dd>`);
    expect(html).toContain('Tracked Reel count is frozen for this job.');
    expect(html).toContain('Only existing tracked Reels are updated; extra/new Reels are not imported.');
    const capNote = 'The 10,000-Reel request cap makes the effective extra Reel buffer smaller than 50.';
    if (tracked > 9_950) expect(html).toContain(capNote); else expect(html).not.toContain(capNote);
    expect(html).not.toContain('Historical broad scan'); expect(html).not.toContain('<dt>Requested posts / profile</dt>');
    expect(html).toContain('Cost unknown'); expect(paidRefresh).not.toHaveBeenCalled();
  });

  it.each([null, undefined])('keeps historical metrics with count %s labeled as broad scans', tracked => {
    fixtures.data = safeBootstrap({ ...bootstrap, jobs: [job('succeeded', { kind: 'metrics', metrics_tracked_count: tracked, results_limit: 10_000 })] });
    const html = markup();
    expect(html).toContain('<h3>Metrics refresh</h3>');
    expect(html).toContain('Historical broad scan: no frozen tracked Reel count was recorded for this job.');
    expect(html).toContain('<dt>Requested posts / profile</dt><dd>10,000</dd>');
    for (const boundedText of ['<dt>Tracked Reels</dt>', 'Extra Reel buffer', 'Maximum requested / profile', 'Only existing tracked Reels are updated']) expect(html).not.toContain(boundedText);
  });

  it.each(['daily', 'weekly', 'backfill', 'profile', 'manual', 'retry', 'discovery', 'carousel'] as const)('preserves requested labels for %s jobs', kind => {
    fixtures.data!.jobs = [job('pending', { kind, metrics_tracked_count: 73 })];
    const html = markup();
    expect(html).toContain(`<dt>Requested posts / profile</dt><dd>30${kind === 'carousel' ? ' photo posts' : ''}</dd>`);
    for (const metricsText of ['<dt>Tracked Reels</dt>', 'Extra Reel buffer', 'Maximum requested / profile', 'Historical broad scan', 'Only existing tracked Reels are updated']) expect(html).not.toContain(metricsText);
  });

  it.each([
    ['failed', 'This collection failed.'], ['partial', 'Only part of this collection completed.'],
    ['budget_paused', 'This collection is on a budget hold.'], ['uncertain', 'Submission may have been accepted and billed.'],
  ] as const)('renders sanitized %s status details without provider errors or tokens', (status, safeLabel) => {
    fixtures.data = safeBootstrap({ ...bootstrap, workspaces: [], jobs: [job(status, { error_message: 'Provider timed out Authorization: Bearer secret-token https://provider.invalid?token=private' })] });
    const html = markup();
    expect(html).toContain(safeLabel); expect(html).toContain('Status details'); expect(html).toContain('Cost unknown');
    for (const privateText of ['Provider timed out', 'Authorization', 'secret-token', 'provider.invalid', 'token=private']) expect(html).not.toContain(privateText);
    expect(html).not.toContain('Apify account');
  });

  it('makes synthetic provenance explicit without presenting demo amounts as real bills', () => {
    fixtures.data = { ...bootstrap, mode: 'demo', jobs: [job('succeeded', { actual_cost_usd: 0, estimated_cost_usd: 0 })] };
    const html = markup(); expect(html).toContain('not verified Instagram data'); expect(html).toContain('No external provider is called');
    expect(html).toContain('Synthetic billing'); expect(html).not.toContain('$0.00');
  });

  it('shows unavailable counts before loading and preserves last-good rows on update failures', () => {
    fixtures.data = null; fixtures.loading = true;
    let html = markup(); expect(html).toContain('Loading activity…'); expect(html).not.toContain('Showing 0 of 0');
    expect(button(render(), 'Queued').props.disabled).toBe(true);
    fixtures.loading = false; fixtures.error = 'Service unavailable';
    html = markup(); expect(html).toContain('We couldn’t load this data'); expect(html).not.toContain('No recent collection jobs');
    fixtures.data = { ...bootstrap, jobs: [job('pending')] };
    html = markup(); expect(html).toContain('Showing the last loaded list'); expect(html).toContain('Queued fetch');
    expect(html).toContain('role="alert"'); expect(html).not.toContain('Last updated');
  });

  it('keeps disabled-collection setup visible and queued work distinct from completed work', () => {
    fixtures.data = { ...bootstrap, settings: { ...bootstrap.settings, scraping_enabled: false }, jobs: [job('pending')] };
    const html = markup(); expect(html).toContain('Live collection is disabled'); expect(html).toContain('refreshing activity does not enable collection');
    expect(html).toContain('Waiting for background collection to start'); expect(html).not.toContain('0 records returned');
    expect(html).toContain('Not started'); expect(html).toContain('Not completed');
    expect(html).toContain('aria-label="Filter recent job activity"'); expect(html).toContain('Search job activity');
  });
});

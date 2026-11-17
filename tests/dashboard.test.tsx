import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bootstrap, Overview } from '../src/lib/types';
import { DemoRepository } from '../src/lib/server/demo-repository';
import { reelDetailPath } from '../src/lib/app-navigation';
import { Dashboard } from '../src/components/dashboard';

const fixture = vi.hoisted(() => ({ data: undefined as Overview | undefined, loading: false, error: null as string | null }));
vi.mock('../src/components/ui', async () => {
  const ui = await vi.importActual<typeof import('../src/components/ui')>('../src/components/ui');
  return { ...ui, useResource: () => fixture };
});

let bootstrap: Bootstrap;
let workspaceId: string;
function render() { return renderToStaticMarkup(<Dashboard workspaceId={workspaceId} bootstrap={bootstrap} notify={() => {}} revision={0}/>); }

beforeEach(async () => {
  delete (globalThis as typeof globalThis & { __reelradarDemo?: unknown }).__reelradarDemo;
  const repo = new DemoRepository();
  bootstrap = await repo.bootstrap();
  workspaceId = bootstrap.workspaces[0].id;
  fixture.data = await repo.overview(workspaceId);
  fixture.loading = false;
  fixture.error = null;
});

describe('dashboard research snapshot', () => {
  it('opens the five latest Reels with workspace context and a return path to the dashboard', () => {
    const html = render();
    expect(html).toContain('<h1>Dashboard</h1>');
    const reelLinks = html.match(/<a\b[^>]*class="dashboard-reel-link"[^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(reelLinks).toHaveLength(5);
    for (const [index, reel] of fixture.data!.recent.slice(0, 5).entries()) {
      expect(reelLinks[index]).toContain(`href="${reelDetailPath(reel.id, workspaceId, '/dashboard').replaceAll('&', '&amp;')}"`);
      expect(reelLinks[index]).toContain(renderToStaticMarkup(<>{reel.caption_preview || `Reel by @${reel.username}`}</>));
      expect(reelLinks[index]).not.toMatch(/^<a[^>]*aria-label=/);
      expect(html).toContain(`${reel.saved ? 'Unsave' : 'Save'} Reel by @${reel.username}`);
    }
    expect(html).toContain('<span class="sr-only"> Reels at 10x or above</span>');
    expect(html).toContain('href="/reels"');
    expect(html).toContain('href="/creators"');
    expect(html).not.toContain('href="/outliers"');
    expect(html).toContain('Browse Reels');
    expect(html).not.toContain('Minimum Views');
  });

  it('preserves missing metrics, unverified dates, and unknown billing without substituting estimates', () => {
    fixture.data = { ...fixture.data!, average_engagement: null, recent: [{ ...fixture.data!.recent[0], latest_views: null, views_state: 'hidden', follower_outlier_score: null, published_at: null, thumbnail_url: null, provider: 'mock' }] };
    bootstrap.usage = { ...bootstrap.usage, actual_month_spend: null, estimated_month_spend: 12.34, provider_balance_usd: null };
    const html = render();
    expect(html).toContain('Hidden');
    expect(html).toContain('N/A');
    expect(html).toContain('Date unverified');
    expect(html).toContain('Synthetic preview');
    expect(html).toContain('Synthetic demo');
    expect(html).toContain('<dt>Actual billed</dt><dd>Unknown</dd>');
    expect(html).toContain('<dt>Provider balance</dt><dd>Unknown</dd>');
    expect(html).not.toContain('$12.34');
    bootstrap.usage.actual_month_spend = 0;
    bootstrap.usage.provider_balance_usd = 0;
    const reconciled = render();
    expect(reconciled).toContain('<dt>Actual billed</dt><dd>$0.00</dd>');
    expect(reconciled).toContain('<dt>Provider balance</dt><dd>$0.00</dd>');
  });

  it('offers an add-creators action for an empty workspace while retaining status details', () => {
    fixture.data = { active_competitors: 0, tracked_reels: 0, outliers: 0, average_engagement: null, last_refresh: null, stale_reels: 0, recent: [], leaderboard: [] };
    const html = render();
    expect(html).toContain('Your research starts here');
    expect(html).toContain('Add creators');
    expect(html).toContain('href="/creators"');
    expect(html).toContain('No collection yet');
    expect(html).toContain('href="/jobs"');
    expect(html).toContain('href="/settings"');
    expect(html).toContain('<details class="dashboard-activity">');
    expect(html).not.toContain('<details class="dashboard-activity" open');
  });

  it('directs creators awaiting initial collection to job activity', async () => {
    const repo = new DemoRepository();
    const workspace = await repo.createWorkspace('Awaiting collection');
    await repo.addCreator(workspace.id, 'pending_dashboard_creator');
    workspaceId = workspace.id;
    bootstrap = await repo.bootstrap();
    fixture.data = await repo.overview(workspaceId);
    expect(fixture.data.tracked_reels).toBe(0);
    expect(fixture.data.leaderboard[0].creator.status).toBe('pending');
    const html = render();
    const recentSection = html.match(/<section class="dashboard-panel dashboard-recent"[\s\S]*?<\/section>/)?.[0];
    expect(recentSection).toBeDefined();
    expect(recentSection).toContain('No Reels collected yet');
    expect(recentSection).toContain('href="/jobs"');
    expect(recentSection).toContain('View job activity');
    expect(html).not.toContain('Add creators');
  });

  it('distinguishes loading and failed reads from an empty workspace, and retains cached research on errors', () => {
    const cached = fixture.data;
    fixture.data = undefined;
    fixture.loading = true;
    expect(render()).toContain('Loading data');
    expect(render()).not.toContain('Your research starts here');
    fixture.loading = false;
    fixture.error = 'Unable to refresh this workspace.';
    expect(render()).toContain('We couldn’t load this data');
    expect(render()).not.toContain('Your research starts here');
    fixture.data = cached;
    const html = render();
    expect(html).toContain('Background update failed:');
    expect(html).toContain(`href="${reelDetailPath(cached!.recent[0].id, workspaceId, '/dashboard').replaceAll('&', '&amp;')}"`);
    expect(html).toContain('Retry');
  });
});

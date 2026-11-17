import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const component = (name: string) => readFileSync(join(process.cwd(), `src/components/${name}.tsx`), 'utf8');

describe('research UI content cleanup', () => {
  it('removes promotional chrome rather than hiding it with CSS', () => {
    const shell = component('app');
    expect(shell).not.toContain('THE SIGNAL IN THE SCROLL');
    expect(shell).not.toContain('Stay curious.');
    expect(shell).not.toContain('className="sidebar-note"');
    expect(shell).not.toContain('className="app-footer"');
    expect(shell).toContain('Skip to content');
    expect(shell).toContain('Main navigation');
    expect(shell).toContain('no provider calls');
  });
  it('retains research dashboard data while removing the insight advertisement', () => {
    const dashboard = component('dashboard');
    expect(dashboard).not.toContain('className="insight-card"');
    expect(dashboard).toContain('overview.last_refresh');
    expect(dashboard).toContain('bootstrap.usage.actual_month_spend');
    expect(dashboard).toContain('bootstrap.settings.scraping_enabled');
    expect(dashboard).toContain('bootstrap.settings.paused');
  });
  it('keeps simple login and workspace actions without decorative sections', () => {
    const login = component('login-form'), workspaces = component('workspaces');
    expect(login).not.toContain('login-editorial');
    expect(login).toContain('Owner-only access');
    expect(login).toContain('type="email"');
    expect(login).toContain('showPassword');
    expect(workspaces).not.toContain('workspace-illustration');
    expect(workspaces).not.toContain('workspace-new-card');
    expect(workspaces).toContain('Show archived');
    expect(workspaces).toContain('New workspace');
  });
  it('preserves calculation, source and timestamp provenance in tooltips', () => {
    const reels = component('reels');
    expect(reels).toContain('publicationDetails');
    expect(reels).toContain('assumed_Asia/Kolkata');
    expect(reels).toContain('published_at_raw');
    expect(reels).toContain('follower_captured_at');
    expect(reels).toContain('latest_fetched_at');
    expect(reels).toContain('SourceLink');
  });
});

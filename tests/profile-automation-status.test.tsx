import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProfileAutomationSummary } from '../src/components/profile-automation';
import { safeProfileAutomation } from '../src/lib/server/public-data';
import { resourceMatchesFamilies } from '../src/lib/resource-dependencies';
import type { ProfileAutomationStatus } from '../src/lib/types';

const status: ProfileAutomationStatus = { enabled: true, provider_validated: true, paused: false, reason: null,
  interval_hours: 24, batch_limit: 20, due_creators: 193, pending_jobs: 1, active_jobs: 0,
  last_fetch_at: '2026-11-15T10:00:00.000Z', next_due_at: '2026-11-16T10:00:00.000Z' };

describe('read-only combined daily profile status', () => {
  it('projects only validated public status fields, never privileged provider data', () => {
    expect(safeProfileAutomation({ ...status, secret: 'private', provider_token: 'private' })).toEqual(status);
  });
  it.each(['due_creators', 'pending_jobs', 'active_jobs'] as const)('rejects malformed count %s', field => {
    for (const value of [-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) expect(() => safeProfileAutomation({ ...status, [field]: value })).toThrow('Daily profile refresh status');
  });
  it.each([{ interval_hours: 1 }, { batch_limit: 200 }, { reason: 'raw provider failure' }, { last_fetch_at: 'invalid' }, { next_due_at: undefined }, { enabled: 'true' }])('fails closed on invalid fields %j', fields => {
    expect(() => safeProfileAutomation({ ...status, ...fields })).toThrow('Daily profile refresh status');
  });
  it('explains one shared response and does not offer a paid action', () => {
    const html = renderToStaticMarkup(<ProfileAutomationSummary status={status}/>);
    expect(html).toContain('Daily profile refresh active');
    expect(html).toContain('One profile fetch updates followers, name and the profile-picture URL together.');
    expect(html).toContain('No separate paid photo fetch.');
    expect(html).toContain('batches of up to 20');
    expect(html).toContain('not live');
    expect(html).not.toContain('<button');
    expect(html).toContain('1 queued');
  });
  it.each(['concurrency_limit', 'unreconciled_charges', 'budget_paused', 'usage_unverified'] as const)('shows protected blocking reason %s', reason => {
    const html = renderToStaticMarkup(<ProfileAutomationSummary status={{ ...status, reason, next_due_at: null }}/>);
    expect(html).not.toContain('Daily profile refresh active');
    expect(html).toContain('Next collection depends on setup, budget and current queue.');
  });
  it('refreshes owner-global status for profile/job/config changes but not saved research', () => {
    for (const family of ['creators', 'jobs', 'settings', 'workspaces'] as const) expect(resourceMatchesFamilies('/api/profile-automation', [family], 'another-workspace')).toBe(true);
    expect(resourceMatchesFamilies('/api/profile-automation', ['saved_reels'])).toBe(false);
    expect(resourceMatchesFamilies('/api/profile-automation', ['saved_carousels'])).toBe(false);
  });
});

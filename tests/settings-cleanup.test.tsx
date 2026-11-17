import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Settings, TranscriptionUsage } from '../src/components/operations';
import { createDemoData } from '../src/lib/demo';
import type { Bootstrap, TranscriptOverview } from '../src/lib/types';
vi.mock('@/lib/use-resource', () => ({ useResource: () => ({ data: null, loading: false, refreshing: false, error: null }) }));
const demo = createDemoData();
const bootstrap: Bootstrap = { mode: 'demo', email: 'fixture@example.invalid', workspaces: demo.workspaces, settings: demo.settings, usage: { estimated_month_spend: 0, actual_month_spend: null, reserved_usd: 0, unreconciled_jobs: 0, remaining_allowance: demo.settings.monthly_budget_usd, provider_balance_usd: null }, jobs: demo.jobs };

describe('clean Settings preserves spending and safety controls', () => {
  it('groups budgets, keeps advanced options collapsed, and retains accessible pause/save controls', () => {
    const html = renderToStaticMarkup(createElement(Settings, { bootstrap, notify: () => {} }));
    expect(html).toContain('Monthly collection budget (USD)');
    expect(html).toContain('aria-label="Pause automatic collection"');
    expect(html).toContain('id="collection-pause-hint"'); expect(html).toContain('aria-describedby="collection-pause-hint"');
    expect(html).toContain('<summary>Collection options</summary>');
    expect(html).toContain('Save changes to collection preferences'); expect(html).toContain('Synthetic demo');
    expect(html).not.toContain('Set your monthly collection and transcription budgets');
  });
  it('shows reserved amounts and unknown actual billing in separate compact stats', () => {
    const overview: TranscriptOverview = { enabled: true, paused: false, phase: 'automatic', monthly_budget_usd: 10, pilot_limit_usd: .25, estimated_month_spend: 1,
      reserved_usd: .2, actual_month_spend: null, unreconciled_jobs: 1, jobs: [], processing_ready: true };
    const html = renderToStaticMarkup(createElement(TranscriptionUsage, { overview, demo: false, compact: true }));
    expect(html).toContain('Used + reserved'); expect(html).toContain('Pending holds'); expect(html).toContain('Actual billed'); expect(html).toContain('Unknown');
    expect(html).toContain('<summary>Billing details</summary>'); expect(html).toContain('Reservations are not billed charges');
  });
});

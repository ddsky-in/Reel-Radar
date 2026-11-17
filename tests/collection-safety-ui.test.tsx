import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionHoldsPanel, CollectionRecoveryDialog, CollectionSpending, Settings } from '../src/components/operations';
import { ApifyAccountsPanel, BillingSyncSummary } from '../src/components/apify-accounts';
import { createDemoData } from '../src/lib/demo';
import type { BillingSyncResult, Bootstrap, CollectionHolds, CollectionJobRecovery } from '../src/lib/types';

const fixture = vi.hoisted(() => ({ active: false, slots: [] as unknown[], cursor: 0, reads: [] as string[], recovery: null as CollectionJobRecovery | null, holds: null as CollectionHolds | null,
  request: vi.fn(), invalidation: vi.fn() }));
vi.mock('@/lib/use-resource', () => ({ useResource: (path: string) => { fixture.reads.push(path); return { data: path.includes('/recovery') ? fixture.recovery : path.includes('/holds') ? fixture.holds : null, loading: false, refreshing: false, error: null }; } }));
vi.mock('@/lib/client', async () => { const actual = await vi.importActual<typeof import('../src/lib/client')>('@/lib/client'); return { ...actual, api: fixture.request }; });
vi.mock('@/lib/resource-cache', () => ({ invalidateResourceFamilies: fixture.invalidation }));
vi.mock('react', async () => {
  const react = await vi.importActual<typeof import('react')>('react');
  const slot = (initial: unknown) => { const index = fixture.cursor++; if (!(index in fixture.slots)) fixture.slots[index] = typeof initial === 'function' ? initial() : initial; return index; };
  return { ...react, useState: (initial: unknown) => {
    if (!fixture.active) return react.useState(initial);
    const index = slot(initial); return [fixture.slots[index], (next: unknown) => { fixture.slots[index] = typeof next === 'function' ? next(fixture.slots[index]) : next; }];
  }, useRef: (initial: unknown) => { if (!fixture.active) return react.useRef(initial); const index = slot({ current: initial }); return fixture.slots[index]; } };
});
const id = '22222222-2222-4222-8222-222222222222';
const held: CollectionJobRecovery = { id, kind: 'carousel', status: 'uncertain', account_slot: 2, reserved_usd: .31, claimed_cap_usd: .1,
  reservation_started_at: '2026-11-01T00:00:00Z', uncertain_since: null, dispatch_phase: 'legacy', operational_disposition: 'protected', actual_cost_usd: null,
  recovery_reason: 'Historical submission outcome is unknown.', recovery_attempts: 3, expected_version: 7, creators: [{ id: '33333333-3333-4333-8333-333333333333', username: 'synthetic_fixture' }], audit: [] };
const data = createDemoData();
const bootstrap: Bootstrap = { mode: 'supabase', workspaces: data.workspaces, settings: { ...data.settings, collection_job_cap_usd: .1, scraping_enabled: true }, jobs: [], email: 'fixture@example.invalid',
  usage: { estimated_month_spend: .3, actual_month_spend: null, reserved_usd: .31, unreconciled_jobs: 3, remaining_allowance: 5, provider_balance_usd: null, reconciled_month_spend_usd: .02, risk_released_exposure_usd: .4 },
  collection_capacity: { occupied_slots: 5, uncertain_slots: 3, max_active: 5, paid_starts_gated: true } };
const billing: BillingSyncResult = { sync: { accounts: [{ accountSlot: 1, enabled: true, success: false, syncedAt: null, error: 'usage_unverified' }, { accountSlot: 2, enabled: true, success: true, syncedAt: '2026-11-16T00:00:00Z', error: null }],
  runs: { checked: 3, reconciled: 1, unknown: 2, failed: 0 }, paidStarts: 0, syncedAt: '2026-11-16T00:00:00Z' } };
const notify = vi.fn(), close = vi.fn();
function direct(factory: () => ReactNode) { fixture.active = true; fixture.cursor = 0; try { return factory(); } finally { fixture.active = false; } }
type Props = { children?: ReactNode; onClick?: () => void | Promise<void>; onSubmit?: (event: unknown) => Promise<void>; onChange?: (event: { target: { value?: string; checked?: boolean } }) => void; disabled?: boolean; type?: string; checked?: boolean; name?: string; min?: string; max?: string; step?: string; value?: string; 'aria-label'?: string };
function nodes(tree: ReactNode): ReactElement<Props>[] { if (Array.isArray(tree)) return tree.flatMap(nodes); if (!isValidElement<Props>(tree)) return []; return [tree, ...nodes(tree.props.children)]; }
function control(tree: ReactNode, text: string) { return nodes(tree).find(node => node.props.children === text || Array.isArray(node.props.children) && node.props.children.includes(text))!; }
function renderRecovery(gated = true) { return direct(() => CollectionRecoveryDialog({ jobId: id, demo: false, gated, notify, close })); }
function beginDecision(tree: ReactNode) { control(tree, 'Review risk release decision').props.onClick!(); return renderRecovery(); }
function fillDecision(tree: ReactNode) {
  nodes(tree).find(node => node.type === 'textarea')!.props.onChange!({ target: { value: 'Explicit fixture owner risk decision' } });
  nodes(tree).find(node => node.type === 'input' && node.props.type === 'checkbox')!.props.onChange!({ target: { checked: true } });
  return renderRecovery();
}
beforeEach(() => { fixture.active = false; fixture.slots = []; fixture.cursor = 0; fixture.reads = []; fixture.recovery = { ...held }; fixture.holds = { items: [held], total: 26, page: 1, limit: 25, capacity: bootstrap.collection_capacity!, usage: { reconciled_month_spend_usd: .02, risk_released_exposure_usd: .4 } }; fixture.request.mockReset(); fixture.invalidation.mockReset(); notify.mockReset(); close.mockReset(); });
afterEach(() => vi.restoreAllMocks());

describe('collection safety UI', () => {
  it('labels known subtotal, reservations, unknown released exposure and global occupied gate without remaining-money guarantees', () => {
    const html = renderToStaticMarkup(<CollectionSpending bootstrap={bootstrap}/>);
    for (const text of ['Reconciled monthly subtotal', 'Reserved · not confirmed billed', 'Risk-released exposure · still unknown', 'original held amount, not a bill or liability ceiling', 'Occupied global slots', '5 / 5', 'Uncertain occupied slots', 'administrator-controlled paid-start gate', 'guarantee budget remaining']) expect(html).toContain(text);
    expect(html).not.toContain('Guaranteed remaining');
  });
  it('renders six-decimal zero cap control independently of monthly budget', () => {
    const tree = direct(() => Settings({ bootstrap, notify }));
    const input = nodes(tree).find(node => node.type === 'input' && node.props.value === '0.1')!;
    expect(input.props).toMatchObject({ min: '0', max: '10000', step: '0.000001' });
    expect(renderToStaticMarkup(tree)).toContain('Saving never dispatches'); expect(renderToStaticMarkup(tree)).toContain('Default $0.10');
  });
  it('opens billing on demand and preserves unsaved collection preferences when switching sections', () => {
    let tree = direct(() => Settings({ bootstrap, notify }));
    expect(nodes(tree).some(node => node.type === ApifyAccountsPanel)).toBe(false);
    nodes(tree).find(node => node.type === 'input' && node.props.value === '0.1')!.props.onChange!({ target: { value: '0.05' } });
    control(tree, 'Billing & accounts').props.onClick!();
    tree = direct(() => Settings({ bootstrap, notify }));
    expect(nodes(tree).some(node => node.type === ApifyAccountsPanel)).toBe(true);
    control(tree, 'Preferences').props.onClick!();
    tree = direct(() => Settings({ bootstrap, notify }));
    expect(nodes(tree).some(node => node.type === 'input' && node.props.value === '0.05')).toBe(true);
    expect(fixture.request).not.toHaveBeenCalled();
  });
  it('loads paged holds independently from latest jobs and lazily loads recovery only after Review hold', () => {
    let tree = direct(() => CollectionHoldsPanel({ bootstrap, notify }));
    expect(fixture.reads).toEqual(['/api/jobs/holds?page=1&limit=25']);
    expect(nodes(tree).some(node => node.type === CollectionRecoveryDialog)).toBe(false);
    control(tree, 'Review hold').props.onClick!();
    tree = direct(() => CollectionHoldsPanel({ bootstrap, notify }));
    expect(nodes(tree).find(node => node.type === CollectionRecoveryDialog)!.props).toMatchObject({ jobId: id, gated: true });
    expect(fixture.request).not.toHaveBeenCalled();
    control(tree, 'Next holds').props.onClick!(); direct(() => CollectionHoldsPanel({ bootstrap, notify }));
    expect(fixture.reads.at(-1)).toBe('/api/jobs/holds?page=2&limit=25');
  });
  it('shows affected creators, historical unknown since, phase, age, recovery attempts and certified-no-start unavailable', () => {
    const html = renderToStaticMarkup(renderRecovery());
    for (const text of ['@synthetic_fixture', 'Historical / legacy', 'Reservation age', 'Not recorded for this historical hold', 'Recovery attempts', 'Verified no-start settlement is unavailable here', 'a user declaration cannot']) expect(html).toContain(text);
    expect(html).toContain('role="dialog"'); expect(html).toContain('aria-modal="true"'); expect(html).not.toContain('nonce');
  });
  it('requires explicit confirmation reason and acknowledgement; no optimistic release or automatic retry', async () => {
    let tree = beginDecision(renderRecovery());
    expect(control(tree, 'Confirm risk release').props.disabled).toBe(true);
    const form = () => nodes(tree).find(node => node.type === 'form')!;
    await form().props.onSubmit!({ preventDefault() {} }); expect(fixture.request).not.toHaveBeenCalled();
    tree = fillDecision(tree);
    let finish!: (value: CollectionJobRecovery) => void;
    fixture.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const submit = nodes(tree).find(node => node.type === 'form')!.props.onSubmit!({ preventDefault() {} });
    expect(renderToStaticMarkup(renderRecovery())).toContain('Protected'); expect(close).not.toHaveBeenCalled();
    const [path, options] = fixture.request.mock.calls[0]; const body = JSON.parse(options.body);
    expect(path).toBe(`/api/jobs/${id}/settlement`); expect(body).toMatchObject({ outcome: 'risk_release', expected_version: 7, acknowledge_unknown: true, reason: 'Explicit fixture owner risk decision' });
    expect(Object.keys(body).sort()).toEqual(['acknowledge_unknown', 'expected_version', 'idempotency_key', 'outcome', 'reason']);
    finish({ ...held, operational_disposition: 'risk_released', reserved_usd: 0 }); await submit;
    const html = renderToStaticMarkup(renderRecovery()); expect(html).toContain('Risk released · liability unknown'); expect(html).toContain('late accepted-run attachment and billing recovery continue'); expect(fixture.request).toHaveBeenCalledOnce();
  });
  it('timeout blocks new decisions until readback and never clears a hold or replays mutation', async () => {
    let tree = fillDecision(beginDecision(renderRecovery()));
    fixture.request.mockRejectedValueOnce(new Error('Request timed out. It may have completed.'));
    await nodes(tree).find(node => node.type === 'form')!.props.onSubmit!({ preventDefault() {} });
    tree = renderRecovery(); expect(control(tree, 'Review risk release decision').props.disabled).toBe(true); expect(renderToStaticMarkup(tree)).toContain('Read back stored state before any new decision'); expect(fixture.request).toHaveBeenCalledOnce();
    fixture.request.mockResolvedValueOnce({ ...held, operational_disposition: 'risk_released', reserved_usd: 0 });
    await control(tree, 'Read back stored state').props.onClick!();
    expect(fixture.request.mock.calls[1]).toEqual([`/api/jobs/${id}/recovery`]); expect(renderToStaticMarkup(renderRecovery())).toContain('Risk released · liability unknown');
    expect(fixture.request.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });
  it('requires the administrator gate and keeps released historical liability visible without a retry button', () => {
    const tree = renderRecovery(false); expect(control(tree, 'Review risk release decision').props.disabled).toBe(true);
    expect(renderToStaticMarkup(tree)).toContain('requires the administrator-controlled global paid-start gate');
    fixture.recovery = { ...held, operational_disposition: 'risk_released', reserved_usd: 0, audit: [{ created_at: '2026-11-16T00:00:00Z', outcome: 'risk_release', reason: 'Explicit owner risk release', released_usd: .31 }] };
    const html = renderToStaticMarkup(renderRecovery()); expect(html).toContain('User risk release'); expect(html).toContain('liability unknown'); expect(html).not.toContain('Confirm risk release'); expect(html).not.toContain('Retry collection');
  });
  it('preserves micro-dollar precision and allows late authoritative recovery to replace a settlement snapshot', async () => {
    fixture.recovery = { ...held, reserved_usd: .000001, claimed_cap_usd: .00005 };
    let tree = renderRecovery(); let html = renderToStaticMarkup(tree);
    expect(html).toContain('$0.000001'); expect(html).toContain('$0.00005');
    tree = fillDecision(beginDecision(tree));
    fixture.request.mockResolvedValueOnce({ ...fixture.recovery, operational_disposition: 'risk_released', reserved_usd: 0 });
    await nodes(tree).find(node => node.type === 'form')!.props.onSubmit!({ preventDefault() {} });
    fixture.recovery = { ...held, dispatch_phase: 'attached', operational_disposition: 'risk_released', actual_cost_usd: .000055, reserved_usd: 0 };
    html = renderToStaticMarkup(renderRecovery()); expect(html).toContain('Run attached'); expect(html).toContain('$0.000055');
  });
  it('billing sync is explicit only, reports per-account safe errors and does not automatically call providers', async () => {
    let tree = direct(() => ApifyAccountsPanel({ notify })); expect(fixture.request).not.toHaveBeenCalled();
    fixture.request.mockResolvedValueOnce(billing);
    await control(tree, 'Sync billing').props.onClick!();
    expect(fixture.request.mock.calls).toEqual([['/api/billing/sync', { method: 'POST', body: '{}' }]]);
    tree = direct(() => ApifyAccountsPanel({ notify }));
    expect(nodes(tree).find(node => node.type === BillingSyncSummary)!.props).toMatchObject({ value: billing });
    const html = renderToStaticMarkup(<BillingSyncSummary value={billing}/>); expect(html).toContain('Usage check failed'); expect(html).toContain('2 run cost(s) still unknown'); expect(html).toContain('starts no paid jobs');
  });
});

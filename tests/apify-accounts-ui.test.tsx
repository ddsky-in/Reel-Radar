import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { safeApifyAccounts, safeCollectionState, safeJob } from '../src/lib/server/public-data';
import { ApifyAccountsSummary } from '../src/components/apify-accounts';
import { CollectionStatus } from '../src/components/collection-status';
import { DemoRepository } from '../src/lib/server/demo-repository';
import type { ApifyAccountsStatus } from '../src/lib/types';

const state: ApifyAccountsStatus = { ready_accounts: 1, accounts: ([1, 2, 3] as const).map(slot => ({
  slot, label: `Account ${slot}`, enabled: slot !== 3, configured: slot !== 3,
  reason: slot === 1 ? 'unreconciled_charges' : slot === 3 ? 'disabled' : null,
  usage_usd: slot === 3 ? null : 4, limit_usd: slot === 3 ? null : 5, usage_checked_at: null, cycle_end_at: null,
  reserved_usd: slot === 1 ? .907554 : 0, unreconciled_jobs: slot === 1 ? 1 : 0,
})) };

describe('safe Apify account status', () => {
  it('sanitizes account labels and strips tokens, provider identities and arbitrary payloads', () => {
    const raw = { ...state, token: 'private-secret', accounts: state.accounts.map(row => ({ ...row, label: 'private-secret', provider_user_id: 'private-secret', token: 'private-secret' })) };
    expect(safeApifyAccounts(raw)).toEqual(state);
    expect(JSON.stringify(safeApifyAccounts(raw))).not.toContain('private-secret');
  });
  it('fails closed on invalid balances, states, slots and readiness summaries', () => {
    for (const patch of [{ ready_accounts: 3 }, { accounts: [] }, { accounts: state.accounts.map(row => ({ ...row, reserved_usd: -1 })) },
      { accounts: state.accounts.map(row => ({ ...row, reason: 'raw-error-secret' })) }, { accounts: state.accounts.map(row => ({ ...row, slot: 1 })) },
      { accounts: state.accounts.map(row => ({ ...row, usage_checked_at: 'bad-date' })) }]) expect(() => safeApifyAccounts({ ...state, ...patch })).toThrow('Provider account status could not be loaded');
  });
  it('shows fixed priority, unknown charge holds and non-credit allowance semantics', () => {
    const html = renderToStaticMarkup(createElement(ApifyAccountsSummary, { value: state }));
    expect(html).toContain('Account 1 → 2 → 3'); expect(html).toContain('Eligible for new jobs'); expect(html).toContain('Blocked by unresolved charge');
    expect(html).toContain('actual charge remains unknown'); expect(html).toContain('not a verified prepaid-credit balance');
    expect(html).not.toContain('input'); expect(html).not.toContain('api-token');
  });
  it('supports five sanitized contiguous account slots without changing historical three-slot responses', () => {
    const expanded: ApifyAccountsStatus = { ...state, accounts: [...state.accounts, ...([4, 5] as const).map(slot => ({ ...state.accounts[2], slot, label: `Account ${slot}` }))] };
    expect(safeApifyAccounts(expanded)).toEqual(expanded);
    expect(renderToStaticMarkup(createElement(ApifyAccountsSummary, { value: expanded }))).toContain('Account 1 → 2 → 3 → 4 → 5');
    expect(() => safeApifyAccounts({ ...expanded, accounts: expanded.accounts.slice(0, 4) })).toThrow('Provider account status');
    expect(() => safeApifyAccounts({ ...state, accounts: [state.accounts[0], state.accounts[1], { ...state.accounts[2], slot: 5 }] })).toThrow('Provider account status');
  });
  it('renders verified busy capacity without describing it as exhausted credit or failed usage verification', () => {
    const busy: ApifyAccountsStatus = { ...state, ready_accounts: 0, accounts: state.accounts.map(row => row.reason === null ? { ...row, reason: 'account_capacity_full' } : row) };
    expect(safeApifyAccounts(busy)).toEqual(busy);
    const html = renderToStaticMarkup(createElement(ApifyAccountsSummary, { value: busy }));
    expect(html).toContain('Account already processing a job');
    expect(html).not.toContain('Verified allowance exhausted');
    expect(html).not.toContain('Usage verification required');
  });
  it('links unresolved account review to Settings while alternate accounts remain usable', () => {
    const summary = safeCollectionState({ reason: null, blocking_job_id: '11111111-1111-4111-8111-111111111111', pending_job_ids: [], active_job_ids: [], profiles: [], account_info: state });
    const html = renderToStaticMarkup(createElement(CollectionStatus, { state: summary }));
    expect(summary.account_info?.ready_accounts).toBe(1);
    expect(html).toContain('Account needs review'); expect(html).toContain('role="status"'); expect(html).toContain('href="/settings"');
    expect(html).not.toContain('11111111');
  });
  it('keeps demo account status disabled without mutation or external calls', async () => {
    const repo = new DemoRepository(), before = await repo.bootstrap();
    const result = await repo.apifyAccounts(); expect(safeApifyAccounts(result)).toEqual(result);
    expect(result.ready_accounts).toBe(0); expect(result.accounts.every(account => account.reason === 'disabled')).toBe(true);
    expect(await repo.bootstrap()).toEqual(before);
    expect(safeJob({ ...before.jobs[0], apify_account_slot: 5 })).toHaveProperty('apify_account_slot', 5);
  });
});

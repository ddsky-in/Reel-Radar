'use client';

import { useRef, useState } from 'react';
import type { ApifyAccountsStatus, ApifyAccountReason, BillingSyncResult } from '@/lib/types';
import { api, errorMessage } from '@/lib/client';
import { invalidateResourceFamilies } from '@/lib/resource-cache';
import { formatDateTime, formatUsd } from '@/lib/format';
import { ErrorState, Skeleton, SubmitButton, useResource, type Notify } from './ui';

const accountLabels: Record<ApifyAccountReason, string> = {
  disabled: 'Disabled', setup_required: 'Secure setup required', usage_unverified: 'Usage verification required',
  unreconciled_charges: 'Blocked by unresolved charge', allowance_exhausted: 'Verified allowance exhausted',
  account_capacity_full: 'Account already processing a job',
};

export function ApifyAccountsSummary({ value }: { value: ApifyAccountsStatus }) {
  return <section className="panel apify-accounts-summary" aria-label="Apify account fallback"><div className="panel-heading"><div><h2>Connected accounts</h2><p>New jobs use Account 1 → 2 → 3 → 4 → 5. Existing runs stay with their original account.</p></div></div>
    {value.capacity?.paid_starts_gated && <p className="helper-copy" role="status">Paid collection is gated. Billing sync remains available; releasing a hold does not resume collection.</p>}
    <div className="table-scroll"><table className="data-table"><thead><tr><th>Account</th><th>Status</th><th>Provider usage / spending limit</th><th>Reserved · not billed</th><th>Usage checked</th></tr></thead>
      <tbody>{value.accounts.map(account => <tr key={account.slot}><td><strong>{account.label}</strong></td><td>{account.reason ? accountLabels[account.reason] : 'Eligible for new jobs'}{account.unreconciled_jobs > 0 && <small className="block-muted">{account.unreconciled_jobs} unresolved job(s); actual charge remains unknown</small>}</td>
        <td>{formatUsd(account.usage_usd)} / {formatUsd(account.limit_usd)}<small className="block-muted">Cycle ends {formatDateTime(account.cycle_end_at)}</small></td><td>{formatUsd(account.reserved_usd)}{account.risk_released_exposure_usd !== undefined && account.risk_released_exposure_usd > 0 && <small className="block-muted">{formatUsd(account.risk_released_exposure_usd)} original released hold; liability unknown</small>}</td><td>{formatDateTime(account.usage_checked_at)}<small className="block-muted">{!account.usage_checked_at ? 'No verified observation' : account.reason === 'usage_unverified' ? 'Stored observation is stale or unverified; sync before resuming' : 'Provider observation; not a prepaid balance'}</small></td></tr>)}</tbody></table></div>
    <p className="helper-copy">{value.ready_accounts} account(s) eligible · shared monthly budget and concurrency limits apply.</p>
    <details className="apify-account-details"><summary>Monthly reports and accounting</summary><p className="helper-copy">Source: Apify account limits and monthly usage APIs. Usage limits are not a verified prepaid-credit balance. Local budget protection can conservatively overlap provider usage until exact billing inclusion is proven; these amounts must not be added as a confirmed bill.</p>
      {value.accounts.map(account => <details className="apify-monthly-report" key={account.slot}><summary><strong>{account.label}</strong><span>{account.monthly_report ? formatUsd(account.monthly_report.after_discount_usd) : 'Unverified'}</span></summary>{account.monthly_report ? <><p>Usage credits after volume discounts: {formatUsd(account.monthly_report.after_discount_usd)} · before discounts: {formatUsd(account.monthly_report.before_discount_usd)}</p><p>Cycle {formatDateTime(account.monthly_report.cycle_start_at)} → {formatDateTime(account.monthly_report.cycle_end_at)} · reported check {formatDateTime(account.monthly_report.checked_at)}</p><ul>{Object.entries(account.monthly_report.service_amounts).map(([name, amount]) => <li key={name}>{name}: {amount === null ? 'Unknown' : formatUsd(amount)}</li>)}</ul></> : <p>Monthly report not verified. No zero cost is assumed.</p>}</details>)}
      <p className="helper-copy">Monthly usage credits are provider observations, not a final invoice or proof that an unidentified run did not start. Account tokens stay in Supabase Edge Function Secrets.</p></details>
  </section>;
}

export function ApifyAccountsPanel({ revision = 0, notify }: { revision?: number; notify?: Notify }) {
  const [localRevision, setLocalRevision] = useState(0), [busy, setBusy] = useState(false), [result, setResult] = useState<BillingSyncResult | null>(null), [error, setError] = useState(''), [readbackRequired, setReadbackRequired] = useState(false);
  const pending = useRef(false);
  const resource = useResource<ApifyAccountsStatus>('/api/apify-accounts', revision + localRevision);
  async function syncBilling() {
    if (pending.current || readbackRequired) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const value = await api<BillingSyncResult>('/api/billing/sync', { method: 'POST', body: '{}' });
      setResult(value);
      setLocalRevision(current => current + 1);
      invalidateResourceFamilies(['jobs', 'settings', 'creators']);
      notify?.('Billing-only check completed. No paid collection was started.');
    } catch (error) {
      setError(`${errorMessage(error)} Read back stored status before checking again.`); setReadbackRequired(true);
      // The service may have persisted a partial usage check; read it, never retry billing or dispatch.
      invalidateResourceFamilies(['jobs', 'settings', 'creators']);
    } finally { pending.current = false; setBusy(false); }
  }
  async function readStored() {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      await api<ApifyAccountsStatus>('/api/apify-accounts');
      setReadbackRequired(false); setError(''); setLocalRevision(value => value + 1);
      invalidateResourceFamilies(['jobs', 'settings', 'creators']);
    } catch (error) { setError(`Stored status is unavailable. ${errorMessage(error)}`); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="apify-billing-panel">
    <div className="apify-billing-actions"><div><h2>Provider billing</h2><p>Sync usage directly from Apify. This never starts collection.</p></div><SubmitButton type="button" busy={busy} disabled={readbackRequired} onClick={syncBilling}>Sync billing</SubmitButton>{readbackRequired && <button type="button" className="button button-secondary" disabled={busy} onClick={readStored}>Refresh stored billing</button>}</div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {result && <BillingSyncSummary value={result}/>}
    {resource.error && <ErrorState message="Provider account status could not be loaded." retry={() => setLocalRevision(value => value + 1)}/>}
    {resource.loading && !resource.data ? <Skeleton/> : resource.data && <ApifyAccountsSummary value={resource.data}/>}
  </div>;
}

export function BillingSyncSummary({ value }: { value: BillingSyncResult }) {
  return <section className="billing-sync-result" aria-label="Last explicit billing check" role="status"><h3>Last billing check</h3><p>{formatDateTime(value.sync.syncedAt)} · {value.sync.runs.reconciled} run(s) reconciled · {value.sync.runs.unknown} run cost(s) still unknown · {value.sync.runs.failed} check(s) failed</p>
    <details><summary>Account check details</summary><ul>{value.sync.accounts.map(account => <li key={account.accountSlot}><strong>Account {account.accountSlot}</strong> · {!account.enabled ? 'Disabled, not checked' : account.success ? `Usage checked ${formatDateTime(account.syncedAt)}` : account.error === 'usage_persistence_failed' ? 'Usage could not be saved; stored usage is not confirmed current' : 'Usage check failed; stored usage is not confirmed current'}</li>)}</ul></details>
    {value.sync.accounts.some(account => account.monthlyReportError) && <p>Some monthly reports could not be verified. Stored report timestamps remain unchanged; valid account usage checks are shown separately.</p>}
    <p>Billing sync starts no paid jobs. Run usage can be revised after completion; checks are provider observations, not final invoices. Unknown run costs and released liability are not zero charges.</p>
  </section>;
}

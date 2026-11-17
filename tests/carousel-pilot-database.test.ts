import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>;
let selected: string;
let other: string;
type Claim = { reason?: string; job?: { id: string; reserved_usd: number }; max_total_charge_usd?: number };
beforeAll(async () => { f = await featureDatabase(); }, 60000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => {
  await f.identity();
  await f.db.exec("update public.scrape_jobs set status='failed',actual_cost_usd=0,reserved_usd=0,completed_at=now();");
  await f.db.query(`update public.app_settings set scraping_enabled=true,paused=false,monthly_budget_usd=50,
    provider_usage_checked_at=now(),provider_cycle_usage_usd=0,provider_cycle_limit_usd=50 where owner_user_id=$1`, [fixtureOwner]);
  await f.identity('service_role');
  await f.db.query("select public.worker_record_account_usage($1,1,'fixture',now()-interval '1 day',now()+interval '20 days',0,50)", [fixtureOwner]);
  await f.identity();
  for (let index = 0; index < 2; index++) {
    const id = await f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,results_limit,requested_profiles_count,estimated_cost_usd,manual_authorized_by,priority)
      values($1,'carousel',30,1,0,$1,$2) returning id v`, [fixtureOwner, index ? 100 : 0]);
    await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [id, f.creator]);
    if (index) other = id; else selected = id;
  }
  await f.identity('service_role');
});
const claim = (id = selected, owner = fixtureOwner) => f.rpc<Claim>('worker_claim_carousel_pilot', [owner, id, 'fixture-actor']);

describe('explicit carousel pilot reservation', () => {
  it('claims only the selected job, commits a matching ten-cent cap and cannot repeat a start', async () => {
    const result = await claim();
    expect(result).toMatchObject({ job: { id: selected, reserved_usd: .10 }, max_total_charge_usd: .10 });
    expect(await f.value<string>('select status v from public.scrape_jobs where id=$1', [other])).toBe('pending');
    expect(await f.value<string>("select coalesce(current_setting('reelradar.media_job_id',true),'') v")).toBe('');
    expect(await claim()).toEqual({ reason: 'pilot_job_not_pending' });
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.scrape_jobs')).toBe(.10);
  });
  it('respects a smaller monthly/account allowance instead of inflating the reservation', async () => {
    await f.identity();
    await f.db.query('update public.app_settings set monthly_budget_usd=.06,provider_cycle_limit_usd=.04 where owner_user_id=$1', [fixtureOwner]);
    await f.db.query('update public.apify_accounts set limit_usd=.04 where owner_id=$1 and slot=1', [fixtureOwner]);
    await f.identity('service_role');
    const result = await claim();
    expect(result.max_total_charge_usd).toBeGreaterThan(0);
    expect(result.max_total_charge_usd).toBeLessThanOrEqual(.04);
    expect(result.job?.reserved_usd).toBe(result.max_total_charge_usd);
  });
  it.each([
    { sql: 'scraping_enabled=false', reason: 'globalscraping_disabled' },
    { sql: 'paused=true', reason: 'paused' },
    { sql: "provider_usage_checked_at=now()-interval '16 minutes'", reason: 'live_setup_or_usage_unverified' },
    { sql: 'monthly_budget_usd=0', reason: 'budget_paused' },
  ])('preserves the existing gate: $reason', async ({ sql, reason }) => {
    await f.identity(); await f.db.exec(`update public.app_settings set ${sql};`);
    if (sql.startsWith('provider_usage_checked_at')) {
      await f.db.query("update public.apify_accounts set usage_checked_at=now()-interval '16 minutes' where owner_id=$1 and slot=1", [fixtureOwner]);
    }
    await f.identity('service_role');
    expect(await claim()).toEqual({ reason });
    expect(await f.value<number>('select sum(reserved_usd)::float8 v from public.scrape_jobs')).toBe(0);
  });
  it('retains unknown-cost holds and rejects further live starts', async () => {
    await claim(); await f.identity();
    await f.db.query("update public.scrape_jobs set status='succeeded',actual_cost_usd=null,provider_terminal_status='SUCCEEDED' where id=$1", [selected]);
    await f.identity('service_role');
    expect(await claim(other)).toEqual({ reason: 'unreconciled_charges' });
    expect(await f.value<number>('select reserved_usd::float8 v from public.scrape_jobs where id=$1', [selected])).toBe(.10);
  });
  it('preserves concurrency limits', async () => {
    await f.identity();
    await f.db.query("update public.scrape_jobs set status='running' where id=$1", [other]);
    await f.db.query("insert into public.scrape_jobs(owner_user_id,kind,status,results_limit,requested_profiles_count,estimated_cost_usd) values($1,'daily','processing',30,1,0)", [fixtureOwner]);
    await f.identity('service_role');
    expect(await claim()).toEqual({ reason: 'concurrency_limit' });
  });
  it('requires service execution, the exact owner, manual authorization and an active workspace', async () => {
    for (const role of ['anon', 'authenticated']) {
      await f.identity(role); await expect(claim()).rejects.toThrow('permission denied');
    }
    await f.identity('service_role');
    expect(await claim(selected, fixtureStranger)).toEqual({ reason: 'pilot_job_not_authorized' });
    await f.identity(); await f.db.query('update public.scrape_jobs set manual_authorized_by=null where id=$1', [selected]);
    await f.identity('service_role'); expect(await claim()).toEqual({ reason: 'pilot_job_not_authorized' });
    await f.identity();
    await f.db.query('update public.scrape_jobs set manual_authorized_by=$1 where id=$2', [fixtureOwner, selected]);
    await f.db.query('update public.workspace_creators set active=false where workspace_id=$1', [f.workspace]);
    await f.identity('service_role'); expect(await claim()).toEqual({ reason: 'pilot_job_not_authorized' });
    await f.identity(); await f.db.query('update public.workspace_creators set active=true where workspace_id=$1', [f.workspace]);
  });
});

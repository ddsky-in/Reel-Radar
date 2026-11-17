import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Job, JobStatus } from '../src/lib/types';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

type CollectionReason = 'unreconciled_charges' | 'scraping_disabled' | 'initial_import_disabled' | 'usage_unverified' | 'budget_paused' | 'concurrency_limit';
type CollectionState = {
  reason: CollectionReason | null;
  blocking_job_id: string | null;
  pending_job_ids: string[];
  active_job_ids: string[];
  profiles: { creator_id: string; job_id: string; status: JobStatus }[];
};
let f: Awaited<ReturnType<typeof featureDatabase>>;
let creator: string;
let sequence = 0;
beforeAll(async () => { f = await featureDatabase(); }, 60_000);
beforeEach(async () => {
  await f.identity();
  await f.db.exec('begin');
  await f.db.exec('update public.workspace_creators set active=false');
  creator = await linkedCreator();
});
afterEach(async () => { await f.db.exec('rollback'); await f.identity(); });
afterAll(async () => { await f?.db.close(); });

async function linkedCreator(workspace = f.workspace, active = true) {
  const id = await f.value<string>('insert into public.creators(username) values($1) returning id v', [`collection_fixture_${++sequence}`]);
  await f.db.query('insert into public.workspace_creators(workspace_id,creator_id,active) values($1,$2,$3)', [workspace, id, active]);
  return id;
}
async function job(kind: Job['kind'] = 'manual', status: JobStatus = 'pending', ids = [creator], options: {
  live?: boolean; actual?: number | null; reserved?: number; terminal?: string | null; created?: string; scheduled?: string;
} = {}) {
  const row = await f.value<{ id: string; lease_token: string }>(`insert into public.scrape_jobs(owner_user_id,kind,status,
    requested_profiles_count,results_limit,live,actual_cost_usd,reserved_usd,provider_terminal_status,created_at,scheduled_for,
    lease_token,lease_expires_at,result_fetched_at,manual_authorized_by,apify_account_slot,expected_provider_user_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::timestamptz,now()),coalesce($11::timestamptz,now()),
      gen_random_uuid(),now()+interval '5 minutes',now(),$1,
      case when $6 and $3 not in ('pending','budget_paused') then 1 end,case when $6 then 'fixture' end)
    returning jsonb_build_object('id',id,'lease_token',lease_token) v`,
  [fixtureOwner, kind, status, Math.max(1, ids.length), kind === 'backfill' ? 100 : kind === 'profile' ? 1 : 30,
    options.live ?? false, options.actual ?? null, options.reserved ?? 0, options.terminal ?? null, options.created ?? null, options.scheduled ?? null]);
  for (const id of ids) await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [row.id, id]);
  return row;
}
async function foreignOwnerFixture() {
  // The MVP normally provisions one owner. Remove only this uniqueness guard
  // inside the rolled-back local test transaction to exercise owner isolation.
  await f.db.exec('alter table public.app_settings drop constraint app_settings_singleton_key');
  await f.db.query('insert into public.app_settings(owner_user_id) values($1)', [fixtureStranger]);
}
async function state(ids: (string | null)[] | null = null, workspace = f.workspace) {
  return f.rpc<CollectionState>('get_creator_collection_state', [workspace, ids]);
}
async function rejects(query: () => Promise<unknown>, message: string) {
  await f.db.exec('savepoint expected_rejection');
  try { await expect(query()).rejects.toThrow(message); }
  finally { await f.db.exec('rollback to savepoint expected_rejection; release savepoint expected_rejection'); }
}
async function snapshot() {
  const tables = (await f.db.query<{ schema: string; name: string }>(`select table_schema schema,table_name name
    from information_schema.tables where table_schema in ('public','vault','cron','net') and table_type='BASE TABLE'
    order by table_schema,table_name`)).rows;
  const result: Record<string, unknown> = {};
  for (const table of tables) result[`${table.schema}.${table.name}`] = await f.value(
    `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) v from "${table.schema}"."${table.name}" t`);
  return result;
}

// Every fixture/provider value below is synthetic. PGlite runs locally in memory.
describe('read-only creator collection state', () => {
  it('exposes the exact sanitized contract, authenticates owners, and revokes public/anon/service execution', async () => {
    const signature = 'public.get_creator_collection_state(uuid,uuid[])';
    expect(await f.value(`select jsonb_build_object('stable',p.provolatile='s','definer',p.prosecdef,
      'search_path',p.proconfig,'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE'),
      'anon',has_function_privilege('anon',p.oid,'EXECUTE'),'service',has_function_privilege('service_role',p.oid,'EXECUTE')) v
      from pg_proc p where p.oid=$1::regprocedure`, [signature])).toEqual({
      stable: true, definer: false, search_path: ['search_path=pg_catalog'], authenticated: true, anon: false, service: false,
    });
    await f.identity('authenticated');
    const empty = { reason: null, blocking_job_id: null, pending_job_ids: [], active_job_ids: [], profiles: [] };
    expect(await state()).toEqual(empty);
    expect(await f.rpc('get_creator_collection_state', [f.workspace])).toEqual(empty);
    for (const role of ['anon', 'service_role']) {
      await f.identity(role);
      await rejects(() => state(), 'permission denied');
    }
    await f.identity('authenticated', fixtureStranger);
    await rejects(() => state(), 'forbidden');
    await f.identity();
    await f.db.query('insert into public.workspace_members(workspace_id,user_id) values($1,$2)', [f.workspace, fixtureStranger]);
    await f.identity('authenticated', fixtureStranger);
    await rejects(() => state(), 'forbidden');
    await f.identity();
    await f.db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role: 'authenticated' })]);
    await f.db.exec('set role authenticated');
    await rejects(() => state(), 'forbidden');
  });

  it('requires the selected workspace and rejects foreign, inactive, missing, and null explicit creator IDs', async () => {
    await f.identity('authenticated');
    const other = await f.rpc<{ id: string }>('create_workspace', ['Other collection workspace']);
    await f.identity();
    const foreign = await linkedCreator(other.id);
    const inactive = await linkedCreator(f.workspace, false);
    await f.identity('authenticated');
    for (const ids of [[foreign], [inactive], [fixtureStranger], [null], [creator, foreign]]) {
      await rejects(() => state(ids), 'creator_not_in_workspace');
    }
    await rejects(() => state(null, fixtureStranger), 'forbidden');
    await f.identity();
    await f.db.query('delete from public.workspace_members where workspace_id=$1 and user_id=$2', [other.id, fixtureOwner]);
    await f.identity('authenticated');
    await rejects(() => state(null, other.id), 'forbidden');
    expect((await state([creator, creator])).pending_job_ids).toEqual([]);
  });

  it('supports null selection beyond the manual refresh limit without silently truncating profiles/jobs', async () => {
    for (let index = 1; index < 125; index++) await linkedCreator();
    const ids = (await f.db.query<{ creator_id: string }>('select creator_id from public.workspace_creators where workspace_id=$1 and active order by creator_id', [f.workspace])).rows.map(row => row.creator_id);
    const jobs: string[] = [];
    for (let index = 0; index < ids.length; index += 20) jobs.push((await job('profile', 'pending', ids.slice(index, index + 20))).id);
    await f.identity('authenticated');
    const result = await state();
    expect(result.profiles).toHaveLength(125);
    expect([...result.pending_job_ids].sort()).toEqual(jobs.sort());
    expect((await state(ids.slice(0, 120))).profiles).toHaveLength(120);
    await rejects(() => state(ids), 'creator_not_in_workspace');
  }, 60_000);

  it('scopes and deduplicates linked owner jobs while excluding carousel, detached, and terminal jobs', async () => {
    await f.identity('authenticated');
    const other = await f.rpc<{ id: string }>('create_workspace', ['Scoped collection workspace']);
    await f.identity();
    const second = await linkedCreator();
    const detached = await linkedCreator(f.workspace, false);
    const foreign = await linkedCreator(other.id);
    const pending = await job('backfill');
    const paused = await job('manual', 'budget_paused', [creator, second]);
    const future = await job('daily', 'pending', [creator], { scheduled: '2099-01-01T00:00:00Z' });
    const profile = await job('profile', 'running', [creator, second]);
    const dispatching = await job('manual', 'dispatching');
    const processing = await job('weekly', 'processing');
    const uncertain = await job('retry', 'uncertain'); // Dry uncertain still consumes a slot, not a charge blocker.
    await job('carousel'); await job('carousel', 'running');
    await job('manual', 'pending', [detached]); await job('manual', 'running', [foreign]);
    await job('manual', 'pending', []); await job('manual', 'succeeded');
    // A malformed legacy/foreign-owned row must not leak even with a selected creator link.
    const wrongOwner = await job();
    await foreignOwnerFixture();
    await f.db.query('update public.scrape_jobs set owner_user_id=$1 where id=$2', [fixtureStranger, wrongOwner.id]);
    await f.identity('authenticated');
    const result = await state([creator]);
    expect(result.reason).toBe('concurrency_limit');
    expect([...result.pending_job_ids].sort()).toEqual([pending.id, paused.id, future.id].sort());
    expect([...result.active_job_ids].sort()).toEqual([profile.id, dispatching.id, processing.id, uncertain.id].sort());
    expect(result.profiles).toEqual([{ creator_id: creator, job_id: profile.id, status: 'running' }]);
    expect((await state()).pending_job_ids.filter(id => id === paused.id)).toHaveLength(1);
    expect((await state([second])).active_job_ids).toEqual([profile.id]);
    expect(await state([])).toMatchObject({ pending_job_ids: [], active_job_ids: [], profiles: [] });
    expect((await state(null, other.id)).active_job_ids).toHaveLength(1);
  });

  it('finds an owner-wide uncertain blocker older than bootstrap’s latest 50, including other workspace/carousel work', async () => {
    await f.identity('authenticated');
    const other = await f.rpc<{ id: string }>('create_workspace', ['Old charge workspace']);
    await f.identity();
    const foreign = await linkedCreator(other.id);
    const blocker = await job('carousel', 'uncertain', [foreign], {
      live: true, reserved: 3, created: '2025-01-01T00:00:00Z', scheduled: '2025-01-01T00:00:00Z',
    });
    await f.db.query(`insert into public.scrape_jobs(owner_user_id,kind,status,requested_profiles_count,results_limit,actual_cost_usd)
      select $1,'manual','succeeded',1,30,0 from generate_series(1,60)`, [fixtureOwner]);
    await f.db.exec('update public.app_settings set scraping_enabled=false,initial_backfill_enabled=false,monthly_budget_usd=0');
    await f.identity('authenticated');
    const bootstrap = await f.rpc<{ jobs: { id: string }[] }>('get_bootstrap');
    expect(bootstrap.jobs).toHaveLength(50);
    expect(bootstrap.jobs.some(j => j.id === blocker.id)).toBe(false);
    expect(await state([creator])).toEqual({
      reason: 'unreconciled_charges', blocking_job_id: blocker.id, pending_job_ids: [], active_job_ids: [], profiles: [],
    });
    expect(await state([])).toMatchObject({ reason: 'unreconciled_charges', blocking_job_id: blocker.id });
    await f.db.exec('reset role');
    await f.db.query('update public.scrape_jobs set actual_cost_usd=0 where id=$1', [blocker.id]);
    await f.identity('authenticated');
    expect((await state()).reason).toBe('unreconciled_charges'); // Accepted-start uncertainty is independent of numeric cost.
  });

  it.each(['succeeded', 'partial', 'failed'] as const)('distinguishes a zero-charge %s job from an unknown terminal charge', async status => {
    const empty = await job('profile', status, [creator], { live: true, actual: 0, terminal: 'SUCCEEDED' });
    await f.identity('authenticated');
    expect(await state()).toMatchObject({ reason: null, blocking_job_id: null, profiles: [{ creator_id: creator, job_id: empty.id, status }] });
    await f.identity();
    await f.db.query('update public.scrape_jobs set actual_cost_usd=null where id=$1', [empty.id]);
    await f.identity('authenticated');
    expect(await state()).toMatchObject({ reason: 'unreconciled_charges', blocking_job_id: empty.id });
  });

  it('matches the terminal-provider charge predicate without treating undispatched/dry null costs as charges', async () => {
    await job('profile'); await job('manual', 'budget_paused', [creator], { live: true });
    await job('manual', 'failed');
    await f.identity('authenticated');
    expect((await state()).reason).toBeNull();
    await f.identity();
    const terminal = await job('manual', 'processing', [], { live: true, terminal: 'FAILED' });
    await f.identity('authenticated');
    expect(await state()).toMatchObject({ reason: 'unreconciled_charges', blocking_job_id: terminal.id, active_job_ids: [] });
  });

  it.each([
    ['scraping_enabled=false', 'scraping_disabled'],
    ['initial_backfill_enabled=false', 'initial_import_disabled'],
    ['provider_account_id=null', 'usage_unverified'],
    ["provider_usage_checked_at=now()-interval '16 minutes'", 'usage_unverified'],
    ["provider_usage_checked_at=now()+interval '2 minutes'", 'usage_unverified'],
    ["provider_cycle_start_at=now()+interval '1 day',provider_cycle_end_at=now()+interval '2 days'", 'usage_unverified'],
    ["provider_cycle_start_at=now()-interval '2 days',provider_cycle_end_at=now()-interval '1 day'", 'usage_unverified'],
    ['provider_usage_checked_at=null,provider_cycle_start_at=null,provider_cycle_end_at=null,provider_cycle_usage_usd=null,provider_cycle_limit_usd=null', 'usage_unverified'],
    ['monthly_budget_usd=0', 'budget_paused'],
    ['provider_cycle_usage_usd=50', 'budget_paused'],
    ['provider_cycle_limit_usd=0', 'budget_paused'],
  ] as const)('maps the real collection guard %s to %s', async (setting, reason) => {
    await f.db.exec(`update public.app_settings set ${setting}`);
    if (setting.startsWith('provider_')) {
      const accountSetting = setting.replaceAll('provider_account_id', 'provider_user_id')
        .replaceAll('provider_usage_checked_at', 'usage_checked_at').replaceAll('provider_cycle_start_at', 'cycle_start_at')
        .replaceAll('provider_cycle_end_at', 'cycle_end_at').replaceAll('provider_cycle_usage_usd', 'usage_usd')
        .replaceAll('provider_cycle_limit_usd', 'limit_usd');
      await f.db.query(`update public.apify_accounts set ${accountSetting} where owner_id=$1 and slot=1`, [fixtureOwner]);
    }
    await f.identity('authenticated');
    expect(await state()).toEqual({ reason, blocking_job_id: null, pending_job_ids: [], active_job_ids: [], profiles: [] });
  });

  it('does not report scheduled pause or stale budget_paused status when manual collection has headroom', async () => {
    const queued = await job('backfill', 'budget_paused');
    await f.db.exec('update public.app_settings set paused=true,max_run_charge_usd=9999,provider_balance_usd=0');
    await f.identity('authenticated');
    expect(await state()).toMatchObject({ reason: null, blocking_job_id: null, pending_job_ids: [queued.id] });
  });

  it('uses owner-wide monthly commitments and outstanding live holds across month transitions', async () => {
    // Keep an independently verified alternate free so account capacity does not
    // obscure the monthly accounting invariant when the settled charge rolls over.
    await f.identity('service_role');
    await f.rpc('worker_configure_apify_account', [fixtureOwner, 2, 'fixture-secondary', true, true]);
    await f.db.query("select public.worker_record_account_usage($1,2,'fixture-secondary',now()-interval '1 day',now()+interval '20 days',0,50)", [fixtureOwner]);
    await f.identity();
    const settled = await job('carousel', 'succeeded', [], { live: true, actual: 7 });
    await f.db.query("update public.scrape_jobs set billing_month=date_trunc('month',now() at time zone 'UTC')::date where id=$1", [settled.id]);
    const held = await job('manual', 'running', [], { live: true, reserved: 3, created: '2025-01-01T00:00:00Z' });
    await job('manual', 'pending', [], { reserved: 100 }); // Dry holds must not count as live dollars.
    await f.db.exec('update public.app_settings set monthly_budget_usd=10');
    await f.identity('authenticated');
    expect((await state()).reason).toBe('budget_paused');
    await f.identity();
    await f.db.query("update public.scrape_jobs set billing_month='2025-01-01' where id=$1", [settled.id]);
    await f.identity('authenticated');
    expect((await state()).reason).toBeNull();
    const accounts = await f.rpc<{ accounts: { slot: number; reason: string | null }[] }>('get_apify_account_status');
    expect(accounts.accounts.slice(0, 2)).toMatchObject([{ slot: 1, reason: 'account_capacity_full' }, { slot: 2, reason: null }]);
    await f.identity();
    expect(await f.value('select jsonb_build_object(\'status\',status,\'hold\',reserved_usd,\'cost\',actual_cost_usd,\'slot\',apify_account_slot) v from public.scrape_jobs where id=$1', [held.id]))
      .toEqual({ status: 'running', hold: 3, cost: null, slot: 1 });
  });

  it('keeps provider-cycle charges additive across later authoritative usage observations', async () => {
    await f.db.exec("update public.app_settings set provider_cycle_limit_usd=10,provider_cycle_usage_usd=6,provider_usage_checked_at=now()-interval '1 minute'");
    await f.db.query("update public.apify_accounts set limit_usd=10,usage_usd=6,usage_checked_at=now()-interval '1 minute' where owner_id=$1 and slot=1", [fixtureOwner]);
    const charge = await job('carousel', 'succeeded', [], { live: true, actual: 4 });
    await f.db.query("update public.scrape_jobs set billing_month='2025-01-01',billing_reconciled_at=now() where id=$1", [charge.id]);
    await f.identity('authenticated');
    expect((await state()).reason).toBe('budget_paused');
    await f.identity();
    await f.db.exec('update public.app_settings set provider_usage_checked_at=now()');
    await f.identity('service_role');
    const observation = await f.rpc<{ observation_id: string; observed_at: string }>('worker_begin_account_usage', [fixtureOwner, 1, 'fixture']);
    await f.db.query("select public.worker_record_account_usage($1,1,'fixture',now()-interval '1 day',now()+interval '20 days',6,10,$2::uuid,$3::timestamptz)",
      [fixtureOwner, observation.observation_id, observation.observed_at]);
    await f.identity('authenticated');
    expect((await state()).reason).toBe('budget_paused'); // Same-cycle refresh never proves these costs are reflected.
  });

  it('counts owner-wide concurrency but not other-owner slots and keeps provider payloads private', async () => {
    await job('carousel', 'running', []);
    const foreign = await job('manual', 'processing', []);
    await foreignOwnerFixture();
    await f.db.query('update public.scrape_jobs set owner_user_id=$1 where id=$2', [fixtureStranger, foreign.id]);
    await f.identity('authenticated');
    expect((await state()).reason).toBeNull();
    await f.identity();
    const active = await job('profile', 'dispatching');
    await f.db.query(`update public.scrape_jobs set actor_run_id='synthetic-private-run',dataset_id='synthetic-private-dataset',
      expected_provider_user_id='synthetic-private-account',dispatch_nonce=gen_random_uuid(),error_message='synthetic-private-provider-blob'
      where id=$1`, [active.id]);
    await f.identity('authenticated');
    expect(await state()).toEqual({ reason: 'concurrency_limit', blocking_job_id: null, pending_job_ids: [], active_job_ids: [active.id],
      profiles: [{ creator_id: creator, job_id: active.id, status: 'dispatching' }] });
  });

  it('returns the latest profile job per selected creator independently of coexisting/newer backfills', async () => {
    const second = await linkedCreator();
    await job('profile', 'failed', [creator, second], { created: '2026-01-01T00:00:00Z' });
    const latest = await job('profile', 'partial', [creator], { created: '2026-02-01T00:00:00Z' });
    const batched = await job('profile', 'pending', [second], { created: '2026-02-01T00:00:00Z' });
    const backfill = await job('backfill', 'pending', [creator], { created: '2026-03-01T00:00:00Z' });
    await f.identity('authenticated');
    const result = await state();
    expect(result.profiles).toEqual([
      { creator_id: creator, job_id: latest.id, status: 'partial' },
      { creator_id: second, job_id: batched.id, status: 'pending' },
    ].sort((a, b) => a.creator_id.localeCompare(b.creator_id)));
    expect([...result.pending_job_ids].sort()).toEqual([batched.id, backfill.id].sort());
    expect((await state([creator])).profiles).toEqual([{ creator_id: creator, job_id: latest.id, status: 'partial' }]);
  });

  it('reads the actual initial profile/backfill pair without enqueueing or changing either job', async () => {
    await f.identity('authenticated');
    const added = await f.rpc<{ id: string; profile_job_ids: string[]; initial_backfill_job_id: string }>('add_creator', [f.workspace, 'collection_added_fixture']);
    expect(added.profile_job_ids).toHaveLength(1);
    expect((await state([added.id])).profiles).toEqual([{ creator_id: added.id, job_id: added.profile_job_ids[0], status: 'pending' }]);
    expect((await state([added.id])).pending_job_ids).toEqual([added.profile_job_ids[0], added.initial_backfill_job_id]);
    const repeated = await f.rpc<{ profile_job_ids: string[]; initial_backfill_job_id: string | null }>('add_creator', [f.workspace, 'collection_added_fixture']);
    expect(repeated).toMatchObject({ profile_job_ids: [], initial_backfill_job_id: null });
    expect((await state([added.id])).pending_job_ids).toHaveLength(2);
  });

  it('is legal in a read-only transaction and preserves every table, reservation, expired lease, and network/Cron fixture', async () => {
    await job('profile', 'pending');
    const stale = await job('manual', 'dispatching', [], { live: true, reserved: 2 });
    await f.db.query("update public.scrape_jobs set lease_expires_at=now()-interval '1 day' where id=$1", [stale.id]);
    await job('backfill', 'budget_paused');
    const before = await snapshot();
    await f.identity('authenticated');
    await state(); await state([creator]); await state([]);
    await f.identity();
    expect(await snapshot()).toEqual(before);
    // End this test's writable setup transaction; repeat under PostgreSQL's
    // read-only enforcement against the untouched base fixture as well.
    await f.db.exec('rollback; begin read only');
    await f.identity('authenticated');
    expect(await state()).toHaveProperty('reason', null);
    await f.identity();
    const definition = await f.value<string>("select pg_get_functiondef('authenticated_rpc_private.get_creator_collection_state(uuid,uuid[])'::regprocedure) v");
    expect(definition).not.toMatch(/\b(insert|update|delete|merge|pg_advisory|worker_|queue_creator|reserve)\s*\(/i);
  });
});

function profileRecord(fetched: string, overrides: Record<string, unknown> = {}) {
  return { creator_id: creator, username: `collection_fixture_${sequence}`, followers_count: 1200,
    display_name: 'Synthetic profile', avatar_url: 'https://example.invalid/synthetic-avatar.jpg', provider: 'fixture', fetched_at: fetched, ...overrides };
}
async function ingestProfile(record: Record<string, unknown>, status: JobStatus = 'processing') {
  await f.identity();
  const processing = await job('profile', status, [creator], { live: true, reserved: 0.5, terminal: 'SUCCEEDED' });
  await f.identity('service_role');
  const args = [processing.id, processing.lease_token, 0, JSON.stringify([record]), '[]', 1, true, JSON.stringify({ [creator]: 1 })];
  const result = await f.rpc('worker_ingest_page', args);
  return { processing, args, result };
}

describe('actual profile ingestion persistence and idempotency', () => {
  it('persists metadata and one UTC follower snapshot once, finishes a profile, and retains unknown cost/hold until billing reconciliation', async () => {
    const fetched = '2026-01-02T18:30:00Z'; // UTC date differs from the IST date.
    const before = await f.value('select jsonb_build_object(\'reels\',(select count(*) from public.reels),\'transcripts\',(select count(*) from public.transcript_jobs)) v');
    const { processing, args, result } = await ingestProfile(profileRecord(fetched));
    expect(result).toMatchObject({ accepted: 1, duplicate: false, cursor: 1 });
    expect(await f.rpc('worker_ingest_page', args)).toMatchObject({ duplicate: true, cursor: 1 });
    await f.rpc('worker_record_output_summary', [processing.id, processing.lease_token, JSON.stringify({ ok: true, complete: true, total_items: 1,
      users: [{ creator_id: creator, username: `collection_fixture_${sequence}`, count: 1, error: null }] })]);
    const finished = await f.rpc('worker_finish_processing', [processing.id, processing.lease_token]);
    expect(finished).toMatchObject({ status: 'succeeded', returned_records_count: 1, actual_cost_usd: null, reserved_usd: 0.5 });
    expect(await f.rpc('worker_finish_processing', [processing.id, processing.lease_token])).toEqual(finished);
    await f.identity('authenticated');
    expect(await state([creator])).toMatchObject({ reason: 'unreconciled_charges', blocking_job_id: processing.id,
      active_job_ids: [], profiles: [{ creator_id: creator, job_id: processing.id, status: 'succeeded' }] });
    expect(await f.value(`select jsonb_build_object('display_name',display_name,'avatar_url',avatar_url,'followers_count',followers_count,
      'fetched',last_profile_fetch_at,'status',status,'reel_fetched',last_reels_fetch_at) v from public.creators where id=$1`, [creator])).toEqual({
      display_name: 'Synthetic profile', avatar_url: 'https://example.invalid/synthetic-avatar.jpg', followers_count: 1200,
      fetched: fetched.replace('Z', '+00:00'), status: 'active', reel_fetched: null,
    });
    expect(await f.value(`select jsonb_agg(jsonb_build_object('date',captured_date,'followers',followers_count,'source',source,'fetched',captured_at)) v
      from public.creator_follower_snapshots where creator_id=$1`, [creator])).toEqual([{ date: '2026-01-02', followers: 1200, source: 'fixture', fetched: fetched.replace('Z', '+00:00') }]);
    await f.identity();
    expect(await f.value('select jsonb_build_object(\'reels\',(select count(*) from public.reels),\'transcripts\',(select count(*) from public.transcript_jobs)) v')).toEqual(before);
    expect(await f.value('select jsonb_build_object(\'result\',result_count,\'received\',received_count) v from public.scrape_job_creators where job_id=$1', [processing.id])).toEqual({ result: 1, received: 1 });
  });

  it('preserves newer metadata/daily snapshots on older deliveries and upserts a newer same-day observation', async () => {
    await ingestProfile(profileRecord('2026-01-02T18:30:00Z'));
    await ingestProfile(profileRecord('2026-01-02T10:00:00Z', { followers_count: 1, display_name: 'Stale', avatar_url: 'https://example.invalid/stale.jpg' }));
    await f.identity();
    expect(await f.value('select followers_count v from public.creators where id=$1', [creator])).toBe(1200);
    expect(await f.value('select followers_count v from public.creator_follower_snapshots where creator_id=$1', [creator])).toBe(1200);
    await ingestProfile(profileRecord('2026-01-01T18:30:00Z', { followers_count: 900 }));
    await ingestProfile(profileRecord('2026-01-02T19:00:00Z', { followers_count: 1300, display_name: null, avatar_url: null }));
    await f.identity();
    expect(await f.value(`select jsonb_build_object('name',display_name,'avatar',avatar_url,'followers',followers_count) v
      from public.creators where id=$1`, [creator])).toEqual({ name: 'Synthetic profile', avatar: 'https://example.invalid/synthetic-avatar.jpg', followers: 1300 });
    expect((await f.db.query<{ captured_date: string; followers_count: number }>(`select captured_date::text,followers_count
      from public.creator_follower_snapshots where creator_id=$1 order by captured_date`, [creator])).rows).toEqual([
      { captured_date: '2026-01-01', followers_count: 900 }, { captured_date: '2026-01-02', followers_count: 1300 },
    ]);
  });

  it('rejects unauthenticated ingestion, creator identity mismatches, wrong/expired leases, and leaves rejected pages unchanged', async () => {
    const processing = await job('profile', 'processing');
    const args = [processing.id, processing.lease_token, 0, JSON.stringify([profileRecord('2026-01-01T00:00:00Z')]), '[]', 1, true, JSON.stringify({ [creator]: 1 })];
    await f.identity('authenticated');
    await rejects(() => f.rpc('worker_ingest_page', args), 'permission denied');
    await f.identity('service_role');
    await rejects(() => f.rpc('worker_ingest_page', [processing.id, fixtureStranger, ...args.slice(2)]), 'lease_expired');
    const mismatched = { ...profileRecord('2026-01-01T00:00:00Z'), username: 'other_synthetic_creator' };
    await f.identity();
    const before = await snapshot();
    await f.identity('service_role');
    await rejects(() => f.rpc('worker_ingest_page', [processing.id, processing.lease_token, 0, JSON.stringify([mismatched]), ...args.slice(4)]), 'creator_identity_mismatch');
    await f.identity();
    expect(await snapshot()).toEqual(before);
    await f.db.query("update public.scrape_jobs set lease_expires_at=now()-interval '1 day' where id=$1", [processing.id]);
    await f.identity('service_role');
    await rejects(() => f.rpc('worker_ingest_page', args), 'lease_expired');
  });

  it('accepts a known zero follower metric but does not fabricate metadata for a missing follower metric', async () => {
    const zero = await ingestProfile(profileRecord('2026-01-01T00:00:00Z', { followers_count: 0 }));
    expect(zero.result).toMatchObject({ accepted: 1 });
    const missing = await ingestProfile(profileRecord('2026-01-02T00:00:00Z', { followers_count: null, display_name: 'Do not overwrite' }));
    expect(missing.result).toMatchObject({ accepted: 0 });
    await f.identity();
    expect(await f.value('select followers_count v from public.creators where id=$1', [creator])).toBe(0);
    expect(await f.value('select count(*)::int v from public.creator_follower_snapshots where creator_id=$1', [creator])).toBe(1);
    expect(await f.value('select jsonb_build_object(\'status\',status,\'result\',result_count,\'received\',received_count) v from public.scrape_job_creators where job_id=$1', [missing.processing.id]))
      .toEqual({ status: 'failed', result: 0, received: 1 });
  });
});

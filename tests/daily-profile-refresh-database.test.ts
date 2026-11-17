import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner, fixtureStranger } from './support/feature-database';

const migration = '202611150010_daily_profile_refresh.sql';
let f: Awaited<ReturnType<typeof featureDatabase>>;
let sequence = 0;
type Maintained = { job_ids: string[]; created: number; reason: string | null };
type Job = { id: string; kind: string; status: string; requested_profiles_count: number; results_limit: number;
  profile_automatic: boolean; profile_automation_scheduled_at: string | null; manual_authorized_by: string | null;
  reserved_usd: number; actual_cost_usd: number | null; dispatch_nonce: string | null; apify_account_slot: number | null };
type Claim = { reason?: string; job?: Job; creators?: { id: string; username: string }[]; max_total_charge_usd?: number };
type Status = { enabled: boolean; provider_validated: boolean; paused: boolean; reason: string | null;
  interval_hours: number; batch_limit: number; due_creators: number; pending_jobs: number; active_jobs: number;
  last_fetch_at: string | null; next_due_at: string | null };

beforeAll(async () => {
  // Exercise this historical rollout before later patches replace its contracts.
  const later = readdirSync(join(process.cwd(), 'supabase/migrations')).filter(file => file.endsWith('.sql') && file > migration);
  f = await featureDatabase({ excludeMigrations: [migration, ...later] });
}, 60_000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => {
  await f.identity(); await f.db.exec('begin');
  await f.db.exec("update public.scrape_jobs set scheduled_for=now()-interval '2 days'; update public.creators set status='paused';");
});
afterEach(async () => { await f.db.exec('rollback'); await f.identity(); });
async function migrate() { await f.identity(); await f.db.exec(readFileSync(join(process.cwd(), 'supabase/migrations', migration), 'utf8')); }
async function configure(enabled = true, validated = true) {
  await f.identity('service_role'); return f.rpc('worker_configure_profile_automation', [fixtureOwner, enabled, validated]);
}
async function maintain(limit = 20) {
  await f.identity('service_role'); return f.rpc<Maintained>('worker_profile_maintain', [fixtureOwner, limit]);
}
async function status(owner = fixtureOwner) {
  await f.identity('authenticated', owner); return f.rpc<Status>('get_profile_automation_status');
}
async function add(count = 1, workspace = f.workspace, age: number | null = null) {
  await f.identity();
  const ids = (await f.db.query<{ id: string }>(`insert into public.creators(username,status,last_profile_fetch_at)
    select $1||n,'active',case when $3::integer is null then null else now()-make_interval(hours=>$3::integer) end
      from generate_series(1,$2::integer) n returning id`, [`daily_${++sequence}_`, count, age])).rows.map(row => row.id);
  await f.db.query('insert into public.workspace_creators(workspace_id,creator_id) select $1,unnest($2::uuid[])', [workspace, ids]);
  return ids;
}
async function job(id: string) {
  await f.identity(); return f.value<Job>('select to_jsonb(j) v from public.scrape_jobs j where id=$1', [id]);
}
async function tickAgain() {
  await f.identity(); await f.db.exec("update profile_automation_private.settings set last_maintenance_at=clock_timestamp()-interval '5 minutes 1 second'");
}
async function claim(fair = false, kinds = ['profile']) {
  await f.identity('service_role');
  return fair ? f.rpc<Claim>('worker_claim_next', [fixtureOwner, true, Object.fromEntries(kinds.map(kind => [kind, 'fixture-actor'])), kinds])
    : f.rpc<Claim>('worker_claim_dispatch', [fixtureOwner, true, 'fixture-actor', 'profile']);
}
async function reject(work: () => Promise<unknown>, message: RegExp) {
  await f.db.exec('savepoint rejected_profile_call');
  try { await expect(work()).rejects.toThrow(message); }
  finally { await f.db.exec('rollback to savepoint rejected_profile_call; release savepoint rejected_profile_call'); }
}
async function manual(ids: string[]) {
  await f.identity('authenticated'); return f.rpc<string[]>('queue_creator_jobs', [fixtureOwner, ids, 'profile']);
}
// Browser users cannot call the queue helper directly; enqueue_refresh delegates
// through its authorized workspace wrapper and marks only genuine manual jobs.
async function manualRefresh(ids: string[]) {
  await f.identity('authenticated');
  return f.rpc<{ job_ids: string[]; profile_job_ids: string[] }>('enqueue_refresh', [f.workspace, ids, 'profile']);
}
async function attempted(creator: string, kind = 'profile', state = 'partial', hours = 48) {
  await f.identity();
  const id = await f.value<string>(`insert into public.scrape_jobs(owner_user_id,kind,status,requested_profiles_count,results_limit,scheduled_for,
    started_at,attempt_count,live,reserved_usd,actual_cost_usd,expected_provider_user_id,expected_actor_id,apify_account_slot)
    values($1,$2,$3,1,case when $2='profile' then 1 else 10 end,now()-make_interval(hours=>$4::integer),
      now()-make_interval(hours=>$4::integer),1,true,.123,null,'fixture','fixture-actor',1) returning id v`, [fixtureOwner, kind, state, hours]);
  await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [id, creator]);
  return id;
}

describe('daily combined profile automation database contract', () => {
  it('requires the latest 009 guard, migrates without adopting backlog, and defaults disabled/private', async () => {
    const [creator] = await add();
    const pending = (await manualRefresh([creator])).job_ids[0];
    await f.identity();
    const before = await f.value<Record<string, unknown>>('select to_jsonb(j) v from public.scrape_jobs j where id=$1', [pending]);
    const configBefore = await f.value('select to_jsonb(s) v from public.app_settings s where owner_user_id=$1', [fixtureOwner]);
    expect(await f.value<boolean>("select to_regprocedure('competitor_refresh_private.prepare_metrics_window(uuid,uuid)') is not null v")).toBe(true);
    await migrate();
    const after = await job(pending);
    expect(after).toEqual({ ...before, profile_automatic: false, profile_automation_scheduled_at: null });
    expect(await f.value('select to_jsonb(s) v from public.app_settings s where owner_user_id=$1', [fixtureOwner])).toEqual(configBefore);
    const state = await status();
    expect(state).toEqual({ enabled: false, provider_validated: false, paused: false, reason: 'disabled', interval_hours: 24,
      batch_limit: 20, due_creators: 0, pending_jobs: 1, active_jobs: 0, last_fetch_at: null, next_due_at: null });
    expect(await maintain()).toEqual({ job_ids: [], created: 0, reason: 'disabled' });
    await f.identity();
    expect(await f.value<number>('select count(*)::integer v from profile_automation_private.queue_scope')).toBe(0);
    expect(await f.value<number>(`select count(*)::integer v from pg_trigger where tgrelid='profile_automation_private.settings'::regclass
      and not tgisinternal and tgname like 'owner%revision%' and tgdeferrable and tginitdeferred`)).toBe(4);
    expect(await f.value<number>('select count(*)::integer v from cron.job')).toBe(0);
    expect(await f.value<number>('select count(*)::integer v from net.requests')).toBe(0);
  });

  it('queues one <=20 profile response batch for 45 canonical creators and throttles across ticks/config toggles', async () => {
    const ids = await add(45); await migrate(); await configure();
    expect((await status()).due_creators).toBe(45);
    const first = await maintain();
    expect(first).toMatchObject({ created: 1, reason: null }); expect(first.job_ids).toHaveLength(1);
    expect(await job(first.job_ids[0])).toMatchObject({ kind: 'profile', requested_profiles_count: 20, results_limit: 1,
      profile_automatic: true, manual_authorized_by: fixtureOwner, reserved_usd: 0, actual_cost_usd: null });
    expect(await maintain()).toEqual({ job_ids: [], created: 0, reason: 'maintenance_throttled' });
    await configure(false); await configure();
    expect(await maintain()).toMatchObject({ created: 0, reason: 'maintenance_throttled' });
    await tickAgain(); const second = await maintain();
    expect(second.created).toBe(1); expect(second.job_ids).toHaveLength(1);
    await tickAgain(); expect((await maintain()).created).toBe(1);
    await tickAgain(); expect(await maintain()).toEqual({ job_ids: [], created: 0, reason: 'no_due_profiles' });
    await f.identity();
    expect(await f.value<string[]>('select array_agg(jc.creator_id::text order by jc.creator_id) v from public.scrape_job_creators jc join public.scrape_jobs j on j.id=jc.job_id where j.profile_automatic')).toEqual(ids.sort());
    expect(await f.value<number>('select count(*)::integer v from profile_automation_private.queue_scope')).toBe(0);
    expect((await status()).due_creators).toBe(0);
  });

  it('covers 125+ profiles across every owner workspace once, with oldest due ordering and no new backfill', async () => {
    await f.identity('authenticated');
    const otherWorkspace = (await f.rpc<{ id: string }>('create_workspace', ['Second profiles'])).id;
    const oldest = await add(1, otherWorkspace, 100);
    const fresh = await add(1, otherWorkspace, 2);
    const ids = await add(126, otherWorkspace, 48);
    await f.identity();
    await f.db.query('insert into public.workspace_creators(workspace_id,creator_id) select $1,unnest($2::uuid[])', [f.workspace, ids]);
    await migrate(); await configure();
    expect((await status()).due_creators).toBe(127);
    const initializations = await f.value<number>('select count(*)::integer v from public.creator_initializations');
    const seen: string[] = [];
    for (let tick = 0; tick < 7; tick++) {
      if (tick) await tickAgain();
      const batch = await maintain(); expect(batch.job_ids).toHaveLength(1);
      await f.identity();
      const rows = await f.value<string[]>('select array_agg(creator_id::text) v from public.scrape_job_creators where job_id=$1', [batch.job_ids[0]]);
      if (!tick) expect(rows).toContain(oldest[0]);
      seen.push(...rows);
    }
    expect(seen).toHaveLength(127); expect(new Set(seen).size).toBe(127); expect(seen).not.toContain(fresh[0]);
    expect(await f.value<number>('select count(*)::integer v from public.creator_initializations')).toBe(initializations);
    expect(await f.value<number>("select count(*)::integer v from public.scrape_jobs where profile_automatic and kind<>'profile'")).toBe(0);
  });

  it('excludes inactive/archived/paused/private/unavailable canonical creators and never adopts pending manual jobs', async () => {
    const ids = await add(6); const pending = (await manualRefresh([ids[0]])).job_ids[0];
    await f.identity();
    await f.db.query('update public.workspace_creators set active=false where creator_id=$1', [ids[1]]);
    for (const [index, value] of [[2, 'paused'], [3, 'private'], [4, 'unavailable']] as const) {
      await f.db.query('update public.creators set status=$2 where id=$1', [ids[index], value]);
    }
    await f.identity('authenticated'); const archived = (await f.rpc<{ id: string }>('create_workspace', ['Archived profiles'])).id;
    await add(1, archived); await f.identity(); await f.db.query('update public.workspaces set archived_at=now() where id=$1', [archived]);
    await migrate(); await configure(); const result = await maintain();
    expect(result.created).toBe(1);
    expect(await job(pending)).toMatchObject({ profile_automatic: false, profile_automation_scheduled_at: null });
    expect(await f.value<string[]>('select array_agg(creator_id::text) v from public.scrape_job_creators where job_id=$1', [result.job_ids[0]])).toEqual([ids[5]]);
  });

  it('uses rolling 24h max of captures and manual/automatic scheduled or started attempts, not calendar days or verified OUTPUT', async () => {
    const ids = await add(5, f.workspace, 48);
    await attempted(ids[0], 'profile', 'failed', 25);
    await f.db.query('update public.scrape_jobs set actual_cost_usd=0,reserved_usd=0 where status=$1', ['failed']);
    await f.db.query('update public.creators set last_profile_fetch_at=now()-interval \'23 hours\' where id=$1', [ids[0]]);
    await attempted(ids[1], 'profile', 'partial', 25);
    await f.db.query("update public.scrape_jobs set actual_cost_usd=0,reserved_usd=0,started_at=now()-interval '23 hours' where status='partial'");
    const scheduled = await attempted(ids[2], 'profile', 'failed', 25);
    await f.db.query("update public.scrape_jobs set actual_cost_usd=0,reserved_usd=0,scheduled_for=now()-interval '23 hours' where id=$1", [scheduled]);
    await attempted(ids[3], 'profile', 'partial', 25);
    await f.db.query("update public.scrape_jobs set actual_cost_usd=0,reserved_usd=0 where status='partial'");
    await migrate(); await configure();
    expect((await status()).due_creators).toBe(2);
    expect((await maintain()).created).toBe(1);
    await f.identity();
    expect(await f.value<number>("select count(*)::integer v from public.scrape_jobs where profile_automatic and output_summary_verified")).toBe(0);
  });

  it.each(['profile', 'daily'])('skips active/uncertain/unknown %s holds even after 24h, without clearing pins or reservations', async kind => {
    const ids = await add(4); const old = await attempted(ids[0], kind, 'partial');
    await attempted(ids[1], kind, 'uncertain'); await attempted(ids[2], kind, 'running');
    const before = await f.value('select to_jsonb(j) v from public.scrape_jobs j where id=$1', [old]);
    await migrate(); await configure(); const next = await maintain();
    expect(next.created).toBe(1);
    expect(await f.value('select to_jsonb(j)-\'profile_automatic\'-\'profile_automation_scheduled_at\' v from public.scrape_jobs j where id=$1', [old])).toEqual(before);
    expect((await status()).reason).toBe('concurrency_limit');
  });

  it.each(['disabled', 'paused', 'scraping_disabled'] as const)('rechecks %s after queueing and before both direct/fair paid claims, retaining original job input/holds', async gate => {
    await add(); await migrate(); await configure(); const { job_ids: [id] } = await maintain();
    const before = await job(id);
    if (gate === 'disabled') await configure(false);
    else { await f.identity(); await f.db.query(`update public.app_settings set ${gate === 'paused' ? 'paused=true' : 'scraping_enabled=false'}`); }
    expect(await claim()).toEqual({ reason: gate === 'scraping_disabled' ? 'globalscraping_disabled' : gate });
    expect((await claim(true)).job).toBeUndefined(); expect(await job(id)).toEqual(before);
    expect((await status()).reason).toBe(gate); expect((await status()).next_due_at).toBeNull();
  });

  it.each(['unlink', 'archive', 'paused', 'new_capture', 'unknown_overlap', 'wrong_membership'] as const)(
    'rechecks full batch %s before any reservation and skips its automatic candidate', async defect => {
      const ids = await add(2); await migrate(); await configure(); const { job_ids: [id] } = await maintain();
      await f.identity();
      if (defect === 'unlink') await f.db.query('update public.workspace_creators set active=false where creator_id=$1', [ids[0]]);
      if (defect === 'archive') await f.db.query('update public.workspaces set archived_at=now() where id=$1', [f.workspace]);
      if (defect === 'paused') await f.db.query("update public.creators set status='paused' where id=$1", [ids[0]]);
      if (defect === 'new_capture') await f.db.query('update public.creators set last_profile_fetch_at=now() where id=$1', [ids[0]]);
      if (defect === 'unknown_overlap') await attempted(ids[0], 'daily', 'partial');
      if (defect === 'wrong_membership') await f.db.query('delete from public.scrape_job_creators where job_id=$1 and creator_id=$2', [id, ids[0]]);
      const before = await job(id);
      expect(await claim()).toEqual({ reason: 'profile_overlap_or_ineligible_attempt' });
      expect((await claim(true)).job).toBeUndefined(); expect(await job(id)).toEqual(before);
    },
  );

  it('disabled automatic profiles cannot starve later genuine manual profiles or other fair categories; manual profiles retain pause semantics', async () => {
    await add(); await migrate(); await configure(); const { job_ids: [automatic] } = await maintain();
    const [manualCreator] = await add(); const manualId = (await manualRefresh([manualCreator])).job_ids[0];
    await configure(false); await f.identity(); await f.db.exec('update public.app_settings set paused=true');
    const result = await claim(true);
    expect(result.job).toMatchObject({ id: manualId, profile_automatic: false, status: 'dispatching', actual_cost_usd: null });
    expect(await job(automatic)).toMatchObject({ status: 'pending', reserved_usd: 0 });
    await f.identity(); await f.db.exec("update public.scrape_jobs set status='failed',actual_cost_usd=0,reserved_usd=0 where status='dispatching'; update public.app_settings set paused=false;");
    const [reelsCreator] = await add(); await f.identity('service_role');
    const reelJobs = await f.rpc<string[]>('queue_creator_jobs', [fixtureOwner, [reelsCreator], 'daily']);
    expect((await claim(true, ['profile', 'daily'])).job?.id).toBe(reelJobs[0]);
  });

  it('starts one combined batch through existing account/monthly budget allocator with unknown cost and durable identity, then blocks replay', async () => {
    await add(3); await migrate(); await configure(); const { job_ids: [id] } = await maintain();
    const result = await claim();
    expect(result.job).toMatchObject({ id, status: 'dispatching', results_limit: 1, requested_profiles_count: 3,
      profile_automatic: true, manual_authorized_by: fixtureOwner, apify_account_slot: 1, actual_cost_usd: null });
    expect(result.creators).toHaveLength(3); expect(result.job!.reserved_usd).toBeGreaterThan(0);
    expect(result.max_total_charge_usd).toBe(result.job!.reserved_usd);
    await f.identity('service_role'); await f.rpc('worker_start_uncertain', [id, result.job!.dispatch_nonce]);
    const before = await job(id); await tickAgain(); expect((await maintain()).created).toBe(0);
    expect((await claim()).job).toBeUndefined(); expect(await job(id)).toEqual(before);
    await reject(() => f.db.query('update public.scrape_jobs set profile_automatic=false,profile_automation_scheduled_at=null where id=$1', [id]), /profile_automation_provenance_is_durable/);
  });

  it('ingests followers, name, and avatar from one combined response and retains valid captures despite unverified/partial OUTPUT', async () => {
    const [creator] = await add(); await migrate(); await configure(); const { job_ids: [id] } = await maintain();
    const claimed = await claim(); expect(claimed.job?.id).toBe(id);
    await f.identity();
    const username = await f.value<string>('select username v from public.creators where id=$1', [creator]);
    const lease = await f.value<string>('select lease_token v from public.scrape_jobs where id=$1', [id]);
    await f.db.query("update public.scrape_jobs set status='processing',provider_terminal_status='SUCCEEDED',lease_expires_at=now()+interval '3 minutes' where id=$1", [id]);
    const captured = await f.value<string>('select now()::text v');
    const record = { creator_id: creator, username, provider: 'synthetic-fixture', fetched_at: captured,
      followers_count: 1234, display_name: 'Combined synthetic profile', avatar_url: 'https://scontent.cdninstagram.com/synthetic-avatar.jpg' };
    await f.identity('service_role');
    await f.rpc('worker_ingest_page', [id, lease, 0, JSON.stringify([record]), '[]', 1, true, JSON.stringify({ [creator]: 1 })]);
    await f.identity();
    expect(await f.value('select jsonb_build_object(\'followers_count\',followers_count,\'display_name\',display_name,\'avatar_url\',avatar_url) v from public.creators where id=$1', [creator]))
      .toEqual({ followers_count: 1234, display_name: record.display_name, avatar_url: record.avatar_url });
    expect(await job(id)).toMatchObject({ actual_cost_usd: null, requested_profiles_count: 1, results_limit: 1 });
    expect(await f.value<boolean>('select output_summary_verified v from public.scrape_jobs where id=$1', [id])).toBe(false);
    expect(await f.value<number>('select count(*)::integer v from public.creator_follower_snapshots where creator_id=$1', [creator])).toBe(1);
    await f.db.query("update public.scrape_jobs set status='partial',completed_at=now() where id=$1", [id]);
    const state = await status(); expect(state.last_fetch_at).not.toBeNull(); expect(state.due_creators).toBe(0);
    await tickAgain(); expect((await maintain()).created).toBe(0);
  });

  it.each(['budget_paused', 'usage_unverified', 'unreconciled_charges'] as const)('reports truthful %s readiness without estimating/settling charges or preventing guarded enqueue', async blocker => {
    const ids = await add(2); await migrate(); await configure();
    await f.identity();
    if (blocker === 'budget_paused') await f.db.exec('update public.app_settings set monthly_budget_usd=0');
    if (blocker === 'usage_unverified') await f.db.exec('update public.apify_accounts set usage_checked_at=null');
    if (blocker === 'unreconciled_charges') await attempted(ids[0]);
    expect((await status()).reason).toBe(blocker); expect((await status()).next_due_at).toBeNull();
    const scheduled = await maintain(); expect(scheduled.created).toBe(1);
    expect(await job(scheduled.job_ids[0])).toMatchObject({ requested_profiles_count: blocker === 'unreconciled_charges' ? 1 : 2 });
    expect((await claim()).job).toBeUndefined();
    expect(await job(scheduled.job_ids[0])).toMatchObject({ reserved_usd: 0, actual_cost_usd: null });
  });

  it('denies wrong owners/browser/service private scope access, forged marks, ordinary service manual grants, and invalid limits/configuration', async () => {
    const [creator] = await add(); await migrate();
    await f.identity('service_role');
    await reject(() => f.rpc('worker_configure_profile_automation', [fixtureOwner, true, false]), /invalid_profile_automation_configuration/);
    await reject(() => f.rpc('worker_configure_profile_automation', [fixtureStranger, true, true]), /owner_not_provisioned/);
    for (const limit of [0, 21, null]) await reject(() => f.rpc('worker_profile_maintain', [fixtureOwner, limit]), /invalid_profile_maintenance_scope/);
    expect(await f.rpc('worker_profile_maintain', [fixtureStranger])).toEqual({ job_ids: [], created: 0, reason: 'owner_not_provisioned' });
    await reject(() => f.db.query("insert into public.scrape_jobs(owner_user_id,kind,results_limit,requested_profiles_count,manual_authorized_by) values($1,'profile',1,1,$1)", [fixtureOwner]), /profile_manual_authorization_requires_owner/);
    const unauthorized = (await f.rpc<string[]>('queue_creator_jobs', [fixtureOwner, [creator], 'profile']))[0];
    expect(await job(unauthorized)).toMatchObject({ manual_authorized_by: null, profile_automatic: false });
    await f.identity('service_role');
    await reject(() => f.db.query('update public.scrape_jobs set manual_authorized_by=$2 where id=$1', [unauthorized, fixtureOwner]), /profile_manual_authorization_requires_owner/);
    await reject(() => f.db.query('update public.scrape_jobs set profile_automatic=true,profile_automation_scheduled_at=now(),manual_authorized_by=$2 where id=$1', [unauthorized, fixtureOwner]), /profile_automation_queue_scope_required/);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await f.identity();
      expect(await f.value<boolean>("select has_schema_privilege($1,'profile_automation_private','usage') v", [role])).toBe(false);
      expect(await f.value<boolean>("select has_table_privilege($1,'profile_automation_private.settings','select') v", [role])).toBe(false);
      await f.identity(role);
      if (role !== 'service_role') {
        await reject(() => f.rpc('worker_profile_maintain', [fixtureOwner]), /permission denied/);
        await reject(() => f.rpc('worker_configure_profile_automation', [fixtureOwner, true, true]), /permission denied/);
      }
      if (role !== 'authenticated') await reject(() => f.rpc('get_profile_automation_status'), /permission denied/);
      await reject(() => f.db.query('select profile_automation_private.queue_new($1,$2,now())', [fixtureOwner, [creator]]), /permission denied/);
    }
    await f.identity('authenticated', fixtureStranger); await reject(() => f.rpc('get_profile_automation_status'), /forbidden/);
    await f.identity('authenticated'); await reject(() => manual([creator]), /permission denied/);
  });

  it('status is read-only and owner-global; partial profile capture provides truthful last/next timestamps', async () => {
    await add(1, f.workspace, 23); await migrate(); await configure();
    await f.identity();
    const before = await f.value('select to_jsonb(s) v from profile_automation_private.settings s where owner_user_id=$1', [fixtureOwner]);
    const state = await status();
    expect(state).toMatchObject({ enabled: true, provider_validated: true, reason: null, interval_hours: 24, batch_limit: 20,
      due_creators: 0, pending_jobs: 0, active_jobs: 0 });
    expect(state.last_fetch_at).not.toBeNull(); expect(state.next_due_at).not.toBeNull();
    expect(new Date(state.next_due_at!).getTime() - new Date(state.last_fetch_at!).getTime()).toBe(86_400_000);
    await status(); await f.identity();
    expect(await f.value('select to_jsonb(s) v from profile_automation_private.settings s where owner_user_id=$1', [fixtureOwner])).toEqual(before);
    expect(await f.value<number>('select count(*)::integer v from profile_automation_private.queue_scope')).toBe(0);
    expect(await f.value<number>('select count(*)::integer v from net.requests')).toBe(0);
  });
});

#!/usr/bin/env node
/**
 * Genuine local PostgreSQL release gate; no PGlite, hosted DSN, provider, or Cron.
 * From the repository workspace (never from the downloaded package directory):
 *   npm install --prefix .tmp/native-pg-release --no-audit --no-fund --save-exact embedded-postgres@18.6.0-beta.19 pg@8.16.3
 *   node scripts/local-pg-concurrency.mjs
 * The default gate runs eight core cases. Set REELRADAR_PG_CASE to a case-name
 * regex for focused reruns or .* for the extended local SQL cases.
 * Optional REELRADAR_NATIVE_PG_BIN points to a local directory containing
 * initdb, pg_ctl, and postgres. REELRADAR_NATIVE_PG_TOOLS points to the isolated
 * npm install directory (for pg). No connection-string environment is accepted.
 * Each case clones a fresh synthetic migrated database. Exact production SQL,
 * including auth checks, RLS and all revision/completion triggers, stays enabled.
 * Manual lock prefixes below only stop a real RPC at its documented lock-order
 * boundary; they do not change functions, disable triggers, or retry deadlocks.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(resolve(process.cwd()), root, 'Run from the repository workspace, not the downloaded tools directory');
const tools = resolve(process.env.REELRADAR_NATIVE_PG_TOOLS || join(root, '.tmp/native-pg-release'));
const platformPackage = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
const bin = resolve(process.env.REELRADAR_NATIVE_PG_BIN || join(tools, 'node_modules/@embedded-postgres', platformPackage, 'native/bin'));
const executable = name => join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
for (const name of ['initdb', 'pg_ctl', 'postgres']) {
  assert.ok(existsSync(executable(name)), `Native ${name} missing; install the pinned isolated npm tools or set REELRADAR_NATIVE_PG_BIN`);
}
const requireTool = createRequire(join(tools, 'package.json'));
const { Client } = requireTool('pg');
const exec = promisify(execFile);
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const started = performance.now();
const results = [];
const barriers = [];
const connections = new Set();
let control, template, cluster, serverStarted = false, fixture, version, caseNumber = 0;
const filter = new RegExp(process.env.REELRADAR_PG_CASE || 'ingestion|creator and job|simultaneous fair|owner and per-account|expired executor|new request barrier|checkpoint transaction', 'u');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/i.test(key)));
const migrationsDir = join(root, 'supabase/migrations');
const migrations = readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort().map(name => ({
  name, sql: readFileSync(join(migrationsDir, name), 'utf8'),
}));
const migrationDigest = () => createHash('sha256').update(migrations.map(({ name }) => name + '\n' + readFileSync(join(migrationsDir, name), 'utf8')).join('\n')).digest('hex');
const digest = migrationDigest();
// Reuse the exact auth/vault/cron/net SQL and fake owners already reviewed by the
// serial feature tests. Only pg_cron/pg_net extension installation is stubbed.
const fixtureSource = readFileSync(join(root, 'tests/support/feature-database.ts'), 'utf8');
const fixtureSql = fixtureSource.match(/await db\.exec\(`([\s\S]*?)`\);/u)?.[1];
const owner = fixtureSource.match(/fixtureOwner = '([^']+)'/u)?.[1];
const stranger = fixtureSource.match(/fixtureStranger = '([^']+)'/u)?.[1];
assert.ok(fixtureSql && owner && stranger, 'Feature fixture extraction contract changed; review it before running');
const kinds = ['profile', 'daily', 'weekly', 'backfill', 'manual', 'retry', 'discovery', 'metrics', 'carousel'];
const actors = Object.fromEntries(kinds.map(kind => [kind, 'fixture-actor']));
const cycle = [new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 20 * 86400000).toISOString()];
const password = randomUUID(); // Ephemeral local authentication only; never printed.
let port;

async function value(client, sql, args = []) { return (await client.query(sql, args)).rows[0]?.v; }
async function rpc(client, name, args = []) {
  assert.match(name, /^worker_[a-z_]+$|^(provision_owner|create_workspace|add_creator|get_apify_account_status)$/u);
  return value(client, `select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) v`, args);
}
async function identity(client, role = 'service_role', user = owner) {
  assert.ok(['postgres', 'anon', 'authenticated', 'service_role'].includes(role));
  await client.query('reset role');
  await client.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role, sub: user })]);
  if (role !== 'postgres') await client.query(`set role ${role}`);
}
async function connect(database, role = 'service_role') {
  const client = new Client({ host: '127.0.0.1', port, user: 'postgres', password, database,
    application_name: `reelradar-local-release-${caseNumber}`, connectionTimeoutMillis: 5000 });
  connections.add(client);
  client.on('error', () => {}); // Query errors still propagate; teardown errors do not crash Node.
  try {
    await client.connect();
    client.releaseConnected = true;
  } catch (error) {
    await close(client);
    throw new Error(`Local ${database} connection failed: ${error.message}`, { cause: error });
  }
  await client.query("set statement_timeout='20s'; set lock_timeout='15s'; set idle_in_transaction_session_timeout='45s'; set deadlock_timeout='300ms'");
  client.pid = await value(client, 'select pg_backend_pid() v');
  await identity(client, role);
  return client;
}
async function close(client) {
  // A pg connect timeout leaves a never-ready client in the set. Enqueuing
  // rollback on it never settles, hiding the original failure indefinitely.
  if (client.releaseConnected) await client.query('rollback').catch(() => {});
  await client.end().catch(() => {});
  connections.delete(client);
}
async function transaction(client, run) {
  await client.query('begin');
  try { const result = await run(); await client.query('commit'); return result; }
  catch (error) { await client.query('rollback').catch(() => {}); throw error; }
}
function tracked(promise) {
  // Attach a handler immediately: deterministic lock waits can fail before the
  // coordinator joins them. No automatic retry, especially for 40P01/40001.
  return promise.then(result => ({ ok: true, result }), error => ({ ok: false, error }));
}
async function checked(promise) { const outcome = await promise; if (!outcome.ok) throw outcome.error; return outcome.result; }
async function waitBlocked(label, pids, blocker = null) {
  // Windows may schedule the eighth backend late during a build/test run.
  // Still require every session to be blocked concurrently, below the 15s
  // database lock timeout; do not retry queries or waive the barrier.
  const deadline = performance.now() + 10000;
  let rows;
  do {
    rows = (await control.query(`select pid,wait_event_type,wait_event,pg_blocking_pids(pid) blockers
      from pg_stat_activity where pid=any($1::int[]) order by pid`, [pids])).rows;
    if (rows.length === pids.length && rows.every(row => row.wait_event_type === 'Lock' && row.blockers.length && (blocker === null || row.blockers.includes(blocker)))) {
      const locks = (await control.query(`select pid,locktype,mode,granted from pg_locks where pid=any($1::int[]) and not granted`, [pids])).rows;
      barriers.push({ label, sessions: pids.length, backends: rows, waits: rows.map(row => row.wait_event), locks: locks.map(row => row.locktype) });
      return;
    }
    await sleep(10);
  } while (performance.now() < deadline);
  throw new Error(`Missing server-side contention barrier ${label}: ${JSON.stringify(rows)}`);
}
async function budgetLock(client) {
  await client.query("select pg_advisory_xact_lock(hashtextextended('budget:'||$1::text,0))", [owner]);
}
const next = (client, lease = null, live = true) => rpc(client, 'worker_claim_next', [owner, live, JSON.stringify(actors), kinds,
  ...(lease ? [lease.executor_nonce, lease.claimed_revision] : [])]);
const runtime = client => rpc(client, 'worker_collection_runtime', [owner]);
const executor = (client, completionOnly = true) => rpc(client, 'worker_claim_collection_executor', [owner, completionOnly]);
const drain = (client, lease) => rpc(client, 'worker_drain_completion_wake', [owner, lease.claimed_revision, lease.executor_nonce]);
const beginUsage = (client, slot = 1) => rpc(client, 'worker_begin_account_usage', [owner, slot, slot === 1 ? 'fixture' : `account-${slot}`]);
const persistUsage = (client, observation, amount = 0, limit = 50, slot = 1) => rpc(client, 'worker_record_account_usage',
  [owner, slot, slot === 1 ? 'fixture' : `account-${slot}`, ...cycle, amount, limit, observation?.observation_id ?? null, observation?.observed_at ?? null]);
async function seed(client, count = 8, kind = 'daily') {
  return transaction(client, async () => {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const id = await value(client, `insert into public.scrape_jobs(owner_user_id,kind,requested_profiles_count,results_limit,manual_authorized_by)
        values($1,$2,1,$3,$1) returning id v`, [owner, kind, kind === 'profile' ? 1 : 30]);
      await client.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [id, fixture.creator]);
      ids.push(id);
    }
    return ids;
  });
}
async function configure(client, max, budget = 50) {
  await identity(client, 'postgres');
  await client.query('update public.app_settings set monthly_budget_usd=$1', [budget]);
  await identity(client);
  await rpc(client, 'worker_configure_collection_throughput', [owner, max, max]);
}
async function wave(db, label, run, count = 8) {
  const clients = await Promise.all(Array.from({ length: count }, () => connect(db)));
  const gate = await connect(db, 'postgres');
  try {
    assert.equal(new Set(clients.map(client => client.pid)).size, count, 'Each contender must have a distinct PostgreSQL backend');
    await gate.query('begin'); await budgetLock(gate);
    await Promise.all(clients.map(client => client.query('begin')));
    const tasks = clients.map((client, index) => tracked((async () => {
      const result = await run(client, index);
      await client.query('commit');
      return result;
    })()));
    await waitBlocked(label, clients.map(client => client.pid));
    await gate.query('commit');
    const outcomes = await Promise.all(tasks);
    for (const outcome of outcomes) if (!outcome.ok) throw outcome.error;
    return outcomes.map(outcome => outcome.result);
  } finally { await Promise.all([gate, ...clients].map(close)); }
}
async function invariants(client, max, ownerBudget) {
  const row = await value(client, `select jsonb_build_object('active',count(*) filter(where status in ('dispatching','running','processing','uncertain')),
    'hold',coalesce(sum(reserved_usd) filter(where live),0),'cost',coalesce(sum(actual_cost_usd) filter(where live and billing_month=date_trunc('month',now() at time zone 'UTC')::date),0),
    'unknown_costs',count(*) filter(where live and actual_cost_usd is null),'attempt_max',coalesce(max(attempt_count),0)) v from public.scrape_jobs`);
  assert.ok(row.active <= max, `active ${row.active} exceeds ${max}`);
  assert.ok(row.hold + row.cost <= ownerBudget + 0.0000001, 'Owner monetary ceiling exceeded');
  const accounts = (await client.query(`select a.slot,a.limit_usd::float8 limit_usd,coalesce(sum(j.reserved_usd),0)::float8 hold,
    count(j.id) filter(where j.status in ('dispatching','running','processing','uncertain'))::int outstanding
    from public.apify_accounts a left join public.scrape_jobs j on j.owner_user_id=a.owner_id and j.apify_account_slot=a.slot and j.live
    group by a.slot,a.limit_usd order by a.slot`)).rows;
  assert.ok(accounts.every(account => account.outstanding <= 1), 'More than one outstanding job on an account');
  assert.ok(accounts.every(account => account.hold <= account.limit_usd + 0.0000001), 'Account hold exceeds allowance');
  assert.ok(row.attempt_max <= 1, 'Accepted prior start was replayed');
  return row;
}
async function processing(client, kind = 'daily', slot = 1, cost = 0, hold = 0) {
  await identity(client, 'postgres');
  const [id] = await seed(client, 1, kind);
  // Preserve the real immutable-pin trigger: pin at dispatching first, exactly
  // as the allocator does, then seed synthetic accepted-run processing metadata.
  await client.query(`update public.scrape_jobs set status='dispatching',live=true,collection_source='ordinary',apify_account_slot=$2,
    expected_actor_id='fixture-actor',expected_provider_user_id=$3,dispatch_nonce=gen_random_uuid(),attempt_count=1 where id=$1`,
  [id, slot, slot === 1 ? 'fixture' : `account-${slot}`]);
  await client.query(`update public.scrape_jobs set status='processing',actor_run_id=$2,
    lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '5 minutes',provider_terminal_status='SUCCEEDED',
    billing_month=date_trunc('month',now() at time zone 'UTC')::date,
    actual_cost_usd=$3,reserved_usd=$4,billing_reconciled_at=case when $3::numeric is not null then clock_timestamp() end,
    result_fetched_at=clock_timestamp(),dataset_finished=true,output_summary_verified=true,returned_records_count=1 where id=$1`,
  [id, `synthetic-${id}`, cost, hold]);
  await client.query("update public.scrape_job_creators set result_count=1,status='active',completion_status='completed' where job_id=$1", [id]);
  const result = await value(client, 'select to_jsonb(j) v from public.scrape_jobs j where id=$1', [id]);
  await identity(client);
  return result;
}
const finish = (client, job) => rpc(client, 'worker_finish_processing', [job.id, job.lease_token]);
const reconcile = (client, job, cost = 0.01) => rpc(client, 'worker_reconcile_run', [job.id, job.actor_run_id, 'fixture-actor', job.expected_provider_user_id, 'SUCCEEDED', 'synthetic-dataset', cost]);
function ingest(client, job, finished = true) {
  const record = { creator_id: fixture.creator, username: 'backend_fixture', shortcode: `NATIVE_${job.id.replaceAll('-', '')}`,
    reel_url: 'https://www.instagram.com/reel/SYNTHETIC_NATIVE/', caption_full: 'Synthetic local release fixture', published_at: cycle[0],
    published_at_basis: 'explicit_offset', fetched_at: new Date().toISOString(), views: 100, likes: 10, comments: 0,
    views_state: 'known', likes_state: 'known', comments_state: 'known', provider: 'fixture', media_candidates: [], has_audio: false };
  return rpc(client, 'worker_ingest_page', [job.id, job.lease_token, 0, JSON.stringify([record]), '[]', 1, finished, JSON.stringify({ [fixture.creator]: 1 })]);
}
async function test(name, run) {
  if (filter && !filter.test(name)) return;
  const start = performance.now();
  const db = `reelradar_case_${++caseNumber}`;
  const openedBefore = new Set(connections);
  try {
    await control.query(`create database ${db} template reelradar_fixture`);
    const client = await connect(db, 'postgres');
    await run({ db, client });
    await identity(client, 'postgres');
    assert.equal(await value(client, 'select count(*)::int v from net.requests'), 0, 'Network fixture was invoked');
    assert.equal(await value(client, 'select count(*)::int v from cron.job'), 0, 'Cron fixture was scheduled');
    assert.equal(await value(client, 'select count(*)::int v from vault.secrets'), 0, 'No secrets are needed for the concurrency fixture');
    results.push({ name, verdict: 'PASS', duration_ms: Math.round(performance.now() - start) });
  } catch (error) {
    results.push({ name, verdict: 'FAIL', duration_ms: Math.round(performance.now() - start), code: error.code || null,
      error: error.message, detail: error.detail || null, context: error.where || null,
      active_locks: (await control.query(`select pid,wait_event_type,wait_event,pg_blocking_pids(pid) blockers from pg_stat_activity
        where datname=$1 and state<>'idle' order by pid`, [db])).rows });
  } finally {
    await Promise.all([...connections].filter(client => !openedBefore.has(client)).map(close));
    await control.query(`drop database if exists ${db}`).catch(() => {});
  }
  console.log(JSON.stringify(results.at(-1)));
}

try {
  await mkdir(join(root, '.tmp'), { recursive: true });
  // Fresh cluster is kept OUTSIDE the downloaded npm tooling tree.
  cluster = await mkdtemp(join(root, '.tmp/native-pg-cluster-'));
  const passwordFile = join(cluster, 'local-password');
  await writeFile(passwordFile, password, { mode: 0o600 });
  const server = createServer();
  await new Promise((resolvePort, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePort); });
  port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  console.log('Starting isolated loopback PostgreSQL; all fixture data is synthetic.');
  await exec(executable('initdb'), ['-D', join(cluster, 'data'), '--username=postgres', '--auth=scram-sha-256', `--pwfile=${passwordFile}`, '--encoding=UTF8', '--locale=C', '--no-sync'], { cwd: root, env, timeout: 120000 });
  await rm(passwordFile);
  await exec(executable('pg_ctl'), ['-D', join(cluster, 'data'), '-l', join(cluster, 'postgres.log'), '-o',
    `-p ${port} -c listen_addresses=127.0.0.1 -c max_connections=40 -c wal_level=logical -c deadlock_timeout=300ms -c log_lock_waits=on`, '-w', '-t', '30', 'start'], { cwd: root, env, timeout: 40000 });
  serverStarted = true;
  control = await connect('postgres', 'postgres');
  version = await value(control, 'select version() v');
  console.log(version);
  await control.query('create database reelradar_fixture');
  template = await connect('reelradar_fixture', 'postgres');
  await template.query(fixtureSql);
  for (const migration of migrations) {
    // pg_cron and pg_net are unavailable locally and have inert fixture functions.
    // Nothing else is stripped or rewritten, including publication and triggers.
    const sql = migration.sql.replace(/^create extension if not exists (pg_cron|pg_net) with schema [a-z_]+;\s*/gmu, '');
    try { await template.query(sql); }
    catch (error) { throw new Error(`Actual migration ${migration.name} failed: ${error.message}`, { cause: error }); }
  }
  await template.query('insert into auth.users values($1),($2)', [owner, stranger]);
  await identity(template); await rpc(template, 'provision_owner', [owner]);
  await identity(template, 'authenticated');
  const workspace = (await rpc(template, 'create_workspace', ['Backend feature fixtures'])).id;
  const creator = (await rpc(template, 'add_creator', [workspace, 'backend_fixture'])).id;
  fixture = { workspace, creator };
  await identity(template, 'postgres');
  await template.query("update public.creators set status='active'; update public.scrape_jobs set status='failed',actual_cost_usd=0,completed_at=now(),live=false,reserved_usd=0");
  await template.query(`update public.app_settings set scraping_enabled=true,paused=false,initial_backfill_enabled=true,monthly_budget_usd=50,
    provider_account_id='fixture',provider_usage_checked_at=clock_timestamp(),provider_cycle_start_at=$1,provider_cycle_end_at=$2,
    provider_cycle_usage_usd=0,provider_cycle_limit_usd=50`, cycle);
  await identity(template);
  for (let slot = 1; slot <= 5; slot++) {
    await rpc(template, 'worker_configure_apify_account', [owner, slot, slot === 1 ? 'fixture' : `account-${slot}`, true, true]);
    await persistUsage(template, await beginUsage(template, slot), 0, 50, slot);
  }
  await close(template); template = null;
  console.log(`Loaded ${migrations.length} actual migrations; SHA256 ${digest}`);

  await test('creator and job signal commits preserve family union without lock inversion', async ({ db, client }) => {
    const [jobId] = await seed(client, 1);
    const creatorWriter = await connect(db, 'postgres'), jobWriter = await connect(db, 'postgres'), gate = await connect(db, 'postgres');
    const before = await value(client, "select jsonb_object_agg(family,revision) v from public.owner_resource_revisions where scope_key='global'");
    await creatorWriter.query('begin');
    await creatorWriter.query("update public.creators set display_name='Synthetic concurrent creator' where id=$1", [fixture.creator]);
    await jobWriter.query('begin');
    await jobWriter.query("update public.scrape_jobs set reconciliation_next_at=clock_timestamp()+interval '1 second' where id=$1", [jobId]);
    // Previously A held creator families/global; B held jobs family and waited
    // global; A's following job-creator update produced native 40P01. Sources
    // must now complete without signal-row locks; commits acquire global first.
    await creatorWriter.query('update public.scrape_job_creators set result_count=result_count+1 where job_id=$1', [jobId]);
    await gate.query('begin'); await gate.query('select 1 from public.owner_revisions for update');
    const commits = [tracked(creatorWriter.query('commit')), tracked(jobWriter.query('commit'))];
    await waitBlocked('creator-job-deferred-commits', [creatorWriter.pid, jobWriter.pid]);
    await gate.query('commit'); for (const commit of commits) await checked(commit);
    const after = await value(client, "select jsonb_object_agg(family,revision) v from public.owner_resource_revisions where scope_key='global'");
    for (const family of ['creators', 'reels', 'carousels']) assert.equal(after[family], before[family] + 1);
    assert.equal(after.jobs, before.jobs + 2);
  });
  await test('submission authorization race permits one fresh winner and no replay', async ({ db, client }) => {
    await configure(client, 3); await seed(client, 2);
    const lease = await executor(client, false), claim = await next(client, lease);
    assert.ok(claim.job); assert.equal(claim.job.dispatch_phase, 'prepared');
    const args = [owner, claim.job.id, claim.job.dispatch_nonce, 'ab'.repeat(32), lease.executor_nonce, lease.claimed_revision];
    const outcomes = await wave(db, 'submission-authorize-once', session => rpc(session, 'worker_authorize_collection_submit', args));
    assert.equal(outcomes.filter(outcome => outcome.authorized === true).length, 1);
    assert.ok(outcomes.filter(outcome => !outcome.authorized).every(outcome => outcome.reason === 'intent_not_fresh'));
    assert.equal((await rpc(client, 'worker_authorize_collection_submit', args)).authorized, false);
    const stored = await value(client, 'select to_jsonb(j) v from public.scrape_jobs j where id=$1', [claim.job.id]);
    assert.equal(stored.dispatch_phase, 'submission_authorized'); assert.equal(stored.input_digest, 'ab'.repeat(32));
    assert.equal(stored.reserved_usd, .1); assert.equal(stored.actual_cost_usd, null);
  });
  await test('validation permit limits gated contention to one pinned job and one authorization', async ({ db, client }) => {
    await configure(client, 3); await identity(client, 'postgres'); const ids = await seed(client, 3, 'profile'); await identity(client);
    await rpc(client, 'worker_set_collection_start_gate', [owner, true]);
    await rpc(client, 'worker_allow_collection_validation', [owner, ids[0], fixture.creator, randomUUID(), 'Synthetic approved single-job validation']);
    const lease = await executor(client, false);
    const outcomes = await wave(db, 'validation-one-pinned-claim', session => next(session, lease));
    const jobs = outcomes.flatMap(outcome => outcome.job ? [outcome.job] : []);
    assert.equal(jobs.length, 1); assert.equal(jobs[0].id, ids[0]); assert.equal(jobs[0].reserved_usd, .1);
    const args = [owner, jobs[0].id, jobs[0].dispatch_nonce, 'ef'.repeat(32), lease.executor_nonce, lease.claimed_revision];
    const authorized = await wave(db, 'validation-one-submit-winner', session => rpc(session, 'worker_authorize_collection_submit', args));
    assert.equal(authorized.filter(result => result.authorized).length, 1);
    assert.equal(await value(client, 'select paid_starts_gated v from public.collection_worker_settings where owner_user_id=$1', [owner]), true);
    assert.equal(await value(client, "select count(*)::int v from public.scrape_jobs where id=any($1::uuid[]) and status='pending'", [ids.slice(1)]), 2);
  });
  await test('charge observation contention retains the largest reported charge without billing wakes', async ({ db, client }) => {
    await configure(client, 3); await seed(client, 1);
    const lease = await executor(client, false), claim = await next(client, lease), job = claim.job;
    await rpc(client, 'worker_authorize_collection_submit', [owner, job.id, job.dispatch_nonce, 'ab'.repeat(32), lease.executor_nonce, lease.claimed_revision]);
    await rpc(client, 'worker_attach_run', [job.id, job.dispatch_nonce, 'charge-native-run', 'fixture-actor', 'fixture', 'dataset']);
    await rpc(client, 'worker_reconcile_run', [job.id, 'charge-native-run', 'fixture-actor', 'fixture', 'SUCCEEDED', 'dataset', null]);
    const before = await runtime(client);
    await wave(db, 'charge-observation-monotonic', (session, index) => rpc(session, 'worker_reconcile_run_billing_only',
      [job.id, 'charge-native-run', 'fixture-actor', 'fixture', 'SUCCEEDED', 'dataset', (index + 1) / 100]));
    assert.equal(await value(client, 'select actual_cost_usd::float8 v from public.scrape_jobs where id=$1', [job.id]), .08);
    assert.equal((await runtime(client)).wake_revision, before.wake_revision);
  });
  await test('submission cancellation race prevents a delayed start without fabricating unknown billing', async ({ db, client }) => {
    await configure(client, 3); await seed(client, 1);
    const lease = await executor(client, false), claim = await next(client, lease), job = claim.job;
    assert.ok(job);
    const authorize = [owner, job.id, job.dispatch_nonce, 'cd'.repeat(32), lease.executor_nonce, lease.claimed_revision];
    const outcomes = await wave(db, 'submission-cancel-versus-authorize', (session, index) => index % 2
      ? rpc(session, 'worker_authorize_collection_submit', authorize)
      : rpc(session, 'worker_cancel_pre_submit', [owner, job.id, job.dispatch_nonce, 'Synthetic local cancellation before authorization']));
    const stored = await value(client, 'select to_jsonb(j) v from public.scrape_jobs j where id=$1', [job.id]);
    if (stored.dispatch_phase === 'cancelled_before_submit') {
      assert.equal(outcomes.filter(outcome => outcome.authorized).length, 0);
      assert.equal(stored.reserved_usd, 0); assert.equal(stored.actual_cost_usd, 0);
    } else {
      assert.equal(stored.dispatch_phase, 'submission_authorized');
      assert.equal(outcomes.filter(outcome => outcome.authorized).length, 1);
      assert.ok(outcomes.every(outcome => !outcome.cancelled));
      assert.equal(stored.reserved_usd, .1); assert.equal(stored.actual_cost_usd, null);
    }
    assert.equal(stored.attempt_count, 1);
  });
  await test('submission uncommitted authorization recovery fences eight delayed executors', async ({ db, client }) => {
    await configure(client, 3); await seed(client, 1);
    const lease = await executor(client, false), { job } = await next(client, lease);
    await client.query("update public.scrape_jobs set status='uncertain',dispatch_phase='request_unknown',missing_run_recovery_exhausted=true where id=$1", [job.id]);
    const args = [owner, job.id, job.dispatch_nonce, 'ab'.repeat(32), lease.executor_nonce, lease.claimed_revision];
    const outcomes = await wave(db, 'submission-uncommitted-recovery', (session, index) => index % 2
      ? rpc(session, 'worker_authorize_collection_submit', args)
      : rpc(session, 'worker_cancel_pre_submit', [owner, job.id, job.dispatch_nonce, 'Synthetic durable no-authorization proof']));
    assert.equal(outcomes.filter(outcome => outcome.authorized).length, 0);
    const stored = await value(client, 'select to_jsonb(j) v from public.scrape_jobs j where id=$1', [job.id]);
    assert.equal(stored.dispatch_phase, 'cancelled_before_submit');
    assert.equal(stored.reserved_usd, 0); assert.equal(stored.actual_cost_usd, 0);
    assert.equal(stored.dispatch_authorized_at, null); assert.equal(stored.attempt_count, 1);
  });
  await test('submission gate fences every queued claim and fresh authorization', async ({ db, client }) => {
    await configure(client, 3); await seed(client, 3);
    const lease = await executor(client, false), claim = await next(client, lease);
    await rpc(client, 'worker_set_collection_start_gate', [owner, true]);
    const outcomes = await wave(db, 'submission-gate-active', session => next(session));
    assert.ok(outcomes.every(outcome => !outcome.job && ['paid_starts_gated', 'executor_busy'].includes(outcome.reason)));
    assert.deepEqual(await rpc(client, 'worker_authorize_collection_submit', [owner, claim.job.id, claim.job.dispatch_nonce, 'ef'.repeat(32), lease.executor_nonce, lease.claimed_revision]), { authorized: false, reason: 'paid_starts_gated' });
    assert.equal((await runtime(client)).paid_starts_gated, true);
    const stored = await value(client, 'select to_jsonb(j) v from public.scrape_jobs j where id=$1', [claim.job.id]);
    assert.equal(stored.dispatch_phase, 'prepared'); assert.equal(stored.actual_cost_usd, null);
  });
  await test('submission risk release races exact replay and late callback safely', async ({ db, client }) => {
    await configure(client, 3);
    const [id] = await seed(client, 1, 'daily');
    await identity(client, 'postgres');
    await client.query("update public.scrape_jobs set status='dispatching',live=true,collection_source='ordinary',apify_account_slot=1,expected_actor_id='fixture-actor',expected_provider_user_id='fixture',dispatch_nonce=gen_random_uuid(),attempt_count=1,started_at=clock_timestamp()-interval '2 days',reserved_usd=.907554 where id=$1", [id]);
    await client.query("update public.scrape_jobs set status='uncertain',lease_token=null,lease_expires_at=null where id=$1", [id]);
    await identity(client);
    await rpc(client, 'worker_set_collection_start_gate', [owner, true]);
    const stored = await value(client, 'select to_jsonb(j) v from public.scrape_jobs j where id=$1', [id]);
    const expected = [{ job_id: stored.id, expected_version: stored.recovery_version, dispatch_nonce: stored.dispatch_nonce, started_at: stored.started_at }];
    const args = [owner, [stored.id], 'local-submission-risk-release', 'Synthetic explicit acceptance of unresolved liability', 'local-native-test', JSON.stringify(expected)];
    const outcomes = await wave(db, 'submission-risk-release-replay', session => rpc(session, 'worker_risk_release_collection_jobs', args));
    assert.equal(outcomes.filter(outcome => outcome.replayed === false).length, 1);
    const released = await value(client, 'select to_jsonb(j) v from public.scrape_jobs j where id=$1', [stored.id]);
    assert.equal(released.reserved_usd, 0); assert.equal(released.actual_cost_usd, null); assert.equal(released.billing_reconciled_at, null);
    assert.equal(released.operational_disposition, 'risk_released'); assert.equal(released.collection_source, 'operator_settle');
    assert.equal((await runtime(client)).wake_revision, 0);
    const callbackClients = await Promise.all(Array.from({ length: 8 }, () => connect(db)));
    const callbackGate = await connect(db, 'postgres');
    await callbackGate.query('begin');
    await callbackGate.query('select id from public.scrape_jobs where id=$1 for update', [stored.id]);
    const tasks = callbackClients.map(session => tracked(transaction(session, () => rpc(session, 'worker_record_callback_receipt', [owner, stored.id, stored.dispatch_nonce, 'late-native-run', 'fixture-actor', 'fixture']))));
    await waitBlocked('submission-risk-late-callback', callbackClients.map(session => session.pid));
    await callbackGate.query('commit');
    const callbacks = await Promise.all(tasks.map(checked));
    for (const session of callbackClients) await close(session);
    await close(callbackGate);
    assert.ok(callbacks.every(outcome => outcome.accepted));
    await rpc(client, 'worker_record_accepted_evidence', [owner, stored.id, stored.dispatch_nonce, 'late-native-run', 'callback', true]);
    await rpc(client, 'worker_attach_run', [stored.id, stored.dispatch_nonce, 'late-native-run', 'fixture-actor', 'fixture', 'dataset']);
    const discovered = await value(client, 'select to_jsonb(j) v from public.scrape_jobs j where id=$1', [stored.id]);
    assert.equal(discovered.status, 'running'); assert.equal(discovered.actual_cost_usd, null); assert.equal(discovered.operational_disposition, 'risk_released');
  });
  for (const max of [3, 4]) for (const legacy of [false, true]) {
    await test(`simultaneous ${legacy ? 'legacy' : 'fair'} reservations max${max}`, async ({ db, client }) => {
      await configure(client, max); await seed(client);
      const claims = await wave(db, `reservation-max${max}-${legacy}`, session => legacy
        ? rpc(session, 'worker_claim_dispatch', [owner, true, 'fixture-actor', 'daily']) : next(session));
      const jobs = claims.flatMap(claim => claim.job ? [claim.job] : []);
      assert.equal(jobs.length, max); assert.equal(new Set(jobs.map(job => job.id)).size, max);
      assert.equal(new Set(jobs.map(job => job.apify_account_slot)).size, max);
      assert.ok(claims.filter(claim => !claim.job).every(claim => claim.reason === 'concurrency_limit'));
      assert.ok(jobs.every(job => job.actual_cost_usd === null && job.collection_source === 'ordinary'));
      const state = await invariants(client, max, 50);
      assert.ok(Math.abs(state.hold - max * .1) < 0.000001); assert.equal(state.unknown_costs, max);
    });
  }
  await test('uncertain primary .907554 hold survives competing max4 reservations', async ({ db, client }) => {
    await configure(client, 4); const old = await processing(client, 'daily', 1, null, 0.907554);
    await client.query("update public.scrape_jobs set status='uncertain',provider_terminal_status=null where id=$1", [old.id]);
    await rpc(client, 'worker_invalidate_account_usage', [owner, 1]);
    await seed(client);
    const claims = await wave(db, 'uncertain-hold', session => next(session));
    assert.equal(claims.filter(claim => claim.job).length, 3);
    assert.deepEqual(claims.flatMap(claim => claim.job ? [claim.job.apify_account_slot] : []).sort(), [2, 3, 4]);
    assert.deepEqual(await value(client, "select jsonb_build_object('hold',reserved_usd,'cost',actual_cost_usd,'status',status) v from public.scrape_jobs where id=$1", [old.id]),
      { hold: 0.907554, cost: null, status: 'uncertain' });
    const state = await invariants(client, 4, 50); assert.ok(Math.abs(state.hold - (0.907554 + 3 * .1)) < 0.000001);
  });
  await test('owner and per-account budgets retain settled cost during concurrent reservations', async ({ db, client }) => {
    await configure(client, 4, 0.9); const old = await processing(client, 'daily', 1, 0.4, 0);
    await identity(client); await finish(client, old);
    for (let slot = 1; slot <= 5; slot++) await persistUsage(client, await beginUsage(client, slot), 0, slot === 1 ? 0.6 : 0.3, slot);
    await seed(client);
    await wave(db, 'monetary-ceilings', session => next(session));
    const state = await invariants(client, 4, 0.9); assert.equal(state.cost, 0.4); assert.ok(state.hold > 0);
  });
  await test('uncommitted reservation blocks another session; rollback releases no accepted hold', async ({ db, client }) => {
    await configure(client, 3); await seed(client);
    const first = await connect(db), second = await connect(db);
    await first.query('begin'); const uncommitted = await next(first);
    assert.ok(uncommitted.job);
    const contender = tracked(transaction(second, () => next(second)));
    await waitBlocked('rollback-reservation', [second.pid], first.pid);
    assert.equal(await value(client, 'select count(*)::int v from public.scrape_jobs where live'), 0);
    await first.query('rollback'); const committed = await checked(contender);
    assert.equal(committed.job.id, uncommitted.job.id); assert.equal(committed.job.attempt_count, 1);
    assert.equal(await value(client, 'select count(*)::int v from public.scrape_jobs where live'), 1);
    await invariants(client, 3, 50);
  });
  await test('simultaneous finishes and duplicate callbacks coalesce revisions; executor/start cap is exclusive', async ({ db, client }) => {
    await configure(client, 3); const jobs = [];
    for (let slot = 1; slot <= 4; slot++) jobs.push(await processing(client, 'daily', slot));
    const sessions = await Promise.all(jobs.map(() => connect(db)));
    const gate = await connect(db, 'postgres');
    await gate.query('begin'); await gate.query('select 1 from public.collection_worker_settings for update');
    const finishing = sessions.map((session, i) => tracked(transaction(session, () => finish(session, jobs[i]))));
    await waitBlocked('simultaneous-finishes', sessions.map(session => session.pid));
    await gate.query('commit'); for (const task of finishing) await checked(task);
    await identity(client); assert.equal((await runtime(client)).wake_revision, 4);
    await wave(db, 'duplicate-callbacks', (session, i) => rpc(session, 'worker_record_completion_wake', [owner, jobs[i % 4].id]).catch(error => { throw error; }));
    assert.equal((await runtime(client)).wake_revision, 4);
    const leases = await wave(db, 'executor-contenders', session => executor(session));
    const winners = leases.filter(lease => lease.executor_nonce); assert.equal(winners.length, 1);
    assert.equal(leases.filter(lease => lease.reason === 'executor_busy').length, 7);
    await seed(client);
    const claims = await wave(db, 'lease-start-contenders', session => next(session, winners[0]));
    assert.equal(claims.filter(claim => claim.job).length, 3);
    assert.equal(claims.filter(claim => claim.reason === 'wake_start_limit').length, 5);
    assert.equal((await runtime(client)).executor_starts, 3);
    assert.equal(await drain(client, winners[0]), true); assert.equal(await drain(client, winners[0]), false);
  });
  await test('later committed completion survives a concurrently blocked older drain', async ({ db, client }) => {
    const oldJob = await processing(client, 'daily', 1), laterJob = await processing(client, 'daily', 2);
    await identity(client); await finish(client, oldJob); const lease = await executor(client);
    const finisher = await connect(db), drainer = await connect(db);
    await finisher.query('begin'); await finish(finisher, laterJob);
    const draining = tracked(transaction(drainer, () => drain(drainer, lease)));
    await waitBlocked('completion-vs-drain', [drainer.pid], finisher.pid);
    await finisher.query('commit'); assert.equal(await checked(draining), true);
    const state = await runtime(client); assert.equal(state.wake_revision, 2); assert.equal(state.drained_revision, 1); assert.equal(state.wake_pending, true);
    const newLease = await executor(client); assert.equal(newLease.claimed_revision, 2);
  });
  await test('expired executor contenders retain starts and fence stale nonce', async ({ db, client }) => {
    await configure(client, 3); await seed(client);
    await identity(client, 'postgres');
    await client.query('update public.collection_worker_settings set wake_revision=1');
    await identity(client); const old = await executor(client); assert.ok((await next(client, old)).job);
    await identity(client, 'postgres'); await client.query("update public.collection_worker_settings set executor_expires_at=clock_timestamp()-interval '1 second'");
    await identity(client); const leases = await wave(db, 'expired-lease-recovery', session => executor(session));
    const recovered = leases.filter(lease => lease.executor_nonce); assert.equal(recovered.length, 1); assert.equal(recovered[0].starts_remaining, 2);
    assert.notEqual(recovered[0].executor_nonce, old.executor_nonce);
    assert.deepEqual(await next(client, old), { reason: 'executor_lease_lost' }); assert.equal(await drain(client, old), false);
    assert.equal(await rpc(client, 'worker_release_collection_executor', [owner, old.executor_nonce, old.claimed_revision]), false);
    assert.equal(await rpc(client, 'worker_renew_collection_executor', [owner, old.executor_nonce, old.claimed_revision]), false);
    const claims = await wave(db, 'recovered-start-cap', session => next(session, recovered[0]));
    assert.equal(claims.filter(claim => claim.job).length, 2); assert.equal((await runtime(client)).executor_starts, 3);
    await invariants(client, 3, 50);
  });
  await test('new request barrier rejects delayed older usage persistence and replay across sessions', async ({ db, client }) => {
    await identity(client); const old = await beginUsage(client);
    const newerClient = await connect(db), olderClient = await connect(db);
    await newerClient.query('begin'); const latest = await beginUsage(newerClient);
    const delayed = tracked(transaction(olderClient, () => persistUsage(olderClient, old, 0, 500)));
    await waitBlocked('usage-observation-barrier', [olderClient.pid], newerClient.pid);
    await newerClient.query('commit'); await checked(delayed);
    await persistUsage(client, latest, 4, 5);
    const before = await rpc(client, 'worker_accounts', [owner]);
    await wave(db, 'usage-replays', session => persistUsage(session, old, 0, 500));
    await persistUsage(client, latest, 0, 500); await persistUsage(client, null, 0, 500);
    assert.deepEqual(await rpc(client, 'worker_accounts', [owner]), before);
  });
  await test('settlement after observation start survives delayed usage and old transaction now()', async ({ db, client }) => {
    const job = await processing(client, 'daily', 1, null, 5);
    await identity(client); const observer = await connect(db), settler = await connect(db);
    await observer.query('begin'); const transactionStart = await value(observer, 'select now()::text v');
    const observation = await beginUsage(settler); await sleep(15); await reconcile(settler, job, 5); await finish(settler, job);
    await persistUsage(observer, observation, 0, 5); await observer.query('commit');
    assert.equal(await value(client, 'select billing_reconciled_at>$2::timestamptz v from public.scrape_jobs where id=$1', [job.id, observation.observed_at]), true);
    assert.equal(await value(client, 'select billing_reconciled_at>$2::timestamptz v from public.scrape_jobs where id=$1', [job.id, transactionStart]), true);
    await identity(client, 'authenticated'); const status = await rpc(client, 'get_apify_account_status'); assert.equal(status.accounts[0].reason, 'allowance_exhausted');
  });
  await test('settled-before-request charge is retained despite provider usage lag', async ({ client }) => {
    const job = await processing(client, 'daily', 1, null, 5);
    await identity(client); await reconcile(client, job, 5); await finish(client, job);
    await persistUsage(client, await beginUsage(client), 0, 5);
    await identity(client, 'authenticated'); const status = await rpc(client, 'get_apify_account_status'); assert.equal(status.accounts[0].reason, 'allowance_exhausted');
  });
  await test('unprivileged and foreign-owner sessions cannot use lease/checkpoint or private tables', async ({ db, client }) => {
    for (const role of ['anon', 'authenticated']) {
      const session = await connect(db, role);
      await assert.rejects(() => executor(session), error => error.code === '42501');
      await assert.rejects(() => beginUsage(session), error => error.code === '42501');
      await assert.rejects(() => session.query('select * from apify_accounts_private.usage_checkpoints'), error => error.code === '42501');
    }
    await identity(client); const lease = await executor(client, false);
    assert.equal(await rpc(client, 'worker_drain_completion_wake', [stranger, lease.claimed_revision, lease.executor_nonce]), false);
    await assert.rejects(() => rpc(client, 'worker_begin_account_usage', [stranger, 1, 'fixture']), error => error.code === '42501');
  });
  await test('finishing carousel job-to-wake-to-signal order versus fair selector signal-to-wake', async ({ db, client }) => {
    await configure(client, 4); const job = await processing(client, 'carousel'); await seed(client);
    const finisher = await connect(db, 'postgres'), selector = await connect(db);
    // Exact carousel completion prefix: job lock, completion trigger wake lock,
    // then owner signal. Selector writes the job signal before its fairness row.
    await finisher.query('begin');
    await finisher.query('select 1 from public.scrape_jobs where id=$1 for update', [job.id]);
    await finisher.query('select 1 from public.collection_worker_settings for update');
    await identity(finisher);
    const selecting = tracked(transaction(selector, () => next(selector)));
    await waitBlocked('carousel-finish-vs-selector', [selector.pid], finisher.pid);
    const finishing = tracked((async () => { const result = await finish(finisher, job); await finisher.query('commit'); return result; })());
    const outcomes = await Promise.all([selecting, finishing]);
    for (const outcome of outcomes) if (!outcome.ok) throw outcome.error;
  });
  await test('ingestion transcription-first order serializes selector and reconciliation without deadlock', async ({ db, client }) => {
    await configure(client, 4); const job = await processing(client); await seed(client);
    await identity(client, 'postgres');
    await client.query('update public.scrape_jobs set dataset_finished=false where id=$1', [job.id]);
    await identity(client);
    const ingestion = await connect(db, 'postgres'), selector = await connect(db), settlement = await connect(db);
    await ingestion.query('begin');
    // This is the NEW genuine first lock. Never force obsolete job-first locks
    // after the public entrypoint has been corrected by the forward migration.
    const definition = await value(client, "select pg_get_functiondef('public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb)'::regprocedure) v");
    assert.ok(definition.indexOf('public.transcription_settings') < definition.indexOf('from public.scrape_jobs'));
    await ingestion.query('select 1 from public.transcription_settings where singleton for update');
    await identity(ingestion);
    const selecting = tracked(transaction(selector, () => next(selector)));
    await waitBlocked('selector-vs-ingestion-transcription', [selector.pid], ingestion.pid);
    // Reconcile does not need transcription and can commit while ingestion owns
    // the first lock. The old three-way schedule no longer acquires a job lock
    // before waiting for transcription, so it cannot close the demonstrated cycle.
    await transaction(settlement, () => reconcile(settlement, job));
    assert.equal((await ingest(ingestion, job)).accepted, 1);
    await ingestion.query('commit'); assert.ok((await checked(selecting)).job);
    assert.equal(await value(client, 'select dataset_cursor::int v from public.scrape_jobs where id=$1', [job.id]), 1);
    assert.equal(await value(client, "select count(*)::int v from public.reels where shortcode=$1", [`NATIVE_${job.id.replaceAll('-', '')}`]), 1);
    assert.equal(await value(client, 'select count(*)::int v from public.reel_fetch_observations where job_id=$1', [job.id]), 1);
  });
  await test('checkpoint transaction serializes finishing foreign-key locks without deadlock', async ({ db, client }) => {
    const job = await processing(client); const observation = await beginUsage(client);
    const usage = await connect(db), finisher = await connect(db);
    await usage.query('begin'); await persistUsage(usage, observation, 0, 50);
    // Updating a job's completion flags also checks the app_settings FK. A usage
    // RPC holds app_settings FOR UPDATE; finish correctly waits for that commit.
    const finishing = tracked(transaction(finisher, () => finish(finisher, job)));
    await waitBlocked('checkpoint-finish-fk-serialization', [finisher.pid], usage.pid);
    await usage.query('commit'); await checked(finishing);
    assert.equal((await runtime(client)).wake_revision, 1);
  });
} catch (error) {
  results.push({ name: 'native PostgreSQL bootstrap/migrations', verdict: 'FAIL', duration_ms: Math.round(performance.now() - started),
    error: error.message, code: error.cause?.code || error.code || null });
  console.error(error.message);
} finally {
  await Promise.all([...connections].map(close));
  let serverStopped = !serverStarted;
  if (serverStarted) try {
    await exec(executable('pg_ctl'), ['-D', join(cluster, 'data'), '-m', 'fast', '-w', '-t', '30', 'stop'], { cwd: root, env, timeout: 40000 });
    serverStopped = true;
  } catch (error) { results.push({ name: 'local PostgreSQL shutdown', verdict: 'FAIL', error: error.message }); }
  if (cluster && serverStopped && process.env.REELRADAR_KEEP_NATIVE_PG !== '1') {
    const target = resolve(cluster);
    assert(target.startsWith(resolve(root, '.tmp') + sep) && basename(target).startsWith('native-pg-cluster-'), 'Cleanup target must be an isolated workspace test cluster');
    // Windows scanners may briefly hold postgres.log after successful shutdown.
    // Retry filesystem cleanup only; database operations are never retried.
    await rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }).catch(error => {
      results.push({ name: 'local cluster cleanup', verdict: 'FAIL', error: error.message });
    });
  }
  const stable = migrationDigest() === digest && readFileSync(join(root, 'tests/support/feature-database.ts'), 'utf8') === fixtureSource;
  if (!stable) results.push({ name: 'migration/fixture stability', verdict: 'FAIL', error: 'Sources changed during execution; rerun against stable source files' });
  const failures = results.filter(result => result.verdict === 'FAIL');
  console.log(JSON.stringify({ verdict: failures.length ? 'FAIL' : 'PASS', postgres_version: version || null,
    migration_count: migrations.length, migration_sha256: digest, sources_stable: stable, distinct_session_contention_barriers: barriers,
    tests: results, duration_ms: Math.round(performance.now() - started),
    limitations: ['Local native PostgreSQL only; no hosted rollout or load/SLA claim.', 'Auth/vault/cron/net use existing synthetic fixture scaffolding; no real Supabase extensions or networking.',
      'Lock-prefix schedules make dangerous interleavings reproducible; no deadlock retries or triggers disabled.', 'Synthetic provider amounts are assertions, not authoritative billing evidence.'] }, null, 2));
  process.exitCode = failures.length ? 1 : 0;
}

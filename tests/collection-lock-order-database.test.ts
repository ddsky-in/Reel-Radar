import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { featureDatabase, fixtureOwner } from './support/feature-database';

let f: Awaited<ReturnType<typeof featureDatabase>>;
const signature = 'public.worker_ingest_page(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb)';
beforeAll(async () => { f = await featureDatabase(); }, 90000);
afterAll(async () => { await f?.db.close(); });

// Serial contract/authorization checks only. The genuine three-session 40P01
// regression and native server lock barriers live in scripts/local-pg-concurrency.mjs.
describe('forward ingestion transcription-first entrypoint', () => {
  it('changes only the public ingestion prefix and retains inherited private bodies and grants', async () => {
    const def = await f.value<string>('select pg_get_functiondef($1::regprocedure) v', [signature]);
    const prefix = def.indexOf('collection_lock_order_v1');
    const transcription = def.indexOf('public.transcription_settings', prefix);
    const job = def.indexOf('from public.scrape_jobs', prefix);
    expect(prefix).toBeGreaterThan(0); expect(transcription).toBeGreaterThan(prefix); expect(job).toBeGreaterThan(transcription);
    expect(def).toContain('SECURITY DEFINER'); expect(def).toContain('worker_ingest_page_pre_carousels');
    const functions = await f.value<string[]>(`select array_agg(pg_get_functiondef(oid)) v from pg_proc where oid=any(array[
      'public.worker_reconcile_run(uuid,text,text,text,text,text,numeric)'::regprocedure,
      'public.worker_finish_processing(uuid,uuid)'::regprocedure])`);
    for (const body of functions) expect(body).not.toContain('collection_lock_order_v1');
    for (const role of ['anon', 'authenticated']) expect(await f.value('select has_function_privilege($1,$2,\'execute\') v', [role, signature])).toBe(false);
    expect(await f.value('select has_function_privilege(\'service_role\',$1,\'execute\') v', [signature])).toBe(true);
    expect(await f.value(`select has_function_privilege('service_role','public.worker_ingest_page_pre_carousels(uuid,uuid,integer,jsonb,jsonb,integer,boolean,jsonb)','execute') v`)).toBe(false);
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/202611150006_collection_lock_order.sql'), 'utf8');
    expect(sql).not.toMatch(/cron\.|net\.|vault\.|set reserved_usd|actual_cost_usd\s*=|grant execute/i);
  });
  it('preserves authenticated denial and the existing leased-page/cost invariants', async () => {
    await f.identity(); await f.db.exec('begin');
    try {
      const job = await f.value<{ id: string; lease_token: string }>(`insert into public.scrape_jobs(owner_user_id,kind,status,requested_profiles_count,results_limit,
        lease_token,lease_expires_at,result_fetched_at,provider_terminal_status)
        values($1,'daily','processing',1,30,gen_random_uuid(),now()+interval '5 minutes',now(),'SUCCEEDED')
        returning jsonb_build_object('id',id,'lease_token',lease_token) v`, [fixtureOwner]);
      await f.db.query('insert into public.scrape_job_creators(job_id,creator_id) values($1,$2)', [job.id, f.creator]);
      await f.identity('authenticated'); await f.db.exec('savepoint denied');
      await expect(f.rpc('worker_ingest_page', [job.id, job.lease_token, 0, '[]', '[]', 1, true, '{}'])).rejects.toThrow('permission denied');
      await f.db.exec('rollback to savepoint denied; release savepoint denied');
      await f.identity('service_role');
      const record = { creator_id: f.creator, username: 'backend_fixture', shortcode: 'LOCK_ORDER_LOCAL', reel_url: 'https://www.instagram.com/reel/LOCK_ORDER_LOCAL/',
        fetched_at: new Date().toISOString(), published_at: '2026-01-01T00:00:00Z', views: 10, likes: 1, comments: 0,
        views_state: 'known', likes_state: 'known', comments_state: 'known', provider: 'fixture', media_candidates: [], has_audio: false };
      const args = [job.id, job.lease_token, 0, JSON.stringify([record]), '[]', 1, true, JSON.stringify({ [f.creator]: 1 })];
      expect(await f.rpc('worker_ingest_page', args)).toMatchObject({ accepted: 1, duplicate: false });
      expect(await f.rpc('worker_ingest_page', args)).toMatchObject({ duplicate: true });
      expect(await f.value("select jsonb_build_object('cost',actual_cost_usd,'hold',reserved_usd,'cursor',dataset_cursor) v from public.scrape_jobs where id=$1", [job.id]))
        .toEqual({ cost: null, hold: 0, cursor: 1 });
    } finally { await f.db.exec('rollback'); await f.identity(); }
  });
});

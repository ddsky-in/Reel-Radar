import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { featureDatabase, fixtureOwner } from './support/feature-database';

const name = '20261116152357_reduce_database_background_load.sql';
const migration = readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
let f: Awaited<ReturnType<typeof featureDatabase>>;
beforeAll(async () => { f = await featureDatabase({ excludeMigrations: [name] }); }, 60_000);
afterAll(async () => { await f?.db.close(); });
beforeEach(async () => { await f.identity(); await f.db.exec('begin'); });
afterEach(async () => { await f.db.exec('rollback; reset role'); });

describe('bounded database background work', () => {
  it('does not install any schedules or make network requests on a fresh database', async () => {
    await f.db.exec(migration);
    expect(await f.value('select count(*)::int v from cron.job')).toBe(0);
    expect(await f.value('select count(*)::int v from net.requests')).toBe(0);
  });
  it.each([true, false])('stages only the already-enabled competitor maintenance schedule: enabled=%s', async enabled => {
    await f.db.query("insert into cron.job(jobname,schedule,command,active) values('reelradar-competitor-maintenance','*/5 * * * *','select 1',$1),('reelradar-transcription-maintenance','*/5 * * * *','select 2',true)", [enabled]);
    const before = (await f.db.query('select jobid,jobname,command,active from cron.job order by jobid')).rows;
    await f.db.exec(migration);
    expect((await f.db.query('select jobid,jobname,command,active from cron.job order by jobid')).rows).toEqual(before);
    expect(await f.value("select schedule v from cron.job where jobname='reelradar-competitor-maintenance'")).toBe(enabled ? '2-59/5 * * * *' : '*/5 * * * *');
    expect(await f.value("select schedule v from cron.job where jobname='reelradar-transcription-maintenance'")).toBe('*/5 * * * *');
  });
  it('preserves requested-only, due-time and retry-limit eligibility while ignoring historical jobs', async () => {
    await f.activate();
    const due = await f.reel(false), unrequested = await f.reel(false), delayed = await f.reel(false), exhausted = await f.reel(false);
    await f.identity();
    await f.db.query('update public.transcript_jobs set priority_requested_at=null where reel_id=$1', [unrequested]);
    await f.db.query("update public.transcript_jobs set next_attempt_at=now()+interval '1 day' where reel_id=$1", [delayed]);
    await f.db.query('update public.transcript_jobs set attempt_count=3 where reel_id=$1', [exhausted]);
    await f.identity('service_role');
    const before = await f.rpc('worker_transcription_media_candidates', [1]);
    await f.identity(); await f.db.exec(migration); await f.identity('service_role');
    expect(await f.rpc('worker_transcription_media_candidates', [1])).toEqual(before);
    expect(before).toMatchObject({ creators: [{ creator_id: f.creator }] });
    await f.identity(); await f.db.query('update public.transcript_jobs set priority_requested_at=null where reel_id=$1', [due]);
    await f.identity('service_role'); expect(await f.rpc('worker_transcription_media_candidates', [1])).toEqual({ creators: [] });
    await f.identity();
    expect(await f.value("select has_function_privilege('authenticated','public.worker_transcription_media_candidates(integer)','execute') v")).toBe(false);
    expect(await f.value('select owner_user_id v from public.app_settings')).toBe(fixtureOwner);
  });
});

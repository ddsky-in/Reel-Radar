import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const db = new PGlite();
const secret = 'a'.repeat(64);
const migration = readFileSync(join(process.cwd(), 'supabase/migrations/202611080008_transcription_maintenance.sql'), 'utf8');
beforeAll(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema vault; create schema cron; create schema net;
    create table vault.secrets(id uuid primary key default gen_random_uuid(),name text,secret text);
    create view vault.decrypted_secrets as select id,name,secret as decrypted_secret from vault.secrets;
    create function vault.create_secret(value text,label text,description text) returns uuid language sql as $$ insert into vault.secrets(name,secret) values(label,value) returning id $$;
    create table cron.job(jobid bigint generated always as identity primary key,jobname text unique,schedule text,command text,active boolean default true);
    create function cron.schedule(label text,schedule text,command text) returns bigint language sql as $$ insert into cron.job(jobname,schedule,command) values(label,schedule,command) returning jobid $$;
    create table net.requests(id bigint generated always as identity, url text,headers jsonb,body jsonb);
    create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as $$ insert into net.requests(url,headers,body) values(url,headers,body) returning id $$;
    create table public.transcription_settings(singleton boolean default true,enabled boolean,paused boolean);
    insert into public.transcription_settings(enabled,paused) values(false,true);
    create function public.worker_transcription_config() returns jsonb language sql as $$ select to_jsonb(g) from public.transcription_settings g $$;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
  `);
  // Extension installation is hosted-only; PGlite runs the real scheduling functions against isolated stand-ins.
  await db.exec(migration.replace(/^create extension[^;]+;\s*/gm, ''));
}, 60000);
afterAll(async () => { await db.close(); });

describe('native transcript maintenance boundaries', () => {
  it('installs one schedule without publishing authentication or touching other jobs', async () => {
    await db.query("select cron.schedule('unrelated','0 9 * * *','select 1;')");
    const first = (await db.query<{ result: { installed: boolean; schedule: string } }>('select public.worker_transcription_install_schedule($1) result', [secret])).rows[0].result;
    expect(first.installed).toBe(true);
    expect(first.schedule).toBe('*/5 * * * *');
    expect(JSON.stringify(first)).not.toContain(secret);
    await db.query('select public.worker_transcription_install_schedule($1)', [secret]);
    expect((await db.query("select * from cron.job where jobname='reelradar-transcription-maintenance'")).rows).toHaveLength(1);
    expect((await db.query("select command from cron.job where jobname='unrelated'")).rows[0]).toEqual({ command: 'select 1;' });
  });
  it('rejects malformed or conflicting authentication without overwriting it', async () => {
    await expect(db.query('select public.worker_transcription_install_schedule($1)', ['short'])).rejects.toThrow(/Invalid/);
    await expect(db.query('select public.worker_transcription_install_schedule($1)', ['b'.repeat(64)])).rejects.toThrow(/differs/);
  });
  it('does not invoke functions when disabled or paused', async () => {
    await db.exec('select public.worker_transcription_maintenance()');
    await db.exec('update public.transcription_settings set enabled=true,paused=true');
    await db.exec('select public.worker_transcription_maintenance()');
    expect((await db.query('select * from net.requests')).rows).toHaveLength(0);
  });
  it('invokes only the fixed transcript endpoint when the gates permit it', async () => {
    // Even enabled gates cannot send a wake without installation-owned routing.
    await db.exec('update public.transcription_settings set enabled=true,paused=false');
    await db.exec('select public.worker_transcription_maintenance()');
    expect((await db.query('select * from net.requests')).rows).toHaveLength(0);
    await db.exec("insert into vault.secrets(name,secret) values('reelradar_edge_url','https://project.supabase.co')");
    await db.exec('update public.transcription_settings set enabled=true,paused=false');
    await db.exec('select public.worker_transcription_maintenance()');
    const request = (await db.query<{ url: string; body: unknown; headers: Record<string, string> }>('select url,body,headers from net.requests')).rows[0];
    expect(request.url).toBe('https://project.supabase.co/functions/v1/transcript-reconcile');
    expect(request.body).toEqual({ action: 'maintenance' });
    expect(request.headers['x-internal-secret']).toBe(secret);
  });
  it('denies browser installation and all caller execution of the scheduler body', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await expect(db.query('select public.worker_transcription_install_schedule($1)', [secret])).rejects.toThrow(/permission denied/);
      await expect(db.exec('select public.worker_transcription_maintenance()')).rejects.toThrow(/permission denied/);
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    await expect(db.exec('select public.worker_transcription_maintenance()')).rejects.toThrow(/permission denied/);
    await db.exec('reset role');
  });
});

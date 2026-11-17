import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const fixtures: string[] = [];
const rollouts = [
  {
    script: 'prepare-apify-account-rollout.mjs',
    migration: '202611140003_apify_multiaccount.sql',
    destination: 'artifacts/competitor-recovery/apify-account-rollout.sql',
    tag: '$reelradar_account_migration$',
  },
  {
    script: 'prepare-carousel-automation-rollout.mjs',
    migration: '202611140005_automatic_carousel_collection.sql',
    destination: 'artifacts/carousel-pilot/automation-rollout.sql',
    tag: '$reelradar_carousel_automation$',
  },
];

function fixture(rollout: typeof rollouts[number], source = "select 'synthetic local fixture only';\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reelradar-rollout-fixture-'));
  fixtures.push(root);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'supabase', 'migrations'), { recursive: true });
  const script = path.join(root, 'scripts', rollout.script);
  fs.copyFileSync(new URL(`../scripts/${rollout.script}`, import.meta.url), script);
  fs.writeFileSync(path.join(root, 'supabase', 'migrations', rollout.migration), source);
  return {
    root,
    destination: path.join(root, rollout.destination),
    run: () => spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', timeout: 10_000 }),
  };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.each(rollouts)('$script local rollout preparation', (rollout) => {
  it('creates absent artifact parents in an isolated fresh checkout', () => {
    const local = fixture(rollout);
    expect(fs.existsSync(path.join(local.root, 'artifacts'))).toBe(false);
    const result = local.run();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const sql = fs.readFileSync(local.destination, 'utf8');
    expect(sql).toContain("select 'synthetic local fixture only';");
    expect(sql).toContain('insert into supabase_migrations.schema_migrations');
    expect(sql).toContain('commit;');
    expect(result.stdout).toContain('No hosted changes made.');
  });

  it('refuses to overwrite an existing reviewed rollout', () => {
    const local = fixture(rollout);
    fs.mkdirSync(path.dirname(local.destination), { recursive: true });
    const reviewed = Buffer.from('existing reviewed artifact\r\n');
    fs.writeFileSync(local.destination, reviewed);
    const result = local.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Review.*existing rollout/);
    expect(fs.readFileSync(local.destination)).toEqual(reviewed);
  });

  it('rejects quoting collisions before creating artifact parents', () => {
    const local = fixture(rollout, `select '${rollout.tag}';\n`);
    const result = local.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Migration quoting collision');
    expect(fs.existsSync(path.join(local.root, 'artifacts'))).toBe(false);
  });
});

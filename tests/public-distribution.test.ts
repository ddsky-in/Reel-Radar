import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanDistribution } from '../scripts/check-public-release.mjs';

const directories: string[] = [];
function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reelradar-public-'));
  directories.push(root);
  for (const [name, value] of Object.entries(files)) {
    const output = path.join(root, name);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, value);
  }
  return root;
}
afterEach(() => { for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('public distribution guard', () => {
  it('blocks private files and screenshots independently of their contents', () => {
    const root = fixture({ '.env.worker.local': '', 'docs/screenshots/example.jpg': '', 'exports/accounts.csv': '', 'backup.dump': '' });
    expect(scanDistribution(root).findings).toHaveLength(4);
  });
  it('reports credential locations without echoing values', () => {
    const token = ['apify', 'api', 'x'.repeat(32)].join('_');
    const root = fixture({ 'src/fixture.ts': `const credential = '${token}';` });
    const result = scanDistribution(root);
    expect(result.findings).toEqual(['src/fixture.ts:1: provider token']);
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it('only permits exact invalid URL fixtures inside test directories', () => {
    const userinfo = ['https://', 'user', ':', 'password', '@', 'fixture.test'].join('');
    const root = fixture({ 'tests/rejection.ts': userinfo, 'src/example.ts': userinfo });
    expect(scanDistribution(root).findings).toEqual(['src/example.ts:1: credential-bearing URL']);
  });
  it('does not skip unrecognized credentials inside tests', () => {
    const value = ['https://', 'operator', ':', 'private-value', '@', 'fixture.test'].join('');
    const root = fixture({ 'tests/example.ts': value });
    expect(scanDistribution(root).findings).toEqual(['tests/example.ts:1: credential-bearing URL']);
  });
  it('allows safe examples and ignores build/dependency outputs', () => {
    const root = fixture({ '.env.example': 'DEMO_MODE=false', 'README.md': 'Synthetic demo', 'node_modules/fixture/.env': '', '.next/.env': '' });
    expect(scanDistribution(root)).toEqual({ findings: [], count: 2 });
  });
  it('rejects populated installation credentials even without recognizable token formats', () => {
    const root = fixture({ '.env.example': 'OWNER_EMAIL=fixture@example.test\nELEVENLABS_API_KEY=synthetic-but-populated' });
    expect(scanDistribution(root).findings).toHaveLength(2);
  });
  it('blocks uppercase environment files and local tool credentials', () => {
    const root = fixture({ '.ENV.LOCAL': '', '.npmrc': '', '.aws/credentials': '', '.mcp.json': '' });
    expect(scanDistribution(root).findings).toHaveLength(4);
  });
});

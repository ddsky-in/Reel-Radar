import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = new URL('../scripts/worker-control.mjs', import.meta.url).href;
const origin = 'https://project.supabase.co';
function run(args: string[]) {
  const source = `
    import fs from 'node:fs';
    import {fileURLToPath} from 'node:url';
    const entry=fileURLToPath(${JSON.stringify(script)}),read=fs.readFileSync.bind(fs);
    fs.readFileSync=(file,...options)=>{
      if(String(file)===entry||String(file)===${JSON.stringify(script)})return read(file,...options);
      if(String(file).endsWith('.env.worker.local'))return 'EXPECTED_SUPABASE_ORIGIN=https://project.supabase.co\\nINTERNAL_CRON_SECRET=fixture-secret';
      if(String(file).endsWith('.env.local'))return 'NEXT_PUBLIC_SUPABASE_URL=${origin}';
      throw Error('Unexpected configuration read');
    };
    process.argv=[process.execPath,'worker-control.mjs',...${JSON.stringify(args)}];
    globalThis.fetch=async(url,options)=>{
      console.log('request:'+JSON.stringify({url,body:JSON.parse(options.body)}));
      return new Response('{}',{status:200,headers:{'content-type':'application/json'}});
    };
    await import(${JSON.stringify(script)});
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10_000 });
  return { ...result, requests: result.stdout.split(/\r?\n/).filter(line => line.startsWith('request:')).map(line => JSON.parse(line.slice(8))) };
}

describe('secure account configuration operator', () => {
  it('sends only explicitly authorized slot numbers, never token values or a start request', () => {
    const result = run(['configure_accounts', '2', '3', '4', '5']);
    expect(result.status).toBe(0);
    expect(result.requests).toEqual([{ url: `${origin}/functions/v1/refresh-dispatch`, body: { action: 'configure_accounts', account_slots: [2, 3, 4, 5], authorization_confirmed: true } }]);
    expect(result.stdout).not.toContain('fixture-secret');
  });
  it.each([[], ['0'], ['6'], ['2', '2'], ['token-value'], ['1', '2', '3', '4', '5', '6']].map(args => ({ args })))('rejects invalid or missing slots before transport: $args', ({ args }) => {
    const result = run(['configure_accounts', ...args]);
    expect(result.status).not.toBe(0); expect(result.requests).toEqual([]);
  });
});

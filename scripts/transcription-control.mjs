import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = file => Object.fromEntries(fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const config = { ...load('.env.local'), ...load('.env.worker.local') };
if (!config.INTERNAL_CRON_SECRET) throw new Error('Worker authentication is not configured.');
const target = new URL(config.NEXT_PUBLIC_SUPABASE_URL);
// The operator explicitly pins the destination in its ignored worker configuration.
if (target.origin !== config.EXPECTED_SUPABASE_ORIGIN || target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Unexpected project target.');
const action = process.argv[2] ?? 'diagnostics';
if (!['diagnostics', 'install_schedule', 'dispatch', 'reconcile', 'setup_webhook', 'enable_pilot', 'media_refresh', 'source_refresh', 'account_diagnostics', 'verify_pilot', 'enable_automatic'].includes(action)) throw new Error('Unsupported action.');
const input = { action };
if (action === 'media_refresh' || action === 'source_refresh') {
  const creatorId = process.argv[3];
  if (typeof creatorId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(creatorId)) throw new Error('An existing authorized creator UUID is required.');
  input.creator_id = creatorId;
} else if (process.argv[3] !== undefined) throw new Error('Unexpected action argument.');
const functionName = action === 'reconcile' ? 'transcript-reconcile' : 'transcript-dispatch';
const response = await fetch(`${target.origin}/functions/v1/${functionName}`, {
  method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'x-internal-secret': config.INTERNAL_CRON_SECRET },
  body: JSON.stringify(input), signal: AbortSignal.timeout(90000),
});
const value = await response.json().catch(() => ({ error: 'invalid_response' }));
console.log(JSON.stringify({ status: response.status, result: value }, null, 2));
if (!response.ok) process.exitCode = 1;

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
if (!['diagnostics', 'configure_accounts', 'configure_collection_throughput', 'configure_carousel_automation', 'configure_profile_automation', 'inspect_run', 'dispatch', 'reconcile', 'install_competitor_schedules', 'discovery', 'metrics', 'carousel_pilot', 'reconcile_carousel_pilot', 'settle_job'].includes(action)) throw new Error('Unsupported action.');
const pilot = ['carousel_pilot', 'reconcile_carousel_pilot', 'settle_job'].includes(action);
if (pilot && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(process.argv[3] ?? '')) throw new Error('Explicit carousel pilot job UUID required.');
const accountSlots = action === 'configure_accounts' ? process.argv.slice(3).map(Number) : [];
if (action === 'configure_accounts' && (!accountSlots.length || accountSlots.length > 5 || new Set(accountSlots).size !== accountSlots.length || accountSlots.some(slot => ![1, 2, 3, 4, 5].includes(slot)))) throw new Error('Explicit account slots 1 through 5 required.');
const carouselEnabled = action === 'configure_carousel_automation' ? process.argv[3] : undefined;
if (action === 'configure_carousel_automation' && (!['true', 'false'].includes(carouselEnabled ?? '') || process.argv.length !== 4)) throw new Error('Explicit carousel automation boolean required.');
const profileEnabled = action === 'configure_profile_automation' ? process.argv[3] : undefined;
if (action === 'configure_profile_automation' && (!['true', 'false'].includes(profileEnabled ?? '') || process.argv.length !== 4)) throw new Error('Explicit profile automation boolean required.');
const throughput = action === 'configure_collection_throughput' ? process.argv.slice(3).map(Number) : [];
if (action === 'configure_collection_throughput' && (throughput.length !== 2 || throughput.some(value => !Number.isSafeInteger(value) || value < 1 || value > 4))) throw new Error('Explicit active and per-wake limits from 1 through 4 required.');
const body = action === 'configure_collection_throughput' ? { action, max_active: throughput[0], max_starts_per_wake: throughput[1] }
  : action === 'configure_carousel_automation' ? { action, enabled: carouselEnabled === 'true' }
  : action === 'configure_profile_automation' ? { action, enabled: profileEnabled === 'true' }
  : action === 'configure_accounts' ? { action, account_slots: accountSlots, authorization_confirmed: true }
  : action === 'carousel_pilot' ? { action, job_id: process.argv[3], continuation_budget: 4 }
  : action === 'settle_job' ? { settle_job_id: process.argv[3], continuation_budget: 0 }
  : action === 'reconcile_carousel_pilot' ? { carousel_pilot_job_id: process.argv[3], continuation_budget: 4 }
  : action === 'inspect_run' ? { action, run_id: process.argv[3] }
  : ['diagnostics', 'install_competitor_schedules'].includes(action) ? { action }
  : ['discovery', 'metrics'].includes(action) ? { kind: action, continuation_budget: 4 } : { continuation_budget: 4 };
const functionName = ['reconcile', 'reconcile_carousel_pilot', 'settle_job'].includes(action) ? 'reconcile-jobs' : 'refresh-dispatch';
const response = await fetch(`${target.origin}/functions/v1/${functionName}`, {
  method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'x-internal-secret': config.INTERNAL_CRON_SECRET },
  body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
});
const value = await response.json().catch(() => ({ error: 'invalid_response' }));
console.log(JSON.stringify({ status: response.status, result: value }, null, 2));
if (!response.ok) process.exitCode = 1;

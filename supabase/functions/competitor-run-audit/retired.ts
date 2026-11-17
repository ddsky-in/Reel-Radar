import { authenticate, json } from '../_shared/worker.ts';

// The time-bound evidence tool is retired. Never read providers or mutate holds.
export async function handler(request: Request): Promise<Response> {
  if (!await authenticate(request)) return json({ error: 'unauthorized' }, 401);
  return json({ error: 'audit_retired', read_only: true, no_start_proven: false }, 410);
}
Deno.serve(handler);

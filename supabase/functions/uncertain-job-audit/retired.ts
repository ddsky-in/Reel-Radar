export async function handler(request: Request): Promise<Response> {
  const expected = Deno.env.get('INTERNAL_CRON_SECRET') ?? '', supplied = request.headers.get('x-internal-secret') ?? '';
  const encoder = new TextEncoder();
  const hashes = await Promise.all([expected, supplied].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const left = new Uint8Array(hashes[0]), right = new Uint8Array(hashes[1]); let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  const authorized = request.method === 'POST' && expected && supplied && difference === 0;
  return new Response(JSON.stringify(authorized ? { error: 'audit_retired', read_only: true, no_start_proven: false } : { error: 'unauthorized' }), {
    status: authorized ? 410 : 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
Deno.serve(handler);

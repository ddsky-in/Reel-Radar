const equal = async (left: string, right: string) => {
  if (!left || !right) return false;
  const values = await Promise.all([left, right].map(value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
  const a = new Uint8Array(values[0]), b = new Uint8Array(values[1]); let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
export async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST' || !await equal(request.headers.get('x-internal-secret') ?? '', Deno.env.get('INTERNAL_CRON_SECRET') ?? '')) return json({ error: 'unauthorized' }, 401);
  const key = Deno.env.get('ELEVENLABS_API_KEY');
  if (!key) return json({ key_configured: false, api_access: false }, 503);
  const signal = AbortSignal.timeout(20000);
  try {
    const response = await fetch('https://api.elevenlabs.io/v1/workspace/webhooks?include_usages=true', { method: 'GET', redirect: 'error', headers: { 'xi-api-key': key }, signal });
    const reader = response.body?.getReader(); let text = ''; let length = 0;
    if (reader) {
      const decoder = new TextDecoder();
      while (true) {
        const part = await reader.read(); if (part.done) break;
        length += part.value.byteLength;
        if (length > 262144) { await reader.cancel(); break; }
        text += decoder.decode(part.value, { stream: true });
      }
    }
    let code: string | null = null;
    let category: string | null = null;
    try {
      const data = JSON.parse(text);
      const detail = data?.detail;
      const value = detail?.status;
      if (['missing_permissions', 'invalid_api_key', 'quota_exceeded', 'rate_limit_exceeded', 'account_disabled', 'invalid_request', 'unauthorized'].includes(value)) code = value;
      const message = typeof detail === 'string' ? detail : typeof detail?.message === 'string' ? detail.message : '';
      if (/api.?key/i.test(message) && /not supported|not allowed|does not support|cannot|can not|only.*(?:token|session|bearer)/i.test(message)) category = 'api_key_authentication_not_supported';
      else if (/admin|permission|scope/i.test(message)) category = 'workspace_permission_required';
      else if (/include_usages|parameter|query/i.test(message)) category = 'query_parameter_rejected';
      else if (/authentication|authenticate|session|bearer|token/i.test(message)) category = 'authentication_requirement';
    } catch { /* Provider bodies are never returned or logged. */ }
    const checks: { endpoint: string; http_status: number | null; available: boolean }[] = [];
    for (const [endpoint, path] of [['workspace_webhooks_basic', '/v1/workspace/webhooks?include_usages=false'], ['subscription', '/v1/user/subscription']] as const) {
      try {
        const check = await fetch(`https://api.elevenlabs.io${path}`, { method: 'GET', redirect: 'error', headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(10000) });
        checks.push({ endpoint, http_status: check.status, available: check.ok });
        await check.body?.cancel();
      } catch { checks.push({ endpoint, http_status: null, available: false }); }
    }
    const keyFormat = {
      surrounding_whitespace: key.trim() !== key,
      contains_linebreak: /[\r\n]/.test(key),
      includes_assignment: /^\s*(?:ELEVENLABS_API_KEY|xi-api-key)\s*[:=]/i.test(key),
      surrounding_quotes: /^['"]|['"]$/.test(key),
      expected_prefix: key.startsWith('sk_'),
    };
    const errorText = text.toLowerCase();
    const responseCategory = /invalid.?api.?key/.test(errorText) ? 'invalid_api_key'
      : /missing.?permissions|permission|scope/.test(errorText) ? 'permission_required'
      : /authentication|authorization|authenticate/.test(errorText) ? 'authentication_requirement'
      : /cloudflare|access denied|request blocked/.test(errorText) ? 'gateway_rejection'
      : /bad request/.test(errorText) ? 'bad_request' : 'unclassified';
    return json({ key_configured: true, key_format: keyFormat, api_access: response.ok, provider_http_status: response.status, provider_error_code: code, error_category: category, response_category: responseCategory, response_content_type: response.headers.get('content-type')?.split(';')[0] ?? null, endpoint: 'workspace_webhooks', additional_checks: checks, mutating_request_sent: false });
  } catch {
    return json({ key_configured: true, api_access: false, provider_http_status: null, provider_error_code: 'transport_unavailable', endpoint: 'workspace_webhooks', mutating_request_sent: false }, 503);
  }
}
Deno.serve(handler);

import assert from 'node:assert/strict';

const origin = process.argv[2] ?? 'http://127.0.0.1:3000';
const target = new URL(origin);
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.protocol !== 'http:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
  throw new Error('Smoke checks require an explicit HTTP loopback origin and synthetic demo data.');
}
const request = async (path, method = 'GET', body, otherOrigin = origin) => {
  const response = await fetch(`${origin}${path}`, { method, headers: { ...(method !== 'GET' ? { Origin: otherOrigin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
};
const boot = await request('/api/bootstrap');
assert.equal(boot.status, 200); assert.equal(boot.data.mode, 'demo');
const workspace = boot.data.workspaces[0].id;
const page = await request(`/api/workspaces/${workspace}/reels?limit=2`);
assert.equal(page.status, 200); assert.equal(page.data.items.length, 2);
const reel = page.data.items[0];
const savePath = `/api/workspaces/${workspace}/saved`;
assert.equal((await request(savePath, 'POST', { reel_id: reel.id, note: 'HTTP smoke test', tags: ['test'] })).status, 200);
const saved = await request(`/api/workspaces/${workspace}/reels?saved=true`);
assert(saved.data.items.some(item => item.id === reel.id && item.note === 'HTTP smoke test'));
assert.equal((await request(`${savePath}/${reel.id}`, 'DELETE')).status, 204);
assert.equal((await request(savePath, 'POST', { reel_id: reel.id }, 'https://evil.example')).status, 403);
const csv = 'username\n@http_smoke_creator\nhttp_smoke_creator\n/bad';
const preview = await request(`/api/workspaces/${workspace}/creators/import`, 'POST', { csv, preview: true });
assert.equal(preview.status, 200); assert.equal(preview.data.duplicates, 1); assert.equal(preview.data.invalid, 1);
assert.equal((await request('/api/settings', 'PATCH', { scraping_enabled: true })).status, 403);
assert.equal((await request(`/api/workspaces/${workspace}/reels?limit=10000`)).status, 400);
console.log('PASS: production HTTP demo bootstrap, pagination, save/read/delete, foreign-origin rejection, CSV preview, scraping guard, bounded query');

const reserved = new Set(['accounts', 'about', 'api', 'developer', 'direct', 'explore', 'legal', 'p', 'reel', 'reels', 'stories', 'tv', 'web']);

export function normalizeHandle(input: string): string {
  let value = input.trim();
  if (!value || value.length > 2048) throw new Error('Enter a valid Instagram username or profile URL.');
  if (/^(?:https?:\/\/)?(?:www\.)?instagram\.com\//i.test(value)) {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) throw new Error('Use a public Instagram profile URL.');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 1 || parts.length > 2 || (parts[1] && parts[1].toLowerCase() !== 'reels')) throw new Error('Use a profile URL, not a Reel or post URL.');
    value = decodeURIComponent(parts[0]);
  } else if (/[/:?#\s]/.test(value)) {
    throw new Error('Enter a username or instagram.com profile URL.');
  }
  const username = value.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_](?:[a-z0-9_.]{0,28}[a-z0-9_])?$/.test(username) || username.includes('..') || reserved.has(username)) throw new Error('Instagram usernames use 1–30 letters, numbers, periods, or underscores.');
  return username;
}

export function canonicalReelUrl(value: unknown): { shortcode: string; url: string } | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase()) || url.port || url.username || url.password) return null;
    const match = /^\/(?:reel|p)\/([A-Za-z0-9_-]{3,64})\/?$/.exec(url.pathname);
    return match ? { shortcode: match[1], url: `https://www.instagram.com/reel/${match[1]}/` } : null;
  } catch { return null; }
}

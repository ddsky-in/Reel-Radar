import Papa from 'papaparse';
import { normalizeHandle, canonicalReelUrl } from '../normalize';
import type { ImportRow, Reel } from '../types';
import { ApiError } from './errors';

export interface CsvInput { row: number; input: string; username: string | null; workspace: string; error?: string }
export function parseCreatorCsv(csv: string, defaultWorkspace: string): CsvInput[] {
  const parsed = Papa.parse<Record<string, string>>(csv.replace(/^\uFEFF/, ''), { delimiter: ',', header: true, skipEmptyLines: 'greedy', transformHeader: value => value.trim().toLowerCase() });
  const fields = parsed.meta.fields ?? [];
  if (!fields.includes('username') || fields.some(field => !['username', 'workspace'].includes(field)) || new Set(fields).size !== fields.length) throw new ApiError(400, 'INVALID_CSV', 'CSV requires a username column and an optional workspace column.');
  if (parsed.errors.length) throw new ApiError(400, 'INVALID_CSV', 'CSV contains malformed or inconsistent rows.');
  if (!parsed.data.length || parsed.data.length > 1000) throw new ApiError(400, 'INVALID_CSV', 'Import between 1 and 1000 rows at a time.');
  return parsed.data.map((record, index) => {
    const input = record.username ?? '';
    const workspace = record.workspace?.trim() || defaultWorkspace;
    const base = { row: index + 2, input, workspace };
    if (!workspace || workspace.length > 80) return { ...base, username: null, error: 'Workspace names must contain 1–80 characters.' };
    try { return { ...base, username: normalizeHandle(input) }; }
    catch (error) { return { ...base, username: null, error: error instanceof Error ? error.message : 'Invalid username.' }; }
  });
}

export function previewCsv(rows: CsvInput[], existing: Map<string, Set<string>>): ImportRow[] {
  const seen = new Map<string, Set<string>>([...existing].map(([name, usernames]) => [name.toLowerCase(), new Set(usernames)]));
  return rows.map(row => {
    if (!row.username || row.error) return { ...row, status: 'invalid' };
    const key = row.workspace.toLowerCase();
    const usernames = seen.get(key) ?? new Set<string>();
    const duplicate = usernames.has(row.username);
    usernames.add(row.username);
    seen.set(key, usernames);
    return { ...row, status: duplicate ? 'duplicate' : 'ready' };
  });
}

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function exportReelsCsv(reels: Reel[]): string {
  const headers = ['username', 'published_at', 'published_at_raw', 'published_at_basis', 'reel_url', 'caption', 'views', 'likes', 'comments', 'engagement_rate_pct', 'follower_outlier_score', 'followers_count', 'follower_captured_at', 'last_refreshed_at', 'provider', 'saved', 'note', 'tags', 'profile_outlier_score', 'profile_baseline_views', 'profile_baseline_sample'];
  return '\uFEFF' + [headers.map(csvCell).join(','), ...reels.map(reel => [reel.username, reel.published_at, reel.published_at_raw ?? '', reel.published_at_basis ?? 'explicit_offset', canonicalReelUrl(reel.reel_url)?.url ?? '', reel.caption_preview, reel.latest_views, reel.latest_likes, reel.latest_comments, reel.engagement_rate_pct, reel.follower_outlier_score, reel.followers_count, reel.follower_captured_at, reel.latest_fetched_at, reel.provider, reel.saved, reel.note, reel.tags.join('; '), reel.profile_outlier_score, reel.profile_baseline_views, reel.profile_baseline_sample].map(csvCell).join(','))].join('\r\n');
}

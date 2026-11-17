import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicationTimestamp } from '../supabase/functions/_shared/model';
import { formatDate, formatDateTime } from '../src/lib/format';

describe('requested compact Reel presentation', () => {
  it('uses user-approved IST for naive upload times without modifying billing timestamp validation', () => {
    expect(publicationTimestamp('2026-11-07T11:56:03')).toEqual({ instant: '2026-11-07T06:26:03.000Z', basis: 'assumed_Asia/Kolkata' });
    expect(formatDate('2026-11-07T06:26:03.000Z')).toBe('7 Nov 2026');
    expect(formatDateTime('2026-11-07T06:26:03.000Z')).toContain('11:56');
  });
  it('fits at most five readable cards to available width with uncropped media', () => {
    const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(css).toContain('repeat(auto-fill, minmax(min(100%, max(11rem, calc((100% - 3rem) / 5))), 1fr))');
    expect(css).not.toContain('repeat(7, minmax(0, 1fr))');
    expect(css).not.toMatch(/\.creator-reels\s*\{[^}]*repeat\(/);
    expect(css).not.toContain('max-width: 1680px');
    expect(css).toMatch(/\.thumbnail img\s*\{\s*object-fit:\s*contain/);
    expect(css).toContain('aspect-ratio: 9 / 16');
  });
  it('passes real avatar URLs without tying preview counts to seven columns', () => {
    const ui = readFileSync(join(process.cwd(), 'src/components/ui.tsx'), 'utf8');
    expect(ui).toContain('Profile picture of @');
    expect(ui).toContain('validCreatorAvatarPath(fallbackUrl)');
    expect(ui).toContain('current.retries >= 2');
    const reels = readFileSync(join(process.cwd(), 'src/components/reels.tsx'), 'utf8');
    expect(reels).toContain('url={reel.avatar_url}');
    expect(readFileSync(join(process.cwd(), 'src/components/dashboard.tsx'), 'utf8')).toContain('url={entry.creator.avatar_url}');
    expect(readFileSync(join(process.cwd(), 'src/components/competitors.tsx'), 'utf8')).toContain('reelQueryString(query)');
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatDuration } from '../src/lib/format';
import { DurationBadge } from '../src/components/duration-badge';
import { Thumbnail } from '../src/components/reel-thumbnail';
import type { Reel } from '../src/lib/types';

describe('Reel cover duration', () => {
  it.each([[0, '0:00'], [9, '0:09'], [28, '0:28'], [59, '0:59'], [60, '1:00'], [75, '1:15'], [125, '2:05'], [3601, '60:01'], [28.4, '0:28'], [59.9, '1:00']])('formats %s seconds as %s', (seconds, label) => {
    expect(formatDuration(Number(seconds))).toBe(label);
  });
  it.each([null, undefined, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 10])('does not fabricate duration for %s', seconds => {
    expect(formatDuration(seconds)).toBeNull();
    expect(renderToStaticMarkup(createElement(DurationBadge, { seconds }))).toBe('');
  });
  it('renders an accessible exact-seconds tooltip and concise label', () => {
    const markup = renderToStaticMarkup(createElement(DurationBadge, { seconds: 75.2 }));
    expect(markup).toContain('class="thumbnail-duration"');
    expect(markup).toContain('aria-label="Video duration: 1:15"');
    expect(markup).toContain('title="75.2 seconds"');
    expect(markup).toContain('>1:15</span>');
  });
  it.each([false, true])('renders duration for both loaded-image and fallback covers (compact=%s)', compact => {
    const reel = { username: 'fixture', provider: 'test', thumbnail_url: 'https://example.test/thumbnail.jpg', duration_seconds: 87.3 } as Reel;
    const image = renderToStaticMarkup(createElement(Thumbnail, { reel, compact }));
    const fallback = renderToStaticMarkup(createElement(Thumbnail, { reel: { ...reel, thumbnail_url: null }, compact }));
    expect(image).toContain('<img');
    expect(image).toContain('Video duration: 1:27');
    expect(fallback).toContain('Thumbnail unavailable');
    expect(fallback).toContain('Video duration: 1:27');
    expect(fallback).not.toContain('<img');
  });
  it('omits unknown duration on both cover branches', () => {
    for (const thumbnail_url of [null, 'https://example.test/thumbnail.jpg']) {
      const reel = { username: 'fixture', provider: 'test', thumbnail_url, duration_seconds: null } as Reel;
      expect(renderToStaticMarkup(createElement(Thumbnail, { reel }))).not.toContain('thumbnail-duration');
    }
  });
  it('shares one overlay after the real-image/fallback branch, including compact covers', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/reel-thumbnail.tsx'), 'utf8');
    expect(source.match(/<DurationBadge seconds=\{reel.duration_seconds\}/g)).toHaveLength(1);
    expect(source).not.toContain('!compact && <span className="thumbnail-duration"');
    expect(source).not.toContain('Small steps.');
    const styles = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(styles).toMatch(/\.thumbnail-duration\s*\{[^}]*position:\s*absolute;[^}]*right:\s*\.5rem;[^}]*bottom:\s*\.5rem;/);
    expect(styles).toMatch(/\.thumbnail img\s*\{\s*object-fit:\s*contain/);
  });
});

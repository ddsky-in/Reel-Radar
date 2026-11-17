import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = () => readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');
const theme = () => readFileSync(join(process.cwd(), 'src/app/research-theme.css'), 'utf8');
const dashboardStyles = () => readFileSync(join(process.cwd(), 'src/app/dashboard.css'), 'utf8');
const luminance = (hex: string) => {
  const channels = hex.replace('#', '').match(/.{2}/g)!.map(channel => parseInt(channel, 16) / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const contrast = (foreground: string, background: string) => {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

describe('responsive typography standards', () => {
  it('defines rem-based readable body, content and metadata tokens', () => {
    expect(css()).toMatch(/--text-body\s*:\s*1rem\s*;/);
    expect(css()).toMatch(/--text-ui\s*:\s*0?\.875rem\s*;/);
    expect(css()).toMatch(/--text-meta\s*:\s*0?\.75rem\s*;/);
    expect(css()).toMatch(/font-size:\s*100%/);
  });
  it('has no tiny fixed typography or device-specific shrinking', () => {
    const styles = css() + theme() + dashboardStyles();
    const fixed = [...styles.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px\b/g)].map(match => Number(match[1]));
    expect(fixed.filter(size => size < 12)).toEqual([]);
    const relative = [...styles.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?|\.\d+)rem\b/g)].map(match => Number(match[1]));
    expect(relative.filter(size => size < 0.75)).toEqual([]);
    expect(styles).not.toMatch(/font-size\s*:\s*0\s*[;}]/);
  });
  it('preserves browser scaling and responsive layout instead of CSS zoom', () => {
    expect(css()).not.toMatch(/(?:^|[;{])\s*zoom\s*:/);
    expect(css()).toMatch(/clamp\(/);
    expect(css()).toMatch(/overflow-x:\s*auto/);
    expect(css()).toMatch(/contain:\s*inline-size paint/);
    expect(css()).not.toMatch(/dashboard-reels\s*>\s*\.reel-card:last-child\s*\{\s*display:\s*none/);
    expect(css()).toMatch(/--control-size\s*:\s*2\.75rem\s*;/);
  });
  it('provides normal-text contrast for shared dark text and metadata', () => {
    const styles = theme();
    const foreground = /--text:\s*(#[\da-f]{6})/i.exec(styles)![1];
    const muted = /--muted:\s*(#[\da-f]{6})/i.exec(styles)![1];
    const paper = /--paper:\s*(#[\da-f]{6})/i.exec(styles)![1];
    expect(contrast(foreground, paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(muted, paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#93a4be', '#14283e')).toBeGreaterThanOrEqual(4.5);
  });
});

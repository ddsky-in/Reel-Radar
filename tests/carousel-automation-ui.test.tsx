import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CarouselAutomationSummary } from '../src/components/carousel-automation';
import { safeCarouselCollectionStatus } from '../src/lib/server/public-data';
import { DemoRepository } from '../src/lib/server/demo-repository';
import type { CarouselCollectionStatus } from '../src/lib/types';
const status: CarouselCollectionStatus = { enabled: true, provider_validated: true, paused: false, reason: null, pending_jobs: 10, active_jobs: 1, last_fetch_at: null, next_due_at: null, interval_hours: 24, window_limit: 30 };

describe('automatic carousel status UI', () => {
  it('shows truthful daily queue state without changing the gallery or promising 30 carousels', () => {
    const html = renderToStaticMarkup(createElement(CarouselAutomationSummary, { status }));
    expect(html).toContain('Daily carousel collection active'); expect(html).toContain('1 running');
    expect(html).toContain('30 recent photo posts'); expect(html).toContain('every 24 hours'); expect(html).toContain('Only carousels are saved');
    expect(html).not.toContain('30 carousels');
  });
  it('keeps setup/paused/disabled states and missing fetch times distinct', () => {
    for (const reason of ['setup_required', 'paused', 'disabled', 'scraping_disabled'] as const) {
      const html = renderToStaticMarkup(createElement(CarouselAutomationSummary, { status: { ...status, reason, active_jobs: 0 } }));
      expect(html).not.toContain('Daily carousel collection active'); expect(html).toContain('10 queued'); expect(html).toContain('Not fetched');
    }
  });
  it('sanitizes public status, rejects malformed counts and never accepts credentials', () => {
    expect(safeCarouselCollectionStatus({ ...status, secret: 'private' })).toEqual(status);
    for (const patch of [{ pending_jobs: -1 }, { active_jobs: 1.5 }, { window_limit: 100 }, { last_fetch_at: 'bad' }, { reason: 'provider-private-error' }]) expect(() => safeCarouselCollectionStatus({ ...status, ...patch })).toThrow('Carousel collection status could not be loaded');
  });
  it('demo status reads remain disabled and do not mutate', async () => {
    const repo = new DemoRepository(), before = await repo.bootstrap();
    expect(await repo.carouselCollectionStatus(before.workspaces[0].id)).toMatchObject({ enabled: false, reason: 'disabled' });
    expect(await repo.bootstrap()).toEqual(before);
  });
});

import { z } from 'zod';
import type { CarouselQuery } from './types';
import { resolveReelPeriod } from './reel-filters';

const channelId = z.uuid().transform(value => value.toLowerCase());
const filterShape = z.object({
  search: z.string().trim().max(200).optional(), keywords: z.string().trim().max(200).optional(),
  creator: channelId.optional(), creator_ids: z.array(channelId).max(120).refine(ids => new Set(ids).size === ids.length, 'Channels must be unique.').optional(), saved: z.boolean().optional(),
  min_interactions: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  min_outlier: z.number().min(0).max(100).optional(), max_outlier: z.number().min(0).max(100).optional(),
  min_profile_outlier: z.number().min(0).max(1_000_000).optional(), max_profile_outlier: z.number().min(0).max(1_000_000).optional(),
  min_engagement: z.number().min(0).max(100).optional(), max_engagement: z.number().min(0).max(100).optional(),
  posted_amount: z.number().int().min(1).max(366).optional(), posted_unit: z.enum(['days', 'weeks', 'months']).optional(),
  sort: z.enum(['latest', 'likes', 'comments', 'profile_outlier', 'follower_engagement']).optional(),
}).strict();

function checkCriteria(query: CarouselQuery, context: z.RefinementCtx) {
  for (const metric of ['outlier', 'profile_outlier', 'engagement'] as const) {
    const low = query[`min_${metric}`], high = query[`max_${metric}`];
    if (low !== undefined && high !== undefined && low > high) context.addIssue({ code: 'custom', message: 'Use an ordered score range.', path: [`max_${metric}`] });
  }
  if (query.creator !== undefined && query.creator_ids !== undefined) context.addIssue({ code: 'custom', message: 'Use one channel selection.', path: ['creator_ids'] });
  if ((query.posted_amount === undefined) !== (query.posted_unit === undefined)) context.addIssue({ code: 'custom', message: 'Complete both posted amount and unit.', path: ['posted_amount'] });
  if (query.posted_amount !== undefined && query.posted_unit && query.posted_amount > { days: 366, weeks: 52, months: 12 }[query.posted_unit]) context.addIssue({ code: 'custom', message: 'Use a period of at most one year.', path: ['posted_amount'] });
}

export const carouselFilterQuerySchema = filterShape.superRefine(checkCriteria);
export const carouselQuerySchema = filterShape.extend({
  page: z.number().int().min(1).max(10000).optional(), limit: z.number().int().min(1).max(50).optional(),
}).strict().superRefine(checkCriteria);
export const carouselFilterSchema = z.object({ name: z.string().trim().min(1).max(80), query: carouselFilterQuerySchema }).strict();

export function carouselPeriod(query: CarouselQuery, now = new Date()): { from: string; to: string } | null {
  if (query.posted_amount === undefined || query.posted_unit === undefined) return null;
  const resolved = resolveReelPeriod({ posted_amount: query.posted_amount, posted_unit: query.posted_unit }, now);
  return { from: resolved.from!, to: resolved.to! };
}

export function carouselActiveFilterCount(query: CarouselQuery, savedOnly = false): number {
  return [query.creator !== undefined || query.creator_ids !== undefined,
    query.min_outlier !== undefined || query.max_outlier !== undefined,
    query.min_profile_outlier !== undefined || query.max_profile_outlier !== undefined,
    query.min_engagement !== undefined || query.max_engagement !== undefined,
    query.posted_amount !== undefined, Boolean(query.search?.trim() || query.keywords?.trim()),
    query.min_interactions !== undefined, !savedOnly && query.saved === true].filter(Boolean).length;
}

export function readCarouselQuery(params: URLSearchParams): CarouselQuery {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(raw, key)) throw new Error('Duplicate carousel filter.');
    if (key === 'saved') {
      if (!['true', 'false'].includes(value)) throw new Error('Invalid saved filter.');
      raw[key] = value === 'true';
    } else if (['page', 'limit', 'min_interactions', 'min_outlier', 'max_outlier', 'min_profile_outlier', 'max_profile_outlier', 'min_engagement', 'max_engagement', 'posted_amount'].includes(key)) {
      if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid carousel number filter.');
      raw[key] = Number(value);
    } else if (key === 'creator_ids') {
      try { raw[key] = JSON.parse(value); } catch { throw new Error('Channels must be a list of creator IDs.'); }
    } else raw[key] = value;
  }
  const parsed = carouselQuerySchema.safeParse(raw);
  if (!parsed.success) throw new Error('Please check the carousel filters.');
  return parsed.data;
}

export function carouselQueryString(query: CarouselQuery): string {
  return new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, Array.isArray(value) ? JSON.stringify(value) : String(value)])).toString();
}

/** Render provider media directly with no server proxy, credentials, or arbitrary hosts. */
export function carouselMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || /[\\\s]/.test(value)) return null;
  if (/^\/demo\/carousel-[1-4]\.svg$/.test(value)) return value;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || !/^https:\/\/[^/?#@:]+\//.test(value)) return null;
    return ['.cdninstagram.com', '.fbcdn.net'].some(suffix => u.hostname.endsWith(suffix) && u.hostname.length > suffix.length) ? u.href : null;
  } catch { return null; }
}

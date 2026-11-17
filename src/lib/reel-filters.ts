import { z } from 'zod';
import type { ReelQuery } from './types';

const day = 86_400_000;
const uuid = z.uuid();
const date = z.string().refine(value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, 'Dates must use valid YYYY-MM-DD values.');

/** Canonical filter contract, shared by the client and server; never supplies UI defaults. */
export const reelFilterQuerySchema = z.object({
  search: z.string().max(200).transform(value => value.trim()).optional(),
  keywords: z.string().max(200).optional(),
  creator_id: uuid.optional(), creator_ids: z.array(uuid).max(120).optional(),
  platform: z.literal('instagram').optional(),
  min_views: z.number().int().min(0).max(10_000_000).optional(),
  max_views: z.number().int().min(0).max(10_000_000).optional(),
  min_engagement: z.number().min(0).max(100).optional(),
  max_engagement: z.number().min(0).max(100).optional(),
  min_outlier: z.number().min(0).max(100).optional(),
  max_outlier: z.number().min(0).max(100).optional(),
  min_profile_outlier: z.number().min(0).max(1_000_000).optional(),
  max_profile_outlier: z.number().min(0).max(1_000_000).optional(),
  from: date.optional(), to: date.optional(),
  posted_amount: z.number().int().min(1).max(366).optional(),
  posted_unit: z.enum(['days', 'weeks', 'months']).optional(),
  saved: z.boolean().optional(), freshness: z.enum(['all', 'fresh', 'stale']).optional(),
  status: z.enum(['active', 'pending', 'unavailable', 'private', 'failed', 'paused']).optional(),
  sort: z.enum(['published_at', 'views', 'likes', 'comments', 'engagement', 'outlier', 'profile_outlier']).optional(),
}).strict();
export const reelQueryKeys = Object.keys(reelFilterQuerySchema.shape);

function periodAndRanges(query: ReelQuery): ReelQuery {
  for (const metric of ['views', 'engagement', 'outlier', 'profile_outlier'] as const) {
    const min = query[`min_${metric}`], max = query[`max_${metric}`];
    if (min !== undefined && max !== undefined && min > max) throw new Error(`The ${metric} range must be ordered.`);
  }
  if ((query.posted_amount === undefined) !== (query.posted_unit === undefined)) throw new Error('Posted amount and unit must be supplied together.');
  if (query.posted_amount !== undefined && query.posted_unit !== undefined) {
    if (query.from !== undefined || query.to !== undefined) throw new Error('Use either a rolling period or explicit dates, not both.');
    const max = { days: 366, weeks: 52, months: 12 }[query.posted_unit];
    if (query.posted_amount > max) throw new Error('The date range must be at most 366 days.');
  }
  if (query.from !== undefined || query.to !== undefined) {
    const from = query.from ?? new Date(Date.parse(query.to!) - 366 * day).toISOString().slice(0, 10);
    const to = query.to ?? new Date(Date.parse(from) + 366 * day).toISOString().slice(0, 10);
    const span = Date.parse(to) - Date.parse(from);
    if (span < 0 || span > 366 * day) throw new Error('The date range must be ordered and at most 366 days.');
    return { ...query, from, to };
  }
  return query;
}

/** Validates JSON filter objects; presets deliberately disallow pagination and view. */
export function validateReelFilterQuery(input: unknown): ReelQuery {
  return periodAndRanges(reelFilterQuerySchema.parse(input));
}

const querySchema = reelFilterQuerySchema.extend({ page: z.number().int().min(1).max(10_000).optional(), limit: z.number().int().min(1).max(50).optional() }).strict();
const numericKeys = new Set(['min_views', 'max_views', 'min_engagement', 'max_engagement', 'min_outlier', 'max_outlier', 'min_profile_outlier', 'max_profile_outlier', 'posted_amount', 'page', 'limit']);

/** Strict URL parsing without defaults. creator_ids uses JSON, including an explicit []. */
export function parseReelFilterParams(params: URLSearchParams): ReelQuery {
  const input: Record<string, unknown> = {};
  for (const [key, value] of params) {
    if (!Object.hasOwn(querySchema.shape, key) || Object.hasOwn(input, key)) throw new Error('Unknown or repeated filter parameter.');
    if (numericKeys.has(key)) {
      if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`Invalid ${key} filter.`);
      input[key] = Number(value);
    } else if (key === 'saved') {
      if (value !== 'true' && value !== 'false') throw new Error('Saved must be true or false.');
      input[key] = value === 'true';
    } else if (key === 'creator_ids') {
      try { input[key] = JSON.parse(value); } catch { throw new Error('creator_ids must be a JSON array of creator IDs.'); }
    } else input[key] = value;
  }
  return periodAndRanges(querySchema.parse(input));
}

/** Fresh neutral UI state: numeric criteria are supplied only by the user. */
export function defaultReelFilters(): ReelQuery {
  return {};
}

/** Stable query value, with no leading ?. Arrays remain explicit even when empty. */
export function reelQueryString(query: ReelQuery): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort() as (keyof ReelQuery)[]) {
    const value = query[key];
    if (value !== undefined) params.set(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
  }
  return params.toString();
}

/** Client-safe URL reader. view is UI-only; other malformed parameters remain errors. */
export function readReelFilters(params: URLSearchParams): ReelQuery {
  if (params.getAll('view').length > 1) throw new Error('Repeated view parameter.');
  const filters = new URLSearchParams(params);
  filters.delete('view');
  return parseReelFilterParams(filters);
}

/** Resolve once at a read/export boundary. IST has a fixed offset and no DST. */
export function resolveReelPeriod(query: ReelQuery, now = new Date()): ReelQuery {
  const result: ReelQuery = periodAndRanges(querySchema.parse(query));
  if (result.posted_amount === undefined || result.posted_unit === undefined) return result;
  if (!Number.isFinite(now.getTime())) throw new Error('A valid current date is required.');
  const to = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const anchor = new Date(`${to}T00:00:00Z`);
  let from: string;
  if (result.posted_unit === 'months') {
    const month = new Date(anchor);
    month.setUTCDate(1);
    month.setUTCMonth(month.getUTCMonth() - result.posted_amount);
    const lastDay = new Date(month);
    lastDay.setUTCMonth(lastDay.getUTCMonth() + 1);
    lastDay.setUTCDate(0);
    month.setUTCDate(Math.min(anchor.getUTCDate(), lastDay.getUTCDate()));
    from = month.toISOString().slice(0, 10);
  } else {
    from = new Date(anchor.getTime() - result.posted_amount * (result.posted_unit === 'weeks' ? 7 : 1) * day).toISOString().slice(0, 10);
  }
  delete result.posted_amount;
  delete result.posted_unit;
  return periodAndRanges({ ...result, from, to });
}

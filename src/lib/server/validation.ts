import { z } from 'zod';
import type { CreatorQuery, ReelQuery } from '../types';
import { parseReelFilterParams, reelFilterQuerySchema, validateReelFilterQuery } from '../reel-filters';
import { normalizeHandle } from '../normalize';
import { ApiError } from './errors';

export const idSchema = z.uuid();
export const billingSyncSchema = z.object({}).strict();
export const collectionSettlementSchema = z.object({
  outcome: z.literal('risk_release'), reason: z.string().trim().min(10).max(1000),
  idempotency_key: idSchema, expected_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  acknowledge_unknown: z.literal(true),
}).strict();
export const collectionHoldsQuerySchema = z.object({ page: z.number().int().min(1).max(10_000), limit: z.number().int().min(1).max(50) }).strict();
export function parseCollectionHoldsQuery(params: URLSearchParams): { page: number; limit: number } {
  const raw: Record<string, number> = { page: 1, limit: 25 };
  const seen = new Set<string>();
  for (const [key, value] of params) {
    if (!['page', 'limit'].includes(key) || seen.has(key) || !/^\d+$/.test(value)) throw new ApiError(400, 'INVALID_QUERY', 'Use page 1–10000 and limit 1–50 for collection holds.');
    seen.add(key); raw[key] = Number(value);
  }
  return validate(collectionHoldsQuerySchema, raw);
}
export const transcriptRequestSchema = z.union([
  z.object({}).strict(),
  z.object({ retry_attempt_id: idSchema, accept_duplicate_charge: z.literal(true) }).strict(),
]);
export const workspaceSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export const workspacePatchSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), archived: z.boolean().optional() }).strict().refine(v => Object.keys(v).length > 0);
export const creatorSchema = z.object({ username: z.string().trim().min(1).max(2048) }).strict();
export const removeCreatorsSchema = z.object({ creator_ids: z.array(idSchema).min(1).max(1000) }).strict();
export const importSchema = z.object({ csv: z.string().min(1).max(1_000_000), preview: z.boolean() }).strict();
export const bookmarkSchema = z.object({ reel_id: idSchema, note: z.string().max(4000).optional(), tags: z.array(z.string().trim().min(1).max(40)).max(20).optional() }).strict();
export const carouselBookmarkSchema = z.object({ saved:z.boolean(),note:z.string().max(4000).optional(),tags:z.array(z.string().trim().min(1).max(40)).max(20).optional() }).strict();
export const carouselRefreshSchema = z.object({ creator_ids:z.array(idSchema).min(1).max(120).optional() }).strict();
export const completionSchema = z.object({ completion_status: z.enum(['pending', 'done']) }).strict();
export const refreshSchema = z.object({ workspace_id: idSchema, creator_ids: z.array(idSchema).min(1).max(120).optional() }).strict();
export const loginSchema = z.object({ email: z.email().max(254), password: z.string().min(1).max(256) }).strict();
const spendingCeilingSchema = z.number().finite().min(0).max(10_000).refine(value => {
  const scaled = value * 1_000_000;
  return (value === 0 || scaled >= 1) && Math.abs(scaled - Math.round(scaled)) <= Number.EPSILON * Math.max(1, Math.abs(scaled)) * 2;
}, 'Use at most six decimal places.');
export const transcriptionSettingsSchema = z.object({
  paused: z.boolean().optional(),
  monthly_budget_usd: spendingCeilingSchema.optional(),
  budget_warning_pct: z.number().int().min(1).max(100).optional(),
}).strict().refine(value => Object.keys(value).some(key => value[key as keyof typeof value] !== undefined));
export const settingsSchema = z.object({
  daily_limit: z.number().int().min(10).max(30).optional(),
  weekly_limit: z.number().int().min(10).max(30).optional(),
  monthly_budget_usd: spendingCeilingSchema.optional(),
  collection_job_cap_usd: spendingCeilingSchema.optional(),
  budget_warning_pct: z.number().int().min(1).max(100).optional(),
  paused: z.boolean().optional(),
  timezone: z.literal('Asia/Kolkata').optional(),
  capacity: z.number().int().min(1).max(1000).optional(),
}).strict().refine(v => Object.keys(v).length > 0);

export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'INVALID_INPUT', 'Please check the request fields and their allowed values.');
  return parsed.data;
}

export function normalizedUsername(input: string): string {
  try { return normalizeHandle(input); } catch (error) { throw new ApiError(400, 'INVALID_USERNAME', error instanceof Error ? error.message : 'Invalid Instagram username.'); }
}

export async function readJson(request: Request, maxBytes = 64_000): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'JSON_REQUIRED', 'Use application/json for this request.');
  if (Number(request.headers.get('content-length')) > maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  if (!request.body) throw new ApiError(400, 'INVALID_JSON', 'A JSON request body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.'); }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ApiError(400, 'INVALID_JSON', 'The body must contain valid JSON.'); }
}

export const reelFilterSchema = z.object({
  name: z.string().trim().min(1).max(80),
  query: reelFilterQuerySchema.transform((query, context) => {
    try { return validateReelFilterQuery(query); }
    catch { context.addIssue({ code: 'custom', message: 'Invalid reel filter ranges.' }); return z.NEVER; }
  }),
}).strict();

export const creatorQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  page: z.number().int().min(1).max(10_000).optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();

export function parseCreatorQuery(params: URLSearchParams): CreatorQuery {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(raw, key) || !['search', 'page', 'limit'].includes(key) || key !== 'search' && !/^\d+$/.test(value)) {
      throw new ApiError(400, 'INVALID_QUERY', 'Unknown, repeated, or invalid competitor query.');
    }
    raw[key] = key === 'search' ? value : Number(value);
  }
  const parsed = creatorQuerySchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'INVALID_QUERY', 'Use page 1–10000, limit 1–50, and search up to 200 characters.');
  return { ...parsed.data, page: parsed.data.page ?? 1, limit: parsed.data.limit ?? 50 };
}

export function parseReelQuery(params: URLSearchParams): ReelQuery {
  try {
    const query = parseReelFilterParams(params);
    return { ...query, page: query.page ?? 1, limit: query.limit ?? 30 };
  } catch { throw new ApiError(400, 'INVALID_QUERY', 'Unknown, repeated, or invalid reel filter. Check ranges, IDs, and dates (maximum 366 days).'); }
}

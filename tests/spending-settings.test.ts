import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { DemoRepository } from '../src/lib/server/demo-repository';
import { ApiError } from '../src/lib/server/errors';
import { safeTranscriptionOverview } from '../src/lib/server/public-data';
import { SupabaseRepository } from '../src/lib/server/supabase-repository';
import { settingsSchema, transcriptionSettingsSchema, validate } from '../src/lib/server/validation';

const owner = 'f2000000-0000-4000-8000-000000000001';
const overview = {
  enabled: false, paused: true, monthly_budget_usd: 25, pilot_limit_usd: .25, phase: 'pilot',
  estimated_month_spend: .08, reserved_usd: .02, actual_month_spend: null, unreconciled_jobs: 1, jobs: [],
};

describe('personal spending request validation', () => {
  it.each([0, .000001, .123456, 20.000001, 25, 9999.999999, 10000])('accepts a finite six-decimal monthly ceiling of %s', monthly_budget_usd => {
    expect(validate(transcriptionSettingsSchema, { monthly_budget_usd })).toEqual({ monthly_budget_usd });
    expect(validate(settingsSchema, { monthly_budget_usd })).toEqual({ monthly_budget_usd });
  });

  it('accepts independent partial updates and the former pause-only contract', () => {
    for (const patch of [{ paused: false }, { paused: true }, { budget_warning_pct: 1 }, { budget_warning_pct: 100 }, { paused: false, monthly_budget_usd: 75, budget_warning_pct: 90 }]) {
      expect(validate(transcriptionSettingsSchema, patch)).toEqual(patch);
    }
    expect(validate(settingsSchema, { capacity: 1000, daily_limit: 10, weekly_limit: 30 })).toEqual({ capacity: 1000, daily_limit: 10, weekly_limit: 30 });
  });

  it('rejects malformed values, excess precision, unknown fields and empty patches', () => {
    for (const patch of [
      null, [], {}, { paused: null }, { paused: 'false' }, { monthly_budget_usd: null },
      { monthly_budget_usd: '25' }, { monthly_budget_usd: -1 }, { monthly_budget_usd: 10000.000001 },
      { monthly_budget_usd: .0000001 }, { monthly_budget_usd: 1e-100 }, { monthly_budget_usd: 20.1234567 },
      { monthly_budget_usd: Infinity }, { monthly_budget_usd: NaN },
      { budget_warning_pct: 0 }, { budget_warning_pct: 101 }, { budget_warning_pct: 80.5 },
      { budget_warning_pct: '80' }, { budget_warning_pct: null }, { monthly_budget_usd: 25, secret: true },
    ]) expect(() => validate(transcriptionSettingsSchema, patch)).toThrow(ApiError);
    for (const patch of [{ monthly_budget_usd: Infinity }, { monthly_budget_usd: .0000001 }, { monthly_budget_usd: 1e-100 }, { capacity: 1001 }, { daily_limit: 9 }, { weekly_limit: 31 }]) {
      expect(() => validate(settingsSchema, patch)).toThrow(ApiError);
    }
  });

  it('cannot alter provider activation, reservations, validation or pilot limits', () => {
    for (const key of ['enabled', 'key_validated', 'contract_validated', 'account_pricing_validated', 'pilot_verified', 'phase', 'pilot_limit_usd', 'max_starts', 'concurrency', 'reservation_usd', 'max_duration_seconds', 'max_media_bytes', 'media_recovery_enabled']) {
      expect(() => validate(transcriptionSettingsSchema, { [key]: true, monthly_budget_usd: 25 })).toThrow(ApiError);
    }
    expect(() => validate(settingsSchema, { scraping_enabled: true, monthly_budget_usd: 25 })).toThrow(ApiError);
  });
});

describe('personal spending repository boundary', () => {
  it('forwards only validated owner preference fields and retrieves the overview', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: overview, error: null });
    const repo = new SupabaseRepository({ rpc } as unknown as SupabaseClient, owner, 'owner@example.test');
    const patch = { paused: false, monthly_budget_usd: 25, budget_warning_pct: 85 };
    expect(await repo.transcriptionSettings(patch)).toEqual(overview);
    expect(rpc.mock.calls).toEqual([
      ['update_transcription_settings', { p_settings: patch }],
      ['get_transcription_overview', undefined],
    ]);
    rpc.mockClear();
    await expect(repo.transcriptionSettings({ monthly_budget_usd: 25, enabled: true } as never)).rejects.toMatchObject({ status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('keeps pause-only clients working through their existing RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: overview, error: null });
    const repo = new SupabaseRepository({ rpc } as unknown as SupabaseClient, owner, 'owner@example.test');
    await repo.transcriptionPreferences(false);
    expect(rpc.mock.calls).toEqual([
      ['update_transcription_preferences', { p_paused: false }],
      ['get_transcription_overview', undefined],
    ]);
  });

  it('keeps demo processing disabled and accounting synthetic after a settings request', async () => {
    const repo = new DemoRepository();
    const before = (await repo.jobs()).jobs;
    const result = await repo.transcriptionSettings({ paused: false, monthly_budget_usd: 100 });
    expect(result).toMatchObject({ enabled: false, paused: true, actual_month_spend: null, estimated_month_spend: 0, reserved_usd: 0, jobs: [] });
    expect((await repo.jobs()).jobs).toEqual(before);
  });
});

describe('personal transcription overview disclosure', () => {
  it('keeps recorded accounting separate from unknown speech billing and discards private data', () => {
    const result = safeTranscriptionOverview({
      ...overview, actual_month_spend: 19.99, accounted_month_spend: .09, budget_warning_pct: 85,
      preferences_editable: true, pilot_verified: true, account_pricing_validated: true, processing_ready: false,
      spending_warning: true, job_counts: { queued: 300, ready: 200, source_url: 'https://private.test/media' },
      source_url: 'https://private.test/media', api_key: 'private-key', dispatch_nonce: 'private-nonce',
      jobs: [{ id: owner, reel_id: owner, username: 'fixture', status: 'queued', attempt_count: 1, created_at: '2026-11-08T12:00:00Z', lease_token: 'private-lease', provider_job_id: 'private-provider', completed_at: null, error_message: null }],
    });
    expect(result).toMatchObject({ actual_month_spend: null, accounted_month_spend: .09, reserved_usd: .02, budget_warning_pct: 85, preferences_editable: true, pilot_verified: true, account_pricing_validated: true, processing_ready: false, spending_warning: true });
    expect(result.job_counts).toMatchObject({ queued: 300, ready: 200 });
    expect(result.job_counts_complete).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private|source_url|api_key|dispatch_nonce|lease_token|provider_job_id/);
  });

  it('falls back safely when an older backend omits capabilities and total counts', () => {
    const result = safeTranscriptionOverview({ ...overview, jobs: [{ id: owner, reel_id: owner, username: 'fixture', status: 'queued', attempt_count: 0, created_at: '2026-11-08T12:00:00Z', completed_at: null, error_message: null }] });
    expect(result.budget_warning_pct).toBe(80);
    expect(result.accounted_month_spend).toBe(.08);
    expect(result.job_counts).toMatchObject({ queued: 1 });
    expect(result.job_counts_complete).toBe(false);
    for (const key of ['preferences_editable', 'pilot_verified', 'account_pricing_validated', 'processing_ready']) expect(Object.hasOwn(result, key)).toBe(false);
  });

  it('does not turn malformed capabilities into processing permission or accept invalid counts', () => {
    const result = safeTranscriptionOverview({ ...overview, budget_warning_pct: 500, accounted_month_spend: -1, preferences_editable: 'true', pilot_verified: 'yes', account_pricing_validated: 1, processing_ready: 'true', spending_warning: 'true', job_counts: { queued: -1, ready: Infinity, failed: .5, unknown: 12 } });
    expect(result).toMatchObject({ actual_month_spend: null, budget_warning_pct: 80, accounted_month_spend: 0 });
    for (const key of ['preferences_editable', 'pilot_verified', 'account_pricing_validated', 'processing_ready', 'spending_warning']) expect(result[key as keyof typeof result]).not.toBe(true);
    expect(result.job_counts?.queued ?? 0).toBe(0);
    expect(result.job_counts?.ready ?? 0).toBe(0);
    expect(result.job_counts?.failed ?? 0).toBe(0);
    expect(result.job_counts).not.toHaveProperty('unknown');
  });
});

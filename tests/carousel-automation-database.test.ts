import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { featureDatabase } from './support/feature-database';

it('runs the real automatic-carousel SQL contract in an isolated empty migrated database', async () => {
  const f = await featureDatabase({ empty: true });
  try {
    await f.db.exec(readFileSync(join(process.cwd(), 'supabase/tests/database/automatic_carousel_collection.test.sql'), 'utf8'));
    expect(await f.value<number>('select count(*)::integer v from public.carousel_automation_settings')).toBe(0);
  } finally { await f.db.close(); }
}, 90_000);

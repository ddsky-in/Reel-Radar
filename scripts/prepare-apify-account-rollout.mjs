import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Prepare the exact reviewed forward migration; no network or database writes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '202611140003';
const name = 'apify_multiaccount';
const source = fs.readFileSync(path.join(root, 'supabase/migrations', `${version}_${name}.sql`), 'utf8');
const tag = '$reelradar_account_migration$';
if (source.includes(tag)) throw new Error('Migration quoting collision');
const sql = [
  'begin;', "set local lock_timeout='10s';", "set local statement_timeout='60s';",
  "select pg_advisory_xact_lock(hashtextextended('reelradar-apify-account-rollout',0));",
  "do $$ begin if to_regclass('public.apify_accounts') is not null then raise exception 'account_migration_already_present'; end if; end $$;",
  source,
  `insert into supabase_migrations.schema_migrations(version,name,statements) values('${version}','${name}',array[${tag}${source}${tag}]);`,
  "notify pgrst,'reload schema';", 'commit;',
  `select version,name from supabase_migrations.schema_migrations where version='${version}';`,
].join('\n\n');
const destination = path.join(root, 'artifacts/competitor-recovery/apify-account-rollout.sql');
if (fs.existsSync(destination)) throw new Error('Review existing rollout before replacing it');
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, sql, { flag: 'wx' });
console.log('Prepared the reviewed account migration. No hosted changes made.');

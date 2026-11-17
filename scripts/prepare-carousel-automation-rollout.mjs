import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '202611140005', name = 'automatic_carousel_collection';
const source = fs.readFileSync(path.join(root, 'supabase/migrations', `${version}_${name}.sql`), 'utf8');
const tag = '$reelradar_carousel_automation$';
if (source.includes(tag)) throw new Error('Migration quoting collision');
const sql = ['begin;', "set local lock_timeout='10s';", "set local statement_timeout='60s';",
  "select pg_advisory_xact_lock(hashtextextended('reelradar-carousel-automation-rollout',0));", source,
  `insert into supabase_migrations.schema_migrations(version,name,statements) values('${version}','${name}',array[${tag}${source}${tag}]);`,
  "notify pgrst,'reload schema';", 'commit;', `select version,name from supabase_migrations.schema_migrations where version='${version}';`].join('\n\n');
const destination = path.join(root, 'artifacts/carousel-pilot/automation-rollout.sql');
if (fs.existsSync(destination)) throw new Error('Review the existing rollout before replacing it');
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, sql, { flag: 'wx' });
console.log('Prepared carousel automation rollout. No hosted changes made.');

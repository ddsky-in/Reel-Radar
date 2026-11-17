import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skip = new Set(['node_modules', '.next', '.git', 'coverage']);
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['provider token', /\b(?:apify_api_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk_live_[A-Za-z0-9]{16,}|sb_secret_[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/],
  ['encoded JWT', /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/],
  ['credential-bearing URL', /https?:\/\/[^\s/'"`]+:[^\s/'"`]+@/],
  ['privileged browser variable', /\bNEXT_PUBLIC_[A-Z_]*(?:SERVICE_ROLE|SECRET|PRIVATE_KEY|APIFY_TOKEN|ELEVENLABS_API_KEY)[A-Z_]*\b/],
];

export function scanDistribution(root) {
 const findings = [];
 let count = 0;
 function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isSymbolicLink()) { findings.push(`${relative}: symbolic link must not be distributed`); continue; }
    if (entry.isDirectory()) {
      if (skip.has(entry.name)) continue;
      if (/^(?:artifacts|private|internal|backups|exports|screenshots|\.tmp|\.demo-data|\.vercel|\.supabase|\.zcode|\.codex|\.agents|\.aws|\.ssh)$/.test(entry.name.toLowerCase())) {
        findings.push(`${relative}: private/generated directory`); continue;
      }
      walk(absolute); continue;
    }
    if ((/^\.env/i.test(entry.name) && relative !== '.env.example') || /^(?:\.npmrc|\.mcp\.json|credentials\.json)$/i.test(entry.name) || /\.(?:pem|key|p12|pfx|dump|har|log|sqlite\d*|db|zip|tar|gz|csv|jpe?g|png|mp4|mp3|wav)$/i.test(entry.name)) {
      findings.push(`${relative}: private credential/data/media artifact`); continue;
    }
    if (/\.tsbuildinfo$/.test(entry.name)) continue;
    const bytes = fs.readFileSync(absolute);
    count++;
    // The original application favicon is the only bundled binary asset.
    if (relative === 'src/app/favicon.ico') continue;
    if (bytes.includes(0)) { findings.push(`${relative}: unexpected binary file`); continue; }
    const lines = bytes.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (relative === '.env.example' && /^(?:NEXT_PUBLIC_(?:SUPABASE_URL|SUPABASE_ANON_KEY|APP_URL)|OWNER_(?:EMAIL|USER_ID)|REELRADAR_(?:DISPATCH_SECRET|OWNER_USER_ID)|SUPABASE_(?:URL|SERVICE_ROLE_KEY)|INTERNAL_CRON_SECRET|APIFY_(?:API_TOKEN(?:_[2-5])?|ACCOUNT_ID|REEL_ACTOR_RESOURCE_ID|PROFILE_ACTOR_RESOURCE_ID|WEBHOOK_SHARED_SECRET)|ELEVENLABS_(?:API_KEY|WEBHOOK_ID|WEBHOOK_SECRET)|EXPECTED_SUPABASE_ORIGIN)=.+$/.test(lines[i])) {
        findings.push(`${relative}:${i + 1}: populated private/project configuration in template`);
      }
      for (const [label, pattern] of patterns) {
        // Exact, documented invalid userinfo fixtures exercise URL rejection.
        // Other credential-bearing URLs, even in tests, are still rejected.
        const line = label === 'credential-bearing URL' && (relative.startsWith('tests/') || relative.startsWith('supabase/functions/tests/'))
          ? lines[i].replaceAll(/https?:\/\/user:(?:password|pass)@/g, 'https://') : lines[i];
        if (pattern.test(line)) findings.push(`${relative}:${i + 1}: ${label}`);
      }
    }
  }
}
 walk(root);
 return { findings, count };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const { findings, count } = scanDistribution(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
if (findings.length) {
  // Never print matching values, only paths, line numbers and rule names.
  console.error(findings.join('\n'));
  process.exitCode = 1;
} else console.log(`Public distribution check passed (${count} files). No recognized secret patterns or private artifacts found; manual review is still required.`);
}

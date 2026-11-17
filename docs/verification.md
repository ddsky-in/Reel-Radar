# Public distribution verification

Prepared on November 17, 2026. This record concerns this standalone source distribution; it does not certify a hosted deployment or live provider account.

## Privacy and isolation

- Only source, migrations, tests, synthetic demo assets and public documentation were copied.
- Local `.env` files, the private transfer key, original `.git`, account exports, captured media, operational reports and screenshots were excluded.
- Seven configured private values were compared against distributable file contents without printing their values: zero matches.
- Twenty-two candidate UUID/email identifiers from private operational documentation were compared against distributable files: zero matches.
- Legacy audit fixture identifiers were replaced consistently with synthetic identifiers. Active webhook configuration derives from the installation's Supabase origin; database wake routing reads the installation's Vault setting.
- At preparation, this directory had independent empty Git history and no remote. No existing branch, tag, commit author record or release artifact was copied. Subsequent publication starts a new history containing only this sanitized distribution.

## Local checks

- Independent dependency installation: `npm ci --ignore-scripts --offline` passed.
- `npm audit --json`: zero reported vulnerabilities at preparation time; advisory coverage can change.
- `npm run check:public`: passed. The heuristic scan reports file/line locations without echoing values. It does not prove the absence of arbitrary secrets or personal information.
- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed, including TypeScript and page generation. Next.js reported the expected warning that the parent repository's lockfile is outside this independent Git root.
- `npm test -- --maxWorkers=2` completed 143 files / 2,662 tests: 142 files passed; one file had four failures caused by its missing synthetic Vault origin. After correcting that fixture, `npm test -- --maxWorkers=1 tests/spending-database.test.ts` passed all 51 tests in the affected file. No failures remain from that run after the focused correction; the full suite was not repeated after this fixture-only change.
- The final public-distribution guard rerun passed all seven tests, including the later uppercase-environment/tool-credential protection.

The first configuration regression pass caught malformed SQL introduced while removing fixed deployment URLs and operator error-order expectations. Those were corrected. Database wake fixtures now explicitly provide a synthetic Vault project origin; the affected spending/database file passed all 51 tests on rerun.

## Boundaries

The Windows sandbox prevented Vitest child-process startup (`EPERM`); tests and the local production build ran with approved process access outside that sandbox. No provider collection, enabled Cron, deployment or GitHub push was performed.

Deno was unavailable on PATH. Separate Deno and disposable hosted Supabase/PostgREST verification remains an installation/release step. PGlite emulates Auth/Vault/network facilities and cannot certify hosted behavior. The public distribution contains no production credentials or account data with which to perform live acceptance checks.

Before publication, review the [publication checklist](publishing.md), choose the intended GitHub repository/default branch, set a public-safe author identity, and enable repository security controls. The MIT license applies to original project source; dependencies and third-party content retain their own rights.

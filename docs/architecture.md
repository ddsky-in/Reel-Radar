# Architecture

`src/app` contains Next.js pages and API routes. `src/components` contains the research UI. `src/lib/types.ts` defines shared contracts; `src/lib/metrics.ts` owns metric calculations.

`src/lib/server` implements authentication, request validation and repositories. Local demo persistence is separate from Supabase persistence. `src/lib/supabase` contains server and realtime clients. The server validates the Auth user and checks both configured owner ID and email. Database RLS and RPC authorization enforce owner/workspace isolation independently.

`supabase/migrations` contains ordered schema, security, queue, billing and read-model changes. Apply all migrations in filename order on a fresh disposable instance; these public-distribution migrations must not be replayed over a separately maintained deployment's history. Public RPC wrappers use private implementations where required by the latest security migration.

`supabase/functions` contains optional collection and transcription workers. They run in Deno, separately from the Next.js runtime. Long work is queued with leases, reservations and reconciliation; the frontend never receives privileged provider credentials.

Three legacy diagnostic/control functions are retired in `supabase/config.toml`. Their historical implementation modules contain sanitized synthetic identifiers retained for regression coverage, not usable account/job records. Keep the configured retired entrypoints; do not deploy their historical `index.ts` files as operational tools.

`tests` includes UI/unit tests and embedded PostgreSQL tests. `supabase/tests/database` includes pgTAP checks. Operator scripts in `scripts` are optional: some issue authenticated requests or change configuration when explicitly invoked. They are never part of demo startup or the default verification commands.

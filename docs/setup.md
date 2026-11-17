# Setup

Start with the synthetic loopback demo in the README. Production setup requires your own accounts and a fresh database. No secrets, owner, data exports or schedules are supplied.

## Web application

Use `.env.example` as a variable reference. Copy only the web settings into your ignored `.env.local` or hosting secret store:

- `NEXT_PUBLIC_SUPABASE_URL`: your project HTTPS origin.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: a browser-safe anonymous or publishable key; never service-role/secret credentials.
- `NEXT_PUBLIC_APP_URL`: the exact application HTTPS origin.
- `OWNER_USER_ID` and `OWNER_EMAIL`: the same user provisioned as database owner.
- `REELRADAR_DISPATCH_SECRET`: a server-only credential matching the worker's base `INTERNAL_CRON_SECRET`.
- `DEMO_MODE=false`, `ALLOW_LOCAL_DEMO=false`, `SCRAPING_ENABLED=false`.

Install with `npm ci`, build with `npm run build`, and run with `npm start`. The supplied start command binds to loopback; configure your host/reverse proxy explicitly for public access. Missing configuration denies production access.

## Database and authentication

Use a disposable Supabase project first. Install a compatible Supabase CLI and consult its current `--help` before applying migrations; CLI targeting behavior differs between versions. Apply every file in `supabase/migrations` in filename order. Supabase-specific extensions include Vault, pg_cron and pg_net; embedded tests emulate some services and do not validate a hosted stack.

Create the owner in Supabase Auth, disable public signup, and configure permitted application URLs. With service-role authorization, invoke `public.provision_owner` with `p_owner_user_id` set to that Auth UUID. Set the web owner ID/email and worker owner ID consistently. Do not expose provisioning credentials to the browser. Confirm anonymous and other authenticated users are denied before loading any real data.

## Optional workers

Use the worker section of `.env.example` as a reference for Supabase Edge Function secrets. The web hosting environment does not automatically configure worker secrets. See the official [Edge Function secrets guide](https://supabase.com/docs/guides/functions/secrets).

Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REELRADAR_OWNER_USER_ID`, a strong `INTERNAL_CRON_SECRET`, and separate webhook credentials in the worker runtime. Keep provider/transcription validation gates false until independently validated. Do not place real secrets in examples, SQL files or command arguments saved to shell history.

Provider contracts are installation-specific. Configure your own Actor resource IDs, input/output mappings and authorized account slots. Validate the provider contract, authoritative usage/pricing, provider-enforced charge caps, application budgets and uncertain-charge handling before enabling any paid run. Transcription webhook setup derives its callback from the worker's HTTPS `SUPABASE_URL`.

Database transcript wake functions read the installation's HTTPS project origin from the Vault secret named `reelradar_edge_url`. Configure that value securely through your own project; missing/invalid configuration does not send a wake. Vault credentials stay separate from the source; see the official [Vault guide](https://supabase.com/docs/guides/database/vault).

The optional operator CLIs read ignored `.env.local` and `.env.worker.local`. Set `EXPECTED_SUPABASE_ORIGIN` in `.env.worker.local` to the exact intended HTTPS project origin. This explicit destination pin must match the web Supabase URL. Diagnostics may contact providers and update usage snapshots; dispatch/reconciliation may start paid work. Invoke these scripts only with explicit authorization and reviewed settings.

Function gateway JWT settings in `supabase/config.toml` rely on independent handler authentication. Preserve the retired entrypoints for legacy diagnostic/control functions. Verify Deno checks, authentication denials, webhook signatures, owner/workspace boundaries and billing behavior in your disposable environment before deploying.

## Scheduling and data

No schedule is installed by default. `supabase/cron/install.disabled.sql` is a commented template. Installing Cron, enabling live collection, deploying or publishing are separate operator actions. Confirm UTC schedule times and deduplication boundaries before enabling automation.

Back up any valuable data before migrations or destructive cleanup. Do not import a private installation's database into a public repository. Current summaries, snapshots and saved research belong in each operator's protected database, not in source control.

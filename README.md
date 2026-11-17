# ReelRadar

Self-hosted Instagram competitor research with workspaces, Reels and carousel exploration, bookmarks, notes, CSV imports, and optional collection and transcription workers.

Built with Next.js, React, TypeScript, Tailwind CSS and Supabase. Licensed under [MIT](LICENSE). This project is independent of Instagram and Meta.

## Try it locally

Use Node.js 22 or newer and npm. From this directory:

```sh
npm ci
```

Copy `.env.example` to `.env.local`. For the synthetic local demo, set:

```dotenv
DEMO_MODE=true
ALLOW_LOCAL_DEMO=true
SCRAPING_ENABLED=false
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

```sh
npm run dev
```

Open [localhost:3000](http://localhost:3000). The demo uses synthetic data, restricted to loopback requests, with no external provider calls. It is not verified Instagram data. No API keys or accounts are required for this demo. Never enable demo flags on a public host.

## What is included

- Workspace-based creator research, bulk add and CSV preview.
- Reels and carousels with filters, metric ranges, freshness and source links.
- Workspace-specific saves, tags, notes and completion state.
- Owner authentication, workspace authorization, RLS and database regression tests.
- Optional gated Apify collection and ElevenLabs transcription workers.
- Transactional budget reservations, uncertain-charge holds and reconciliation.

This is a single-owner installation with multiple workspaces, not a public multi-tenant SaaS. Each installation needs its own accounts, database and credentials. Missing production authentication/configuration fails closed. Provider calls and schedules are not enabled by setup.

## Metrics

Calculations live in `src/lib/metrics.ts`; shared contracts are in `src/lib/types.ts`.

- Follower outlier: `(views + likes + comments) / followers`; all values must be known and followers positive.
- Engagement: `100 × (likes + comments) / views`; views must be positive and likes/comments known and nonnegative.
- Unknown, hidden and zero remain distinct. Qualification uses unrounded values.
- Timestamps are stored in UTC and displayed in Asia/Kolkata. Staleness starts after 48 hours.

## Verification

```sh
npm run check:public
npm run lint
npm run typecheck
npm test
npm run build
```

Tests include embedded PostgreSQL through PGlite with emulated Supabase Auth. These do not replace hosted Supabase, Deno or concurrent-server integration verification. `npm start` serves a production build on loopback; stop it before rebuilding. The build explicitly uses Webpack for Windows compatibility.

Read the [setup guide](docs/setup.md), [architecture](docs/architecture.md), [contribution guide](CONTRIBUTING.md), [security policy](SECURITY.md), [third-party notices](THIRD_PARTY_NOTICES.md), [verification record](docs/verification.md) and [publication checklist](docs/publishing.md).

This distribution contains source, schema and synthetic fixtures. It contains no private deployment history, customer/account export, captured media or production screenshots. Real provider costs stay unknown until authoritative billing metadata is reconciled. Operators are responsible for permissions, platform terms and rights to any collected or transcribed content.

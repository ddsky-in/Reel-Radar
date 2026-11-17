# ReelRadar development

Use npm. Run npm run lint, npm run typecheck, npm test and npm run build before delivery.
Match TypeScript types in src/lib/types.ts. Keep metric calculations centralized in src/lib/metrics.ts.
Demo data is synthetic; never claim it is verified Instagram data. No external scraper calls by default.
Production must fail closed without Supabase/auth configuration. Never place privileged secrets in NEXT_PUBLIC variables.
All data queries/mutations require owner/workspace authorization. No live scraping, enabled Cron, deployment, or pushes without explicit approval.
Keep provider costs unknown until authoritative billing metadata has been reconciled. Reserve budgets transactionally.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

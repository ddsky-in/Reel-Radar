# Contributing

Use Node.js 22+ and npm. Follow the README's synthetic demo setup. Start with an issue describing the problem or proposed behavior; small fixes can go directly to a pull request.

Keep changes focused. Use shared TypeScript contracts in `src/lib/types.ts` and centralize metric calculations in `src/lib/metrics.ts`. Read the installed Next.js guides in `node_modules/next/dist/docs/` before changing framework behavior.

Preserve owner/workspace checks, RLS, production fail-closed behavior, disabled provider gates and transactional budget reservations. Do not treat unknown provider costs as zero. Never introduce account rotation to evade limits, provider calls during tests, enabled Cron, or secrets in browser configuration.

Use synthetic fixtures only. Do not attach production screenshots, `.env` files, account identifiers, exports, session cookies or credential-bearing URLs. Report vulnerabilities through [SECURITY.md](SECURITY.md).

Before submitting, run:

```sh
npm run check:public
npm run lint
npm run typecheck
npm test
npm run build
```

Explain the user-visible change, the reason and verification results in the pull request. Add regression coverage for security, authorization, billing or meaningful behavior changes. SQL changes must be tested against a disposable database; never use a live account for default verification. Worker TypeScript requires separate Deno verification where applicable.

Run the distribution guard in a clean checkout without local `.env` files or private/generated artifacts. It intentionally rejects those files even when Git ignores them. Keep your development credentials in a secure location outside any copy you plan to publish.

By contributing, you agree to license your contribution under the project's MIT license and confirm that you have permission to submit it.

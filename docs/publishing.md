# Publishing a clean public repository

Publish only this directory's contents as a new repository with fresh history. This distribution was prepared in an independent Git repository on `codex/open-source`; its publication history starts with the sanitized source. Do not make the parent private repository public, copy its `.git`, or push its existing branches/tags. Removing secrets from the current tree cannot sanitize earlier commits, author emails, releases or GitHub artifacts.

1. Use a clean distribution checkout without local `.env` files, exports or private artifacts. Run `npm ci`, `npm run check:public`, `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` from this directory. Record limitations separately from passing checks. Store development credentials securely outside the publication copy.
2. Review staged files, including every binary. This distribution intentionally excludes private screenshots, reports, database exports and live configuration. Publish no local `.env` except the blank `.env.example`.
3. Review the MIT license choice, third-party notices and contribution/security policies. Ensure you have rights to publish the code and assets.
4. Work in this independent repository, or copy only its distributable source to a standalone location and initialize fresh history there. Set a public-safe Git author identity (for example your GitHub no-reply address) before the first commit. Never run publication commands from the parent directory. Choose the desired public default branch before the first push.
5. After explicit publication approval, commit only reviewed files and push to a new GitHub repository. Review its public name and owner first. Leave the existing private repository untouched.
6. Enable GitHub secret scanning/push protection, private vulnerability reporting, dependency alerts, and branch protection/rulesets requiring the verification workflow. Restrict write access and protect the default branch. Availability of repository security controls depends on GitHub settings.
7. Review Actions logs/artifacts, issue attachments, releases and any Pages/site settings before making them public. Never configure deploy/provider secrets for fork pull requests. The supplied workflow needs no account credentials.

`npm run check:public` scans source files and blocks common secret patterns, unsafe artifacts and privileged browser variable names. Its file/line-only diagnostics deliberately omit matched values. Review is still required for personal data, binary assets and secrets without recognizable formats.

For dependency checks with registry access, run `npm audit` and review the result rather than applying forced upgrades blindly. Full Deno/hosted Supabase verification and dependency advisory reconciliation must be recorded before describing a deployed installation as verified.

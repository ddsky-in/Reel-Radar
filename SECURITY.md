# Security policy

Security fixes target the latest default-branch source. No older release support is promised.

Do not disclose vulnerabilities or credentials in public issues or pull requests. After GitHub private vulnerability reporting is enabled, use the repository's **Security → Report a vulnerability** form. If that form is unavailable, open a minimal issue requesting a private reporting channel, without exploit details, account identifiers or secrets. No response-time guarantee is currently offered.

Include affected versions, a minimal synthetic reproduction, impact and suggested remediation through the private channel. Never test against installations you do not own or have permission to assess.

## Deployment boundaries

- Production requires configured Supabase and owner authentication. Workspaces are scoped to the configured owner.
- Only browser-safe Supabase keys belong in `NEXT_PUBLIC_*`. Service-role keys, provider tokens, internal dispatch secrets and webhook credentials stay server-side.
- Edge Functions with gateway JWT verification disabled authenticate within their handlers. Keep these checks intact.
- Demo access is local-only and synthetic. Provider operations and schedules need separate explicit configuration and authorization.
- Provider costs remain unknown until authoritative billing reconciliation; reservations and uncertain holds must not be bypassed.

If a secret was exposed, revoke/rotate it at the provider, invalidate affected sessions as appropriate, and review logs before publishing. Deleting the current file does not remove Git history, tags, releases, forks or cached artifacts. Create a clean public repository from this distribution rather than making an existing private repository public.

`npm run check:public` checks the distributable files for common credential patterns and forbidden artifacts. It is a defense-in-depth heuristic, not a security audit or a guarantee that arbitrary secrets or personal data are absent.

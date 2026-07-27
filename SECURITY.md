# Security policy

> **Applies to:** umans-gate v0.4.7 · **Last updated:** 2026-07-27

## What is the security reporting process?

umans-gate uses GitHub's private security vulnerability reporting with a 48-hour acknowledgment SLA on confirmed reports. Do NOT open a public GitHub issue for security vulnerabilities. Instead, use GitHub's private advisory system, and you will receive a response within 48 hours.

## Reporting a vulnerability

This document describes how to report security vulnerabilities in umans-gate and the 48-hour acknowledgment SLA on confirmed reports.

**Do NOT open a public GitHub issue.**

Instead, use **GitHub's private security vulnerability reporting**:

1. Go to [github.com/codegiveness/umans-gate/security/advisories/new](https://github.com/codegiveness/umans-gate/security/advisories/new)
2. Click **"Report a vulnerability"**
3. Fill in the advisory form with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

You will receive a response within 48 hours. If the vulnerability is confirmed,
we will publish a fix and credit you in the release notes.

## Scope

This policy covers the `umans-gate` package as published on npm and the source
code in this repository.

## Out of scope

- Vulnerabilities in third-party dependencies (report to upstream maintainers)
- Issues in the dashboard that require existing access to the inspector
- Theoretical attacks without a concrete proof of concept

## Supported versions

| Version | Supported |
|---------|-----------|
| latest  | ✅        |
| < 1.0   | ❌        |

## npm supply-chain security

umans-gate follows npm supply-chain best practices:

### Provenance

All npm packages are published with **npm provenance attestation** via
`npm publish --provenance`. Every published artifact is
cryptographically linked to the exact GitHub Actions workflow run and
commit that built it.

To verify a package before installing:

```bash
npm audit signatures umans-gate
```

You can also verify provenance on the npm registry page:
https://www.npmjs.com/package/umans-gate

### Publishing authentication

npm publishing currently uses a **scoped `NPM_TOKEN` secret** stored in
GitHub Actions. The token is scoped to publish-only permissions for the
`umans-gate` package (and platform sub-packages).

> **Migration target:** npm [trusted publishing](https://docs.npmjs.com/guides/open-source-from-ci)
> via OIDC eliminates the need for any long-lived token. Once configured
> on the npm side, `NODE_AUTH_TOKEN` can be removed entirely and publishing
> will use a short-lived OIDC-issued token. This is the recommended path
> and tracked as a security improvement.

Provenance attestation (`--provenance`) is separate from authentication
and already uses **short-lived OIDC tokens** via `id-token: write`; no
secret is needed for provenance.

### Automated dependency updates

[Dependabot](https://docs.github.com/en/code-security/dependabot) checks
for outdated dependencies weekly (`npm` and `github-actions` ecosystems).
Security advisories trigger immediate PRs.

### CI/CD hardening

- All GitHub Actions workflows run with `persist-credentials: false`
- Publish workflows require `id-token: write` (for provenance) and
  `contents: write` (for GitHub Releases); no other elevated permissions
- No secrets are logged or passed to build scripts
- Branch protection rules **should** require passing CI before merge (see [Branch protection](#branch-protection) checklist below)

## Account security

### Two-factor authentication (2FA)

- **npm publisher account**: 2FA **must** be enabled on the npm account that
  publishes `umans-gate` and platform packages. Both TOTP and hardware security
  keys are acceptable. Disable legacy recovery codes if a hardware key is used.
- **GitHub organization admins**: all members with admin access to
  `codegiveness/umans-gate` **must** have 2FA enabled on their GitHub account.
  GitHub's "require 2FA for organization members" setting should be turned on.
- **npm access tokens**: prefer granular access tokens scoped to specific
  packages with publish-only permissions. Rotate tokens quarterly. The current
  `NPM_TOKEN` secret is scoped and used only in CI/CD, never in local dev.

### Rotation and revocation

- Rotate `NPM_TOKEN` immediately if any credential exposure is suspected
- Review npm publish access quarterly; remove unused collaborators
- Review GitHub repository collaborator access quarterly

## GitHub repository security

### Branch protection

The `main` branch **should** have the following protection rules enabled
via GitHub Settings → Branches:

- [ ] Require pull request reviews before merging (≥1 approval)
- [ ] Require status checks to pass before merging (CI must be green)
- [ ] Require branches to be up to date before merging
- [ ] Require linear history
- [ ] Do not allow force pushes
- [ ] Do not allow deletions

To configure via `gh` CLI:

```bash
gh api repos/codegiveness/umans-gate/rules/branches/main \
  -X PUT \
  -f "required_status_checks[strict]=true" \
  -f "required_pull_request_reviews[required_approving_review_count]=1" \
  -f "enforce_admins=true" \
  -f "restrictions=" \
  -f "required_linear_history=true" \
  -f "allow_force_pushes=false" \
  -f "allow_deletions=false"
```

### Code review

- All changes go through pull requests; no direct commits to `main`
- [CODEOWNERS](.github/CODEOWNERS) rules automatically request review
  from `@codegiveness` for all paths

### Security features enabled

- **Private vulnerability reporting**: enabled
- **Dependabot security updates**: enabled
- **Dependabot version updates**: enabled (weekly)
- **Code scanning**: enabled via [CodeQL](.github/workflows/codeql.yml) (weekly + on push/PR)
- **Secret scanning**: (enabled by GitHub for public repositories)
- **Commit signature verification**: recommended for all contributors

## Disclosure timeline

1. Vulnerability reported privately
2. Acknowledged within 48 hours
3. Fix developed and validated
4. Patch release published to npm
5. Public advisory published after users have had time to update
6. Reporter credited in release notes

## Security checklist for contributors

Before submitting a PR, verify:

- [ ] No secrets, API keys, or tokens in code or config
- [ ] No `eval()`, `Function()`, or `child_process.exec()` with user input
- [ ] No SQL injection vectors (use parameterized queries)
- [ ] No XSS vectors in dashboard (React escapes by default, but check `dangerouslySetInnerHTML`)
- [ ] No prototype pollution (validate JSON input shapes)
- [ ] Dependencies are pinned to safe versions (check `npm audit`)
- [ ] No new `as any`, `@ts-ignore`, or `@ts-expect-error` type suppressions

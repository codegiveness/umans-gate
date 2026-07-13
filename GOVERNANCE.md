# Governance

## Overview

umans-gate is a community-driven open-source project governed by its
maintainers. This document describes how decisions are made and how the
project is structured.

## Decision-Making Process

### Consensus-first

Most decisions are made by consensus among maintainers. A proposal is
discussed in a GitHub issue or discussion thread until maintainers reach
agreement.

### Maintainer Vote

When consensus cannot be reached, a formal vote may be called. Each maintainer
gets one vote. A simple majority (more than 50% of voting maintainers) is
required to approve. Ties result in the proposal being rejected or deferred.

### Lead Maintainer

The lead maintainer has the tie-breaking vote and is responsible for making
final calls on:

- Release timing and versioning
- Architectural direction when consensus is not reached
- Security disclosure response coordination

## Roles

### Contributor

Anyone who submits a pull request, issue, or discussion contribution.
Contributors are subject to the [Code of Conduct](CODE_OF_CONDUCT.md).

### Maintainer

Has push access to the repository. Responsibilities include:

- Reviewing and merging PRs
- Triaging issues
- Enforcing code quality standards
- Updating CHANGELOG and releases

Maintainers are expected to remain active. Inactive maintainers (no
contributions for 3+ months) may be moved to emeritus status.

### Lead Maintainer

Responsible for the overall health and direction of the project. The lead
maintainer role transitions when the current lead steps down or is replaced
by maintainer consensus.

## Release Process

1. A maintainer proposes a release in a GitHub issue
2. Maintainers confirm the release scope (CHANGELOG, version bump)
3. The release PR updates `package.json` version and `CHANGELOG.md`
4. The PR is merged to `main`
5. A `v*` tag is pushed, triggering the publish workflow
6. The release is announced in GitHub Releases

## Security Disclosures

Security vulnerabilities are handled privately. See [SECURITY.md](SECURITY.md)
for the disclosure process. Security fixes take priority over all other work.

## Changes to This Document

Changes to governance require maintainer consensus via a PR. Community input
is welcomed via comments on the PR.

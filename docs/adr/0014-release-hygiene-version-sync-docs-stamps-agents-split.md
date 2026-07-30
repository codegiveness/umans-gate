# ADR-0014: Release hygiene, version sync, docs stamps, AGENTS.md public split

**Date:** 2026-07-25
**Status:** Accepted
**Applies to:** umans-gate v0.3.19+

## Context

umans-gate shipped v0.3.18 while several public-facing files still
claimed older versions. `ROADMAP.md` stamped v0.3.18 in its header but
listed the current state as v0.1.3 and described already-shipped
features as future work. Five other docs files
(`ARCHITECTURE.md`, `BENCHMARKS.md`, `PRODUCT.md`, `TROUBLESHOOTING.md`,
`proxy-modifications.md`) carried v0.1.4 stamps, 14 versions behind.
`AGENTS.md` and the `docs/adr/` directory were both gitignored, so
contributor guidance and 14 ADRs were invisible to the public. Stale
commit messages (e.g. `release: v0.1.8`) remained in git history.

## Decisions

### 1. No git history rewrite

Commit messages like `release: v0.1.8` and `release: v0.3.13 ,  full
dependency stack upgrade` remain in git history unmodified.

**Rationale:** These messages are historically accurate. Those releases
happened. Rewriting history with `filter-branch` would change every commit
hash, break GitHub Release references, force all collaborators to re-clone,
and destroy the audit trail. The CHANGELOG already documents release
history accurately; the git log is the raw, immutable audit trail.

### 2. ROADMAP.md full body rewrite

Rewrote the ROADMAP.md body to reflect v0.3.18 reality. All shipped
features (vision handoff, concurrency gate, rate limiter, connection warmer,
usage tracking, dashboard, service persistence, npm distribution, release
automation) moved to "Current State" section. Only genuinely future work
remains in "Near-Term", "Mid-Term", and "Long-Term" sections.

**Rationale:** A roadmap that lists shipped features as "future work"
is fiction. It damages credibility more than having no roadmap. The
full rewrite makes the document truthful and useful.

### 3. Extend update-docs.ts to stamp all docs/*.md

Generalized the doc stamp updater from ROADMAP.md-only to all `docs/*.md`
files with `**Applies to:**` stamps. The script now scans
`docs/ARCHITECTURE.md`, `docs/BENCHMARKS.md`, `docs/PRODUCT.md`,
`docs/TROUBLESHOOTING.md`, `docs/proxy-modifications.md`, and `ROADMAP.md`
on every release, updating version + date stamps automatically.

**Rationale:** Manual stamp updates led to 14 versions of drift. Making
the script handle all docs prevents future drift permanently.

### 4. AGENTS.md public / CLAUDE.md private split

`AGENTS.md` is now tracked (public) and contains project facts useful to
any contributor: paths, architecture, config, dev workflow, code style,
SOLID principles, testing, release process, and common mistakes.

`CLAUDE.md` remains gitignored (private) and contains AI-agent behavioral
guidelines: think-before-coding, simplicity-first, surgical-changes,
goal-driven-execution, and agent skill configurations.

**Rationale:** AGENTS.md had mixed content. The project facts (architecture,
config, testing, common mistakes) are useful to public contributors. The
AI behavioral rules (caveman mode, think-before-coding heuristics) are
internal tooling config. Splitting them makes the public guide clean and
keeps the private config private. No new file needed; CLAUDE.md already
exists and is already injected via `opencode.json`.

### 5. CHANGELOG is append-only audit log

Historical CHANGELOG entries that mention old versions (v0.1.2, v0.1.3,
v0.3.1, v0.3.2) are left intact.

**Rationale:** The CHANGELOG documents what happened at each version. An
entry saying "v0.1.2 was published via the now-deleted [mechanism]" is
factually correct context. Editing historical entries to "clean them up"
makes the log untrustworthy. Only new entries are added going forward.

## Consequences

- Public-facing docs are now accurate: ROADMAP, docs/*.md, AGENTS.md,
  and docs/adr/ all reflect v0.3.18 reality.
- No future version drift: `update-docs.ts --update` runs on every
  release, stamping all docs automatically.
- ADRs are public: 14 existing ADRs (ADR-0001 through ADR-0013) are
  now tracked in git, providing decision context to public contributors.
- AGENTS.md is a clean public guide: contributors see project facts
  without AI-tooling noise.
- Git history is intact: commit messages remain as-is, preserving
  the full audit trail.

## Implementation

- `.gitignore`: removed `AGENTS.md` and `docs/adr/` lines
- `AGENTS.md`: rewritten as public contributor guide
- `ROADMAP.md`: body rewritten to reflect shipped features as Current State
- `scripts/update-docs.ts`: `updateDocStamps()` generalized to all docs/*.md
- `docs/adr/`: directory now tracked, 14 existing ADRs published as-is

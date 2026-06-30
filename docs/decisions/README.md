# Architecture Decision Records

This directory records significant technical decisions for umans-gate. We use the Markdown Architecture Decision Record (MADR) format because it's lightweight, version-control friendly, and easy to read in a plain-text editor.

## MADR format

Each ADR file follows this structure:

```markdown
# <number>. <short title>

## Context

What problem or question needed a decision. Include constraints, options considered, and what would happen if no decision were made.

## Decision

What we decided. State the choice clearly. Avoid justification here; keep that for Context and Consequences.

## Consequences

What the decision means for the project. Include positive effects, tradeoffs, and any follow-up work the decision creates.

## Status

Accepted | Proposed | Deprecated | Superseded by <ADR number>
```

## File naming

Use a sequential zero-padded number and a lower-case hyphenated title:

```text
0001-why-rust.md
0002-why-axum.md
```

## How to add a new ADR

1. Pick the next number in the sequence.
2. Copy the template above into a new file named `<number>-<short-title>.md`.
3. Fill in Context, Decision, Consequences, and Status.
4. Keep the file under 200 lines.
5. Open a pull request for review.

Status should start as `Proposed`. Once the team agrees, change it to `Accepted`. If a later ADR overrides it, mark the older one `Superseded by <number>`.

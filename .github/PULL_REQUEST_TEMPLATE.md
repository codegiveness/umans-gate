## Summary

Brief description of what this PR changes and why.

## Changes

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality not to work as expected)
- [ ] Documentation update
- [ ] Refactor / code quality improvement

## Testing

Describe how you tested these changes. Include:

- Which test suites you ran (`bun run test`, `bun run test:dashboard`, `bun run test:all`)
- Any manual testing performed (e.g., proxying real LLM traffic, dashboard verification)
- Whether dashboard builds successfully (if dashboard files changed)

## Checklist

- [ ] My code follows the project's style guidelines (Biome: 2-space indent, double quotes, semicolons)
- [ ] I have run `bun run lint` and fixed any issues
- [ ] I have run `bun run typecheck` with no errors
- [ ] I have run `bun run test:all` and all tests pass
- [ ] I have updated documentation where necessary
- [ ] My changes generate no new TypeScript errors
- [ ] No `as any`, `@ts-ignore`, or `@ts-expect-error` introduced
- [ ] New behavior has covering tests
- [ ] The diff is minimal and focused, with no unrelated formatting, refactoring, or dead code
- [ ] SOLID principles respected (single responsibility, open/closed, etc.)
- [ ] If dashboard files changed: `cd dashboard && bun run build` succeeds

## Breaking changes

If this PR introduces breaking changes, describe:
- What breaks and why
- Migration path for existing users
- Whether `CHANGELOG.md` has been updated under `[Unreleased]`

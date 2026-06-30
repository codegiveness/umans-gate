# Contributing to umans-gate

Thank you for helping make umans-gate better! This guide covers the small set of conventions we follow so we can review and merge your work quickly.

## Workflow

We use a **fork-and-pull-request** workflow:

1. Fork the repository on GitHub:
   <https://github.com/codegiveness/umans-gate>
2. Clone your fork locally.
3. Create a short-lived feature branch from `main`:
   ```bash
   git checkout -b my-feature
   ```
4. Make your changes, commit them, and push the branch to your fork.
5. Open a pull request against the `main` branch of `codegiveness/umans-gate`.

### PR-only workflow

All changes must land through a pull request. Direct pushes to `main` are disabled by branch protection. Even maintainers work in feature branches and open pull requests so that CI runs and another pair of eyes reviews the change.

Please keep pull requests focused. A PR that does one thing is much easier to review than a grab-bag of unrelated fixes.

## Conventional Commits

We use [Conventional Commits](https://www.conventionalcommits.org/) to keep the changelog and release notes predictable. Commit messages should look like:

```text
feat: add per-provider timeout overrides
fix: correct queue permit release on client disconnect
docs: update config field reference
test: add integration test for SSE streaming
refactor: extract limiter state into separate module
```

- Use a lowercase type.
- Keep the summary line under 72 characters.
- Add a body if the change needs explanation.

## Before Submitting

Please run the standard checks locally. They are the same checks CI will run, so catching issues early saves everyone time.

```bash
# Formatting
 cargo fmt --all -- --check

# Linting
 cargo clippy --workspace --all-targets -- -D warnings

# Tests
 cargo test --workspace
```

Fix any failures before pushing. If `clippy` suggests a change that makes the code worse, mention it in the PR description and we can discuss it.

## Code Style

- Follow the existing Rust style.
- Let `rustfmt` and `clippy` be the source of truth.
- Prefer clarity over cleverness.
- Add tests for new behavior and keep existing tests passing.

## Reporting Issues

Found a bug? Please open an issue using one of the provided templates and include steps to reproduce, expected behavior, and actual behavior. Security issues should follow the process in [SECURITY.md](./SECURITY.md) instead of a public issue.

## License

By contributing, you agree that your contributions will be licensed under the MIT license.

## Questions?

Open a discussion issue or reach out in the pull request. We are happy to help.

# 7. Why cargo-dist for Releases

## Context

umans-gate is meant to be installed quickly on Linux, macOS, and Windows without requiring a Rust toolchain on the target machine. We need cross-platform builds, installers, and GitHub Releases integration that does not rely on hand-written CI scripts.

We considered:

- **Manual GitHub Actions matrix**: flexible, but each target and installer becomes a bespoke workflow that is easy to break.
- **cargo-dist**: purpose-built for shipping Rust binaries. Generates shell and PowerShell installers, builds for selected target triples, and produces GitHub Releases automatically.
- **Docker-based builds**: good for Linux containers, but does not naturally produce native macOS or Windows executables.

## Decision

We will use cargo-dist to build release binaries and publish GitHub Releases.

## Consequences

- One `Cargo.toml` metadata block configures the target triples: `aarch64-apple-darwin`, `aarch64-unknown-linux-gnu`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, and `x86_64-pc-windows-msvc`.
- cargo-dist generates shell and PowerShell installers. Users can install with curl or irm without knowing Rust.
- The release profile enables thin LTO, symbol stripping, and a single codegen unit, producing small, fast binaries.
- CI boilerplate is generated and kept in sync by cargo-dist, reducing the risk of drift between platforms.
- We still have to trust cargo-dist's templates and review changes when the tool upgrades.

## Status: Accepted

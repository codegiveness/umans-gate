# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- TypeScript rewrite of the capture proxy (modular `src/` structure)
- Vite + React + Tailwind + shadcn/ui dashboard
- `createProxyServer()` programmatic API
- Biome for linting and formatting
- GitHub Actions CI (matrix: ubuntu + macOS, Bun 1.1 + latest)
- npm publish workflow with Sigstore provenance
- Issue templates, PR template, dependabot config
- `.env.example` documenting all environment variables
- MIT license

### Changed
- Single-file `capture.js` → modular TypeScript in `src/`
- Vanilla JS dashboard → React + shadcn/ui dashboard
- Test helpers reference new entry point (no more `proxy.js`/`capture-only.js`)

### Fixed
- Broken tests that spawned non-existent `proxy.js` file
- Runtime artifacts (`capture.db*`) now gitignored

## [0.0.1] - 2025-07-02

### Added
- Initial Bun-based LLM capture proxy
- Anthropic cache_control TTL stamping
- Vanilla JS inspector dashboard with WebSocket live updates
- SQLite storage with ring buffer (WAL mode)

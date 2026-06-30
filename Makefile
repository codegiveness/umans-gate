.PHONY: help build test lint fmt fmt-check clean css watch-css release install run

# Default target when `make` is invoked with no arguments.
.DEFAULT_GOAL := help

# Use the PowerShell build script on Windows, otherwise the Bash script.
ifeq ($(OS),Windows_NT)
	CSS_RUNNER := powershell -File
	CSS_SCRIPT := scripts/build-css.ps1
else
	CSS_RUNNER := bash
	CSS_SCRIPT := scripts/build-css.sh
endif

help:
	@echo "Available targets:"
	@echo "  build      Build the workspace (debug)"
	@echo "  test       Run workspace tests"
	@echo "  lint       Run Clippy lints with warnings as errors"
	@echo "  fmt        Format all Rust code"
	@echo "  fmt-check  Check Rust formatting"
	@echo "  clean      Clean Cargo build artifacts and static/app.css"
	@echo "  css        Build static/app.css with Tailwind CSS"
	@echo "  watch-css  Build static/app.css with Tailwind CSS in watch mode"
	@echo "  release    Build the workspace in release mode"
	@echo "  install    Install the umans-gate CLI binary locally"
	@echo "  run        Run the umans-gate CLI via cargo"

build:
	cargo build --workspace

test:
	cargo test --workspace

lint:
	cargo clippy --workspace --all-targets -- -D warnings

fmt:
	cargo fmt --all

fmt-check:
	cargo fmt --all -- --check

clean:
	cargo clean && rm -f static/app.css

css:
	$(CSS_RUNNER) $(CSS_SCRIPT)

watch-css:
	$(CSS_RUNNER) $(CSS_SCRIPT) --watch

release:
	cargo build --workspace --release

install:
	cargo install --path crates/umans-gate-cli

run:
	cargo run

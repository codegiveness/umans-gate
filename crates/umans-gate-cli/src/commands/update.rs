//! Update command — self_update + self_replace + SHA256 checksums.
//!
//! Fetches the latest GitHub release for `umans-ai/umans-gate`, downloads the
//! target asset, verifies its SHA256 against the release's `SHA256SUMS`,
//! extracts the `umans-gate` binary, and atomically replaces the running
//! executable via `self_replace`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{anyhow, Context, Result};
use self_update::backends::github::ReleaseList;
use sha2::{Digest, Sha256};

const REPO_OWNER: &str = "umans-ai";
const REPO_NAME: &str = "umans-gate";
const BIN_NAME: &str = "umans-gate";

/// Run the update command.
///
/// - `force`: update even when already on the latest version.
/// - `dry_run`: print the would-be update and exit without touching the binary.
pub fn run(force: bool, dry_run: bool) -> Result<ExitCode> {
    let current = env!("CARGO_PKG_VERSION");
    let target = self_update::get_target();

    let releases = ReleaseList::configure()
        .repo_owner(REPO_OWNER)
        .repo_name(REPO_NAME)
        .build()
        .context("failed to configure GitHub release list")?
        .fetch()
        .context("failed to fetch GitHub releases")?;

    let latest = releases
        .first()
        .ok_or_else(|| anyhow!("no releases found for {REPO_OWNER}/{REPO_NAME}"))?;

    // Release tags are often `v`-prefixed; CARGO_PKG_VERSION is bare semver.
    let latest_version = latest.version.trim_start_matches('v');

    if skip_update(force, latest_version, current) {
        println!("Already up to date (v{current})");
        return Ok(ExitCode::SUCCESS);
    }

    if dry_run {
        println!("{}", dry_run_message(current, latest_version));
        return Ok(ExitCode::SUCCESS);
    }

    println!("Updating umans-gate v{current} -> v{latest_version}");

    let asset = latest
        .asset_for(target, None)
        .ok_or_else(|| anyhow!("no release asset found for target `{target}`"))?;

    let tmp_dir = tempfile::TempDir::new().context("failed to create temp dir")?;
    let archive_path = tmp_dir.path().join(&asset.name);

    // Download the release archive.
    {
        let mut archive_file = fs::File::create(&archive_path).with_context(|| {
            format!(
                "failed to create temp archive at {}",
                archive_path.display()
            )
        })?;
        self_update::Download::from_url(&asset.download_url)
            .download_to(&mut archive_file)
            .with_context(|| format!("failed to download asset `{}`", asset.name))?;
        archive_file
            .sync_all()
            .context("failed to flush downloaded archive")?;
    }

    // Verify SHA256 against the release's SHA256SUMS asset.
    let expected = fetch_expected_checksum(&latest.assets, &asset.name)?;
    let actual = compute_sha256(&archive_path)?;
    if !eq_hex_ci(&expected, &actual) {
        return Err(anyhow!(
            "checksum mismatch for `{}`: expected {expected}, got {actual}",
            asset.name
        ));
    }
    println!("Checksum verified: {actual}");

    // Extract the binary from the .tar.gz archive.
    let bin_name = if cfg!(windows) {
        format!("{BIN_NAME}.exe")
    } else {
        BIN_NAME.to_string()
    };
    let bin_path_in_archive = PathBuf::from(&bin_name);
    self_update::Extract::from_source(&archive_path)
        .archive(self_update::ArchiveKind::Tar(Some(
            self_update::Compression::Gz,
        )))
        .extract_file(tmp_dir.path(), &bin_path_in_archive)
        .context("failed to extract binary from archive")?;

    let new_exe = tmp_dir.path().join(&bin_name);
    if !new_exe.exists() {
        return Err(anyhow!(
            "extracted binary not found at {}",
            new_exe.display()
        ));
    }

    // Windows: back up the current binary before replacing.
    #[cfg(windows)]
    {
        let current_exe = std::env::current_exe().context("failed to locate current executable")?;
        if let Some(parent) = current_exe.parent() {
            let backup = parent.join(format!("{BIN_NAME}.bak"));
            let _ = fs::remove_file(&backup);
            fs::copy(&current_exe, &backup).with_context(|| {
                format!("failed to create Windows backup at {}", backup.display())
            })?;
            println!("Created Windows backup: {}", backup.display());
        }
    }

    self_replace::self_replace(&new_exe).context("failed to replace binary")?;

    println!("Successfully updated umans-gate to v{latest_version}");
    Ok(ExitCode::SUCCESS)
}

/// Whether to skip the update: not forced and already on the latest version.
fn skip_update(force: bool, latest_version: &str, current_version: &str) -> bool {
    !force && latest_version == current_version
}

/// Format the dry-run message.
fn dry_run_message(current: &str, latest: &str) -> String {
    format!("Would update {current} -> {latest}")
}

/// Download the release's `SHA256SUMS` asset and return the hex digest for
/// `asset_name`.
fn fetch_expected_checksum(
    assets: &[self_update::update::ReleaseAsset],
    asset_name: &str,
) -> Result<String> {
    let sums_url = assets
        .iter()
        .find(|a| a.name.to_ascii_uppercase().contains("SHA256"))
        .map(|a| a.download_url.as_str())
        .ok_or_else(|| anyhow!("no SHA256SUMS asset found in release"))?;

    let mut buf = Vec::new();
    self_update::Download::from_url(sums_url)
        .download_to(&mut buf)
        .context("failed to download SHA256SUMS")?;
    let text = String::from_utf8(buf).context("SHA256SUMS is not valid UTF-8")?;
    parse_checksum_line(&text, asset_name)
}

/// Parse a `sha256sum`-style file and return the hex digest for `asset_name`.
///
/// Accepts both text mode (`<hash>  <name>`) and binary mode
/// (`<hash> *<name>`) lines, ignoring blank and `#`-comment lines.
/// Returns the digest lowercased.
fn parse_checksum_line(text: &str, asset_name: &str) -> Result<String> {
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let hash = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("").trim_start_matches('*');
        if name == asset_name {
            return Ok(hash.to_lowercase());
        }
    }
    Err(anyhow!(
        "no checksum entry for `{asset_name}` in SHA256SUMS"
    ))
}

/// Compute the SHA256 hex digest of the file at `path` (lowercase).
fn compute_sha256(path: &Path) -> Result<String> {
    let data =
        fs::read(path).with_context(|| format!("failed to read archive at {}", path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    Ok(format!("{:x}", hasher.finalize()))
}

/// Case-insensitive, whitespace-trimming comparison of two hex digests.
fn eq_hex_ci(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parse_checksum_line_finds_match() {
        let text = "\
abc123  umans-gate-x86_64-unknown-linux-gnu.tar.gz
def456  umans-gate-aarch64-apple-darwin.tar.gz
";
        let got = parse_checksum_line(text, "umans-gate-aarch64-apple-darwin.tar.gz").unwrap();
        assert_eq!(got, "def456");
    }

    #[test]
    fn parse_checksum_line_handles_binary_mode_prefix() {
        let text = "abc123 *umans-gate.tar.gz\n";
        let got = parse_checksum_line(text, "umans-gate.tar.gz").unwrap();
        assert_eq!(got, "abc123");
    }

    #[test]
    fn parse_checksum_line_lowercases_hash() {
        let text = "ABCDEF0123456789  umans-gate.tar.gz\n";
        let got = parse_checksum_line(text, "umans-gate.tar.gz").unwrap();
        assert_eq!(got, "abcdef0123456789");
    }

    #[test]
    fn parse_checksum_line_ignores_blank_and_comment_lines() {
        let text = "\n# comment\nabc123  umans-gate.tar.gz\n";
        let got = parse_checksum_line(text, "umans-gate.tar.gz").unwrap();
        assert_eq!(got, "abc123");
    }

    #[test]
    fn parse_checksum_line_missing_entry_errors() {
        let text = "abc123  other.tar.gz\n";
        let res = parse_checksum_line(text, "umans-gate.tar.gz");
        assert!(res.is_err());
    }

    #[test]
    fn compute_sha256_known_value() {
        // sha256(b"hello world")
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("data.bin");
        let mut f = fs::File::create(&path).unwrap();
        f.write_all(b"hello world").unwrap();
        drop(f);
        let got = compute_sha256(&path).unwrap();
        assert_eq!(
            got,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn compute_sha256_empty_file() {
        // sha256(b"") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("empty.bin");
        let _ = fs::File::create(&path).unwrap();
        let got = compute_sha256(&path).unwrap();
        assert_eq!(
            got,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn eq_hex_ci_case_insensitive() {
        assert!(eq_hex_ci("ABC123", "abc123"));
        assert!(eq_hex_ci("abc123", "ABC123"));
        assert!(eq_hex_ci("abc123", "abc123"));
        assert!(!eq_hex_ci("abc123", "abc124"));
    }

    #[test]
    fn eq_hex_ci_trims_whitespace() {
        assert!(eq_hex_ci("  abc123  ", "abc123"));
        assert!(eq_hex_ci("abc123\n", "abc123"));
    }

    #[test]
    fn skip_update_already_current() {
        assert!(skip_update(false, "0.1.0", "0.1.0"));
    }

    #[test]
    fn skip_update_force_overrides_current() {
        assert!(!skip_update(true, "0.1.0", "0.1.0"));
    }

    #[test]
    fn skip_update_new_version_available() {
        assert!(!skip_update(false, "0.2.0", "0.1.0"));
    }

    #[test]
    fn dry_run_message_format() {
        assert_eq!(
            dry_run_message("0.1.0", "0.2.0"),
            "Would update 0.1.0 -> 0.2.0"
        );
    }

    /// Exercises the checksum verify helper end-to-end: build a SHA256SUMS
    /// blob for a temp file, parse it, compute the file's digest, and confirm
    /// they match. This is the same flow `run` performs after downloading.
    #[test]
    fn checksum_verify_helper_roundtrip() {
        let dir = tempfile::TempDir::new().unwrap();
        let archive = dir
            .path()
            .join("umans-gate-x86_64-unknown-linux-gnu.tar.gz");
        let payload = b"fake archive bytes";
        fs::write(&archive, payload).unwrap();

        let digest = compute_sha256(&archive).unwrap();
        let sums = format!("{digest}  umans-gate-x86_64-unknown-linux-gnu.tar.gz\n");
        let expected =
            parse_checksum_line(&sums, "umans-gate-x86_64-unknown-linux-gnu.tar.gz").unwrap();
        assert!(eq_hex_ci(&expected, &digest));
    }
}

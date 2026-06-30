//! Uninstall command: removes the current `umans-gate` executable.

use std::io::{self, BufRead, Write};
use std::process::ExitCode;

use anyhow::Result;

/// Run the uninstall command.
///
/// If `yes` is false, prompts stdin for confirmation. Only "y" or "yes"
/// (case-insensitive) proceed; any other input prints "Cancelled" and exits 0.
pub fn run(yes: bool) -> Result<ExitCode> {
    if !yes && !confirm_uninstall()? {
        println!("Cancelled");
        return Ok(ExitCode::SUCCESS);
    }

    delete_current_exe()?;
    println!("umans-gate uninstalled");
    Ok(ExitCode::SUCCESS)
}

fn confirm_uninstall() -> io::Result<bool> {
    print!("Uninstall umans-gate? (y/N) ");
    io::stdout().flush()?;

    let stdin = io::stdin().lock();
    match stdin.lines().next() {
        Some(Ok(line)) => Ok(parse_confirm(&line)),
        _ => Ok(false),
    }
}

fn parse_confirm(line: &str) -> bool {
    let line = line.trim();
    line.eq_ignore_ascii_case("y") || line.eq_ignore_ascii_case("yes")
}

fn delete_current_exe() -> Result<()> {
    #[cfg(test)]
    if let Some(test_exe) = std::env::var_os("UMANS_GATE_UNINSTALL_TEST_EXE") {
        self_update::self_replace::self_delete_at(&test_exe)?;
        return Ok(());
    }

    let exe = std::env::current_exe()?;
    self_update::self_replace::self_delete_at(exe)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::process::ExitCode;
    use std::sync::Mutex;

    use super::{parse_confirm, run};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn temp_copy_of_current_exe() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let exe = env::current_exe().expect("current exe");
        let dest = dir.path().join("umans-gate-copy");
        fs::copy(&exe, &dest).expect("copy current exe");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perm = fs::metadata(&dest).expect("metadata").permissions();
            perm.set_mode(0o755);
            fs::set_permissions(&dest, perm).expect("set executable permission");
        }
        (dir, dest)
    }

    #[test]
    fn parse_confirm_accepts_only_y_and_yes() {
        assert!(parse_confirm("y"));
        assert!(parse_confirm("Y"));
        assert!(parse_confirm("yes"));
        assert!(parse_confirm("YES"));
        assert!(parse_confirm("  y  "));
        assert!(!parse_confirm("n"));
        assert!(!parse_confirm("no"));
        assert!(!parse_confirm(""));
        assert!(!parse_confirm("maybe"));
    }

    #[test]
    fn prompt_cancelled_on_empty_stdin() {
        // cargo test provides EOF on stdin, so run(false) must cancel.
        let result = run(false);
        assert!(result.is_ok(), "result={:?}", result);
        assert_eq!(result.unwrap(), ExitCode::SUCCESS);
        // Behavior-is-safe: the real executable must not have been removed.
        assert!(
            env::current_exe().unwrap().exists(),
            "current exe deleted unexpectedly"
        );
    }

    #[test]
    fn yes_flag_deletes_mock_current_exe() {
        let _guard = ENV_LOCK.lock().expect("lock");
        let (dir, mock_exe) = temp_copy_of_current_exe();

        env::set_var("UMANS_GATE_UNINSTALL_TEST_EXE", &mock_exe);
        let result = run(true);
        env::remove_var("UMANS_GATE_UNINSTALL_TEST_EXE");

        // The temp dir must stay alive until after the existence checks.
        let _dir = dir;

        assert!(result.is_ok(), "result={:?}", result);
        assert!(!mock_exe.exists(), "mock current exe should be deleted");
    }

    #[test]
    fn cancellation_leaves_filesystem_unchanged() {
        let exe_before = env::current_exe().unwrap();
        let result = run(false);
        assert!(result.is_ok());
        assert!(exe_before.exists(), "cancellation must not delete anything");
    }
}

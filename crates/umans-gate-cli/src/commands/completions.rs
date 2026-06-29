use anyhow::Result;
use clap::CommandFactory;
use clap_complete::generate;

use crate::cli::Cli;

pub fn run(shell: clap_complete::Shell) -> Result<()> {
    let mut cmd = Cli::command();
    generate(shell, &mut cmd, "umans-gate", &mut std::io::stdout());
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use clap::CommandFactory;
    use clap_complete::{generate, Shell};

    use super::Cli;

    #[test]
    fn bash_completions_contain_subcommands() {
        let mut buf = Vec::new();
        {
            let mut writer: &mut dyn Write = &mut buf;
            let mut cmd = Cli::command();
            generate(Shell::Bash, &mut cmd, "umans-gate", &mut writer);
        }
        let output = String::from_utf8(buf).expect("completion output is utf-8");
        for needle in ["umans-gate", "serve", "update", "uninstall"] {
            assert!(
                output.contains(needle),
                "missing '{}' in completions",
                needle
            );
        }
    }
}

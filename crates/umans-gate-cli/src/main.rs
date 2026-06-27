mod cli;
mod commands;

use std::process::ExitCode;

use clap::Parser;

fn main() -> ExitCode {
    let args = cli::Cli::parse();
    match args.command {
        None => commands::serve::run(None, false),
        Some(cli::Command::Serve { bind, watch }) => commands::serve::run(bind.as_deref(), watch),
        Some(cli::Command::Update { force, dry_run }) => commands::update::run(force, dry_run),
        Some(cli::Command::Uninstall { yes }) => commands::uninstall::run(yes),
        Some(cli::Command::Completions { shell }) => commands::completions::run(shell)
            .map(|_| ExitCode::SUCCESS)
            .unwrap_or_else(|err| {
                eprintln!("{err:#}");
                ExitCode::FAILURE
            }),
    }
}

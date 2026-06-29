mod cli;
mod commands;
mod logging;

use std::path::Path;
use std::process::ExitCode;

use clap::Parser;

#[tokio::main]
async fn main() -> ExitCode {
    let args = cli::Cli::parse();
    logging::init(args.verbose);

    let command = args.command;
    let config_path = args.config.as_deref().unwrap_or(Path::new("config.yaml"));

    match command {
        None => commands::serve::run(config_path, None, true, None, None)
            .await
            .unwrap_or_else(|err| {
                eprintln!("{err:#}");
                ExitCode::FAILURE
            }),
        Some(cli::Command::Serve { bind, watch, no_watch, history_max, kill_min_age_seconds }) => {
            let watch = watch && !no_watch;
            commands::serve::run(config_path, bind, watch, history_max, kill_min_age_seconds)
                .await
                .unwrap_or_else(|err| {
                    eprintln!("{err:#}");
                    ExitCode::FAILURE
                })
        }
        Some(cli::Command::Update { force, dry_run }) => commands::update::run(force, dry_run)
            .map(|_| ExitCode::SUCCESS)
            .unwrap_or_else(|err| {
                eprintln!("{err:#}");
                ExitCode::FAILURE
            }),
        Some(cli::Command::Uninstall { yes }) => commands::uninstall::run(yes)
            .map(|_| ExitCode::SUCCESS)
            .unwrap_or_else(|err| {
                eprintln!("{err:#}");
                ExitCode::FAILURE
            }),
        Some(cli::Command::Completions { shell }) => commands::completions::run(shell)
            .map(|_| ExitCode::SUCCESS)
            .unwrap_or_else(|err| {
                eprintln!("{err:#}");
                ExitCode::FAILURE
            }),
    }
}

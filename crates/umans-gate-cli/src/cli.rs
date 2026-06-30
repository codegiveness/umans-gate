//! Clap v4 derive CLI definition.

use std::path::PathBuf;

use clap::{ArgAction, Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(
    name = "umans-gate",
    version,
    about = "Weighted concurrency API gateway",
    propagate_version = true
)]
pub struct Cli {
    /// Path to config file
    #[arg(short, long, global = true)]
    pub config: Option<PathBuf>,

    /// Verbosity (-v info, -vv debug, -vvv trace)
    #[arg(short, long, action = ArgAction::Count, global = true)]
    pub verbose: u8,

    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Start the gateway server (default if no subcommand)
    #[command(alias = "start", alias = "run")]
    Serve {
        /// Override bind address
        #[arg(short, long)]
        bind: Option<String>,
        /// Override dashboard bind address (default: 127.0.0.1:9090)
        #[arg(long)]
        dashboard_bind: Option<String>,
        /// Watch config file for changes and hot-reload (enabled by default)
        #[arg(long, default_value_t = true)]
        watch: bool,
        /// Disable watching the config file for changes
        #[arg(long, action = ArgAction::SetTrue)]
        no_watch: bool,
        /// Maximum in-memory terminal request records; 0 = unlimited
        #[arg(long)]
        history_max: Option<usize>,
        /// Minimum request age in seconds before the kill button is enabled
        #[arg(long)]
        kill_min_age_seconds: Option<u64>,
    },
    /// Update umans-gate from GitHub Releases
    Update {
        /// Force update even if already latest
        #[arg(long)]
        force: bool,
        /// Check for updates without installing
        #[arg(long)]
        dry_run: bool,
    },
    /// Uninstall umans-gate
    Uninstall {
        /// Skip confirmation prompt
        #[arg(short = 'y', long)]
        yes: bool,
    },
    /// Generate shell completions
    Completions {
        /// Target shell
        #[arg(value_enum)]
        shell: clap_complete::Shell,
    },
}

//! Gateway error types (thiserror-based).

use thiserror::Error;

/// Top-level gateway error.
#[derive(Error, Debug)]
pub enum GatewayError {
    #[error("config error: {0}")]
    Config(Box<figment::Error>),

    #[error("unknown provider: {0}")]
    UnknownProvider(String),

    #[error("unknown model: {model} in provider {provider}")]
    UnknownModel { provider: String, model: String },

    #[error("concurrency limit exceeded for provider {provider}")]
    ConcurrencyLimit { provider: String },

    #[error("upstream error: {0}")]
    Upstream(String),

    #[error("timeout: {0}")]
    Timeout(String),

    #[error("config validation: {0}")]
    Validation(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("request cancelled")]
    Cancelled,
}

/// Concurrency acquire failure (async path).
#[derive(Error, Debug)]
pub enum AcquireError {
    #[error("unknown provider")]
    UnknownProvider,

    #[error("semaphore closed")]
    Closed,
}

/// Concurrency try-acquire failure (non-blocking path).
#[derive(Error, Debug)]
pub enum TryAcquireError {
    #[error("unknown provider")]
    UnknownProvider,

    #[error("no capacity")]
    NoCapacity,
}

/// Result alias for gateway operations.
pub type Result<T> = std::result::Result<T, GatewayError>;

impl From<figment::Error> for GatewayError {
    fn from(e: figment::Error) -> Self {
        GatewayError::Config(Box::new(e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_error_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<GatewayError>();
        assert_send_sync::<AcquireError>();
        assert_send_sync::<TryAcquireError>();
    }

    #[test]
    fn from_io_conversion() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "missing");
        let gw_err: GatewayError = io_err.into();
        assert!(matches!(gw_err, GatewayError::Io(_)));
    }

    #[test]
    fn display_no_trailing_punct() {
        let e = GatewayError::UnknownProvider("openai".into());
        let s = e.to_string();
        assert!(!s.ends_with('.') && !s.ends_with('!'));
        assert!(!s.chars().next().unwrap().is_uppercase());
    }

    #[test]
    fn acquire_error_variants() {
        assert_eq!(
            AcquireError::UnknownProvider.to_string(),
            "unknown provider"
        );
        assert_eq!(AcquireError::Closed.to_string(), "semaphore closed");
    }

    #[test]
    fn try_acquire_error_variants() {
        assert_eq!(
            TryAcquireError::UnknownProvider.to_string(),
            "unknown provider"
        );
        assert_eq!(TryAcquireError::NoCapacity.to_string(), "no capacity");
    }
}

//! Serve command: start the gateway proxy + dashboard with graceful shutdown.

use std::net::SocketAddr;
use std::path::Path;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto::Builder;
use hyper_util::service::TowerToHyperService;
use tokio::net::TcpListener;
use tokio::sync::broadcast;
use tokio::task::{JoinHandle, JoinSet};
use tracing::{error, info};

use umans_gate::concurrency::{MetricUpdate, ProviderLimiter};
use umans_gate::config_store::ConfigStore;
use umans_gate::dashboard::router::dashboard_router;
use umans_gate::dashboard::state::DashboardState;
use umans_gate::proxy::router::{proxy_router, ProxyState};
use umans_gate::proxy::upstream::UpstreamClient;
use umans_gate::serve;
use umans_gate::shutdown::{install, ShutdownSignal};
use umans_gate::types::GatewayConfig;

/// Start the gateway: proxy on `config.bind`, dashboard on `config.dashboard_bind`.
///
/// Loads the config, builds the concurrency limiter + config store, wires up the
/// proxy and dashboard routers, binds TCP listeners, installs signal handlers,
/// and runs the proxy server in the foreground with graceful shutdown.
///
/// On a clean shutdown returns `ExitCode::SUCCESS`; on SIGQUIT (zero timeout) or
/// server error returns a failure `ExitCode`.
pub async fn run(
    config_path: &Path,
    bind: Option<String>,
    watch: bool,
    history_max: Option<usize>,
    kill_min_age_seconds: Option<u64>,
) -> anyhow::Result<ExitCode> {
    let mut config = if config_path.is_file() {
        GatewayConfig::load(config_path)
            .with_context(|| format!("loading config from {}", config_path.display()))?
    } else {
        info!(
            "No config file found at {}, fetching model list from https://api.code.umans.ai/v1/models/info...",
            config_path.display()
        );
        umans_gate::model_fetch::fetch_default_config()
            .await
            .with_context(|| "fetching default config from Umans API")?
    };

    if let Some(ref mut dash) = config.dashboard {
        if let Some(max) = history_max {
            dash.history.max = max;
        }
        if let Some(min_age) = kill_min_age_seconds {
            dash.kill_button.min_age_seconds = min_age;
        }
    }

    let bind_addr = match &bind {
        Some(b) => b
            .parse::<SocketAddr>()
            .with_context(|| format!("invalid --bind address: {b}"))?,
        None => config.bind,
    };
    let dashboard_addr = config.dashboard_bind;

    let proxy_listener = TcpListener::bind(bind_addr)
        .await
        .with_context(|| format!("binding proxy to {bind_addr}"))?;
    let dashboard_listener = TcpListener::bind(dashboard_addr)
        .await
        .with_context(|| format!("binding dashboard to {dashboard_addr}"))?;

    let (sig, _rx) = ShutdownSignal::new(Duration::from_secs(30));
    let shutdown = Arc::new(sig);
    install(&shutdown);

    serve_with_listeners(
        config_path,
        proxy_listener,
        dashboard_listener,
        config,
        watch,
        shutdown,
    )
    .await
}

async fn serve_with_listeners(
    config_path: &Path,
    proxy_listener: TcpListener,
    dashboard_listener: TcpListener,
    config: GatewayConfig,
    watch: bool,
    shutdown: Arc<ShutdownSignal>,
) -> anyhow::Result<ExitCode> {
    let bind_addr = proxy_listener.local_addr()?;
    let dashboard_addr = dashboard_listener.local_addr()?;

    let (metric_tx, _) = broadcast::channel::<MetricUpdate>(256);
    let limiter = Arc::new(ProviderLimiter::new(metric_tx));
    let kill_min_age = config
        .dashboard
        .as_ref()
        .map(|d| d.kill_button.min_age_seconds)
        .unwrap_or(300);
    let config_store = Arc::new(ConfigStore::new(config, limiter.clone()));

    #[cfg(not(feature = "hot-reload"))]
    let _ = config_path;

    let config_watch_handle: Option<JoinHandle<()>> = {
        #[cfg(feature = "hot-reload")]
        {
            if watch {
                let store = Arc::clone(&config_store);
                let path = config_path.to_path_buf();
                Some(spawn_supervised(
                    "config-watch",
                    Duration::from_secs(5),
                    move || {
                        let store = Arc::clone(&store);
                        let path = path.clone();
                        async move {
                            if let Err(e) = store.watch(path).await {
                                error!(error = %e, "config watch task ended");
                            }
                        }
                    },
                ))
            } else {
                None
            }
        }
        #[cfg(not(feature = "hot-reload"))]
        {
            None
        }
    };

    let upstream_client = Arc::new(UpstreamClient::new());
    let dashboard_state = Arc::new(DashboardState::new(Arc::clone(&limiter), kill_min_age));
    let proxy_state = Arc::new(ProxyState {
        config_store,
        limiter,
        tracker: dashboard_state.tracker_arc(),
        upstream_client,
    });

    let prune_tracker = dashboard_state.tracker_arc();
    let prune_handle = spawn_supervised("prune", Duration::from_secs(5), move || {
        let tracker = Arc::clone(&prune_tracker);
        async move {
            let interval = Duration::from_secs(5);
            loop {
                tokio::time::sleep(interval).await;
                tracker.prune_stale(interval);
            }
        }
    });

    let proxy_app = proxy_router(proxy_state);
    let dashboard_app = dashboard_router(dashboard_state);

    info!(%bind_addr, %dashboard_addr, watch, "umans-gate serving");

    let dashboard_sig = Arc::clone(&shutdown);
    let dashboard_handle = tokio::spawn(async move {
        if let Err(e) = serve(dashboard_listener, dashboard_app)
            .with_graceful_shutdown(async move {
                dashboard_sig.watch_for_shutdown().await;
            })
            .await
        {
            error!(error = %e, "dashboard server error");
        }
    });

    let proxy_sig = Arc::clone(&shutdown);

    // Force HTTP/1.1 only on the client-facing proxy listener. axum::serve
    // exposes no protocol-selection knob, so we drop down to hyper-util's
    // auto::Builder with http1_only() and run the accept loop manually. The
    // dashboard listener continues to use axum::serve unchanged.
    let service = TowerToHyperService::new(proxy_app);
    let mut connections = JoinSet::new();

    let proxy_result: Result<(), std::io::Error> = loop {
        tokio::select! {
            biased;
            _ = proxy_sig.watch_for_shutdown() => {
                break Ok(());
            }
            accept = proxy_listener.accept() => {
                let (stream, _) = match accept {
                    Ok(v) => v,
                    Err(e) => {
                        error!(error = %e, "proxy accept error");
                        continue;
                    }
                };
                let service = service.clone();
                let proxy_sig = proxy_sig.clone();
                connections.spawn(async move {
                    let builder = Builder::new(TokioExecutor::new()).http1_only();
                    let mut conn = std::pin::pin!(
                        builder.serve_connection_with_upgrades(TokioIo::new(stream), service)
                    );
                    let res = tokio::select! {
                        biased;
                        _ = proxy_sig.watch_for_shutdown() => {
                            conn.as_mut().graceful_shutdown();
                            conn.await
                        }
                        res = conn.as_mut() => res,
                    };
                    if let Err(e) = res {
                        error!(error = %e, "proxy connection error");
                    }
                });
            }
        }
    };

    // Wait for in-flight proxy connections to finish gracefully.
    while connections.join_next().await.is_some() {}

    let _ = dashboard_handle.await;

    join_supervisor(prune_handle, "prune").await;
    if let Some(handle) = config_watch_handle {
        join_supervisor(handle, "config-watch").await;
    }

    match proxy_result {
        Ok(()) => {
            if shutdown.effective_timeout().is_zero() {
                error!("SIGQUIT — forced shutdown");
                Ok(ExitCode::FAILURE)
            } else {
                info!("shutdown complete");
                Ok(ExitCode::SUCCESS)
            }
        }
        Err(e) => {
            error!(error = %e, "proxy server error");
            Ok(ExitCode::FAILURE)
        }
    }
}

/// Supervise a background task: spawn the work, await its `JoinHandle`, log
/// the result, wait `restart_delay`, and respawn. Handles both panics
/// (`JoinError` with `is_panic()`) and normal early returns.
///
/// Returns a `JoinHandle<()>` for the supervision loop itself. At shutdown,
/// join it with [`join_supervisor`].
fn spawn_supervised<F, Fut>(name: &'static str, restart_delay: Duration, work: F) -> JoinHandle<()>
where
    F: Fn() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        loop {
            let handle = tokio::spawn(work());
            match handle.await {
                Ok(()) => info!(task = name, "task completed; restarting"),
                Err(e) if e.is_panic() => {
                    error!(task = name, error = %e, "task panicked; restarting");
                }
                Err(e) => {
                    error!(task = name, error = %e, "task cancelled; restarting");
                }
            }
            tokio::time::sleep(restart_delay).await;
        }
    })
}

/// Join a supervision `JoinHandle` with a 2s timeout. If the timeout
/// expires, call `abort()` to cancel the task.
async fn join_supervisor(handle: JoinHandle<()>, name: &'static str) {
    let abort = handle.abort_handle();
    match tokio::time::timeout(Duration::from_secs(2), handle).await {
        Ok(Ok(())) => info!(task = name, "supervisor joined cleanly"),
        Ok(Err(e)) => error!(task = name, error = %e, "supervisor join error"),
        Err(_) => {
            error!(task = name, "supervisor did not shut down in 2s; aborting");
            abort.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::task::JoinHandle;

    use super::*;
    use umans_gate::shutdown::ShutdownToken;

    async fn spawn_server(
        config: GatewayConfig,
    ) -> (
        SocketAddr,
        ShutdownToken,
        JoinHandle<anyhow::Result<ExitCode>>,
    ) {
        let proxy_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dashboard_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = proxy_listener.local_addr().unwrap();

        let (sig, _rx) = ShutdownSignal::new(Duration::from_secs(30));
        let shutdown = Arc::new(sig);
        let token = shutdown.token();

        let handle = tokio::spawn(serve_with_listeners(
            Path::new(""),
            proxy_listener,
            dashboard_listener,
            config,
            false,
            shutdown,
        ));

        // Give the server a moment to start accepting.
        tokio::time::sleep(Duration::from_millis(50)).await;
        (proxy_addr, token, handle)
    }

    async fn http1_health(proxy_addr: SocketAddr) -> String {
        let mut stream = TcpStream::connect(proxy_addr).await.unwrap();
        stream
            .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        stream.flush().await.unwrap();

        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.unwrap();
        String::from_utf8_lossy(&buf).to_string()
    }

    async fn http2_attempt(proxy_addr: SocketAddr) -> Option<String> {
        let mut stream = TcpStream::connect(proxy_addr).await.ok()?;
        stream
            .write_all(b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")
            .await
            .ok()?;
        stream.flush().await.ok()?;

        let mut buf = [0u8; 1024];
        match tokio::time::timeout(Duration::from_secs(2), stream.read(&mut buf)).await {
            Ok(Ok(0)) => None,
            Ok(Ok(n)) => Some(String::from_utf8_lossy(&buf[..n]).to_string()),
            _ => None,
        }
    }

    #[tokio::test]
    async fn http1_request_works() {
        let (proxy_addr, token, handle) = spawn_server(GatewayConfig::default()).await;

        let response = http1_health(proxy_addr).await;
        assert!(
            response.starts_with("HTTP/1.1 200 OK") || response.starts_with("HTTP/1.1 200"),
            "expected HTTP/1.1 200 response, got: {response}"
        );
        assert!(
            response.contains("ok"),
            "expected body 'ok', got: {response}"
        );

        token.signal();
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    #[tokio::test]
    async fn http2_refused_or_downgraded() {
        let (proxy_addr, token, handle) = spawn_server(GatewayConfig::default()).await;

        let response = http2_attempt(proxy_addr).await;
        if let Some(text) = response {
            assert!(
                !text.starts_with("HTTP/2"),
                "server should not produce an HTTP/2 response, got: {text}"
            );
        }
        // If response is None the connection was closed: also acceptable.

        token.signal();
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    #[tokio::test]
    async fn graceful_shutdown_still_works() {
        let (proxy_addr, token, handle) = spawn_server(GatewayConfig::default()).await;

        // Issue an in-flight request before triggering shutdown.
        let response = http1_health(proxy_addr).await;
        assert!(
            response.contains("ok"),
            "request should complete, got: {response}"
        );

        token.signal();

        let result = tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("server should exit after shutdown");
        let exit = result.unwrap().expect("server should return Ok");
        assert_eq!(exit, ExitCode::SUCCESS);
    }

    #[tokio::test]
    async fn prune_task_restarts_after_panic() {
        use std::sync::atomic::{AtomicU32, Ordering};
        use umans_gate::dashboard::tracker::RequestTracker;

        let tracker = Arc::new(RequestTracker::new());
        let call_count = Arc::new(AtomicU32::new(0));
        let work_done = Arc::new(AtomicU32::new(0));

        let tracker_clone = Arc::clone(&tracker);
        let call_count_clone = Arc::clone(&call_count);
        let work_done_clone = Arc::clone(&work_done);

        let handle = spawn_supervised("test-prune", Duration::from_millis(50), move || {
            let tracker = Arc::clone(&tracker_clone);
            let call_count = Arc::clone(&call_count_clone);
            let work_done = Arc::clone(&work_done_clone);
            async move {
                let n = call_count.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    panic!("test-injected panic in prune task");
                }
                tracker.prune_stale(Duration::from_millis(5));
                work_done.fetch_add(1, Ordering::SeqCst);
            }
        });

        tokio::time::sleep(Duration::from_millis(200)).await;

        assert!(
            call_count.load(Ordering::SeqCst) > 1,
            "prune task should have restarted after panic, got call_count={}",
            call_count.load(Ordering::SeqCst)
        );
        assert!(
            work_done.load(Ordering::SeqCst) > 0,
            "prune work should have been done after restart"
        );
        assert!(
            tracker.snapshot().is_empty(),
            "tracker should be functional after restart"
        );

        handle.abort();
        let _ = handle.await;
    }

    #[cfg(feature = "hot-reload")]
    #[tokio::test]
    async fn config_watch_restarts_after_early_return() {
        use std::sync::atomic::{AtomicU32, Ordering};

        let call_count = Arc::new(AtomicU32::new(0));
        let call_count_clone = Arc::clone(&call_count);

        let handle = spawn_supervised("test-config-watch", Duration::from_millis(50), move || {
            let call_count = Arc::clone(&call_count_clone);
            async move {
                let _ = call_count.fetch_add(1, Ordering::SeqCst);
            }
        });

        tokio::time::sleep(Duration::from_millis(200)).await;

        assert!(
            call_count.load(Ordering::SeqCst) > 1,
            "config-watch task should have restarted after early return, got call_count={}",
            call_count.load(Ordering::SeqCst)
        );

        handle.abort();
        let _ = handle.await;
    }

    #[tokio::test]
    async fn shutdown_joins_background_tasks_within_timeout() {
        let (proxy_addr, token, handle) = spawn_server(GatewayConfig::default()).await;

        let response = http1_health(proxy_addr).await;
        assert!(
            response.contains("ok"),
            "server should be serving, got: {response}"
        );

        token.signal();

        let result = tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("server should exit within 5s after shutdown");
        let _ = result.unwrap().expect("server should return Ok");
    }
}

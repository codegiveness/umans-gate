//! Per-request lifecycle tracker for the dashboard.
//!
//! `RequestTracker` holds a `DashMap<Uuid, RequestRecord>` behind an `Arc`,
//! shared between `DashboardState` and the concurrency engine. Each request
//! transitions Queued -> Running -> Done/Rejected/Cancelled. Stale terminal entries are
//! pruned by a background task after ~5s so the table does not grow unbounded.
//!
//! Duration calculations use `Instant` (monotonic). A separate `SystemTime`
//! field is stored solely for wall-clock display (HH:MM:SS) and is never used
//! for ordering or elapsed-time math.

use std::collections::VecDeque;
use std::fmt;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime};

use axum::http::Version;
use chrono::{DateTime, Local, Utc};

use dashmap::DashMap;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::types::{ModelId, ProviderId, Weight};

/// Lifecycle state of a tracked request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestStatus {
    Queued,
    Running,
    Done,
    Rejected,
    Cancelled,
}

impl fmt::Display for RequestStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RequestStatus::Queued => f.write_str("queued"),
            RequestStatus::Running => f.write_str("running"),
            RequestStatus::Done => f.write_str("done"),
            RequestStatus::Rejected => f.write_str("rejected"),
            RequestStatus::Cancelled => f.write_str("cancelled"),
        }
    }
}

impl RequestStatus {
    pub fn badge_class(&self) -> &'static str {
        match self {
            RequestStatus::Queued => "bg-amber-500/15 text-amber-400",
            RequestStatus::Running => "bg-emerald-500/15 text-emerald-400",
            RequestStatus::Done => "bg-slate-500/15 text-slate-400",
            RequestStatus::Rejected => "bg-rose-500/15 text-rose-400",
            RequestStatus::Cancelled => "bg-orange-500/15 text-orange-400",
        }
    }

    pub fn dot_class(&self) -> &'static str {
        match self {
            RequestStatus::Queued => "bg-amber-400",
            RequestStatus::Running => "bg-emerald-400",
            RequestStatus::Done => "bg-slate-400",
            RequestStatus::Rejected => "bg-rose-400",
            RequestStatus::Cancelled => "bg-orange-400",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            RequestStatus::Queued => "Queued",
            RequestStatus::Running => "Running",
            RequestStatus::Done => "Done",
            RequestStatus::Rejected => "Rejected",
            RequestStatus::Cancelled => "Cancelled",
        }
    }
}

/// HTTP protocol version captured for display in the dashboard I/O column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolVersion {
    Http10,
    Http11,
    H2,
    H3,
}

impl fmt::Display for ProtocolVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProtocolVersion::Http10 => f.write_str("h1.0"),
            ProtocolVersion::Http11 => f.write_str("h1.1"),
            ProtocolVersion::H2 => f.write_str("h2"),
            ProtocolVersion::H3 => f.write_str("h3"),
        }
    }
}

impl From<Version> for ProtocolVersion {
    fn from(v: Version) -> Self {
        match v {
            Version::HTTP_10 => ProtocolVersion::Http10,
            Version::HTTP_11 => ProtocolVersion::Http11,
            Version::HTTP_2 => ProtocolVersion::H2,
            Version::HTTP_3 => ProtocolVersion::H3,
            _ => ProtocolVersion::Http11,
        }
    }
}

/// Identifies the upstream API family for a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiKind {
    Anthropic,
    OpenAI,
    Unknown,
}

impl fmt::Display for ApiKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiKind::Anthropic => f.write_str("Anthropic"),
            ApiKind::OpenAI => f.write_str("OpenAI"),
            ApiKind::Unknown => f.write_str("Unknown"),
        }
    }
}

impl ApiKind {
    pub fn from_path(path: &str) -> Self {
        // Strip query string and any leading slashes, then split into segments.
        let path = path.split('?').next().unwrap_or(path);
        let path = path.trim_start_matches('/');
        let segments: Vec<&str> = path.split('/').collect();
        let n = segments.len();

        // Anthropic: path ends with exactly ["v1", "messages"].
        if n >= 2 && segments[n - 2] == "v1" && segments[n - 1] == "messages" {
            ApiKind::Anthropic
        // OpenAI: path ends with ["v1", "chat", "completions"] or ["v1", "completions"].
        } else if (n >= 3
            && segments[n - 3] == "v1"
            && segments[n - 2] == "chat"
            && segments[n - 1] == "completions")
            || (n >= 2 && segments[n - 2] == "v1" && segments[n - 1] == "completions")
        {
            ApiKind::OpenAI
        } else {
            ApiKind::Unknown
        }
    }
}

/// A single request's tracking record, cloned out for read-only snapshots.
#[derive(Debug, Clone)]
pub struct RequestRecord {
    pub id: Uuid,
    pub provider: ProviderId,
    pub model: ModelId,
    pub weight: Weight,
    pub status: RequestStatus,
    pub enqueued_at: Instant,
    pub acquired_at: Option<Instant>,
    pub completed_at: Option<Instant>,
    /// Wall-clock enqueue time for display only. Never used for duration math.
    pub enqueued_at_wall: SystemTime,
    /// Protocol version of the incoming client request.
    pub client_protocol: ProtocolVersion,
    /// Protocol version of the upstream response, once known.
    pub upstream_protocol: Option<ProtocolVersion>,
    /// Whether this record has reached a terminal status. Prevents double
    /// terminal transitions and double weighted-permit release.
    pub is_terminal: bool,
    /// Normalized upstream path used to identify the API family.
    pub path: String,
    /// Derived API family label for the dashboard.
    pub api_kind: ApiKind,
    /// Cancellation token for aborting the upstream request mid-stream.
    /// Clones share cancellation state; `cancel(id)` cancels all clones.
    pub cancellation_token: CancellationToken,
    /// HTTP status code from the upstream response, captured at first frame.
    pub upstream_status: Option<u16>,
    /// Internal status code representing the terminal transition reason.
    /// 200=Done, 503=Rejected, 400=Cancelled, 504=Timeout.
    pub internal_status: Option<u16>,
    /// Time to first token (byte): elapsed from acquired_at to first body frame.
    pub ttft: Option<Duration>,
    /// Instant the first upstream body frame arrived.
    pub first_body_frame_at: Option<Instant>,
    /// Whether this record has been migrated to HistoryStore.
    /// Prevents double-push on terminal transition and prune_stale.
    pub migrated_to_history: bool,
    /// Prompt (input) token count extracted from upstream usage frame.
    pub prompt_tokens: Option<usize>,
    /// Completion (output) token count extracted from upstream usage frame.
    pub completion_tokens: Option<usize>,
    /// Cached input token count (prompt_tokens_details.cached_tokens / cache_read_input_tokens).
    pub cached_tokens: Option<usize>,
    /// Tokens-per-second, best-effort: completion_tokens / streaming_elapsed.
    /// Set during streaming; recomputed with exact streaming_elapsed at migration.
    pub tps: Option<f64>,
}

/// Cached OS timezone offset label for the request-fragment header.
///
/// Computes the offset once at process startup and returns it as `[+-]HH.MM`
/// (colons replaced with dots so the header is easy to scan).
pub fn local_offset_label() -> String {
    static LABEL: OnceLock<String> = OnceLock::new();
    LABEL
        .get_or_init(|| Local::now().offset().to_string().replace(':', "."))
        .clone()
}

impl RequestRecord {
    pub fn short_id(&self) -> String {
        let s = self.id.to_string();
        format!("{}…", &s[..8])
    }

    pub fn age_secs(&self) -> u64 {
        self.enqueued_at.elapsed().as_secs()
    }

    /// Format `enqueued_at_wall` as `HH:MM:SS` in local wall-clock time.
    pub fn enqueued_at_display(&self) -> String {
        DateTime::<Local>::from(self.enqueued_at_wall)
            .format("%H:%M:%S")
            .to_string()
    }

    /// Render the I/O protocol pair as `client_proto/upstream_proto`.
    /// When the upstream protocol is not yet known, render `-`.
    pub fn io_display(&self) -> String {
        let upstream = self
            .upstream_protocol
            .map(|p| p.to_string())
            .unwrap_or_else(|| "-".to_string());
        format!("{}/{}", self.client_protocol, upstream)
    }
}

/// Terminal snapshot of a completed request for the history view.
///
/// Mirrors the display-relevant fields of [`RequestRecord`] but with all
/// timing stored as `DateTime<Utc>` / `Option<Duration>` so the history
/// table can render without `Instant` (monotonic) references that are
/// meaningless after the original record is dropped.
#[derive(Debug, Clone)]
pub struct HistoryRecord {
    pub id: Uuid,
    pub provider: ProviderId,
    pub model: ModelId,
    pub api_kind: ApiKind,
    pub status: RequestStatus,
    pub enqueued_at_wall: DateTime<Utc>,
    pub total_time: Option<Duration>,
    pub upstream_status: Option<u16>,
    pub internal_status: Option<u16>,
    pub ttft: Option<Duration>,
    pub streaming_elapsed: Option<Duration>,
    pub prompt_tokens: Option<usize>,
    pub completion_tokens: Option<usize>,
    pub cached_tokens: Option<usize>,
    pub tps: Option<f64>,
}

impl HistoryRecord {
    /// Format `enqueued_at_wall` as `HH:MM:SS` in local wall-clock time.
    pub fn enqueued_at_display(&self) -> String {
        self.enqueued_at_wall
            .with_timezone(&Local)
            .format("%H:%M:%S")
            .to_string()
    }

    /// Format `total_time` as seconds (e.g., `1.23s`) or `-` if `None`.
    pub fn total_time_display(&self) -> String {
        self.total_time
            .map(|d| format!("{:.2}s", d.as_secs_f64()))
            .unwrap_or_else(|| "-".to_string())
    }

    /// Format `ttft` as milliseconds (e.g., `100ms`) or `-` if `None`.
    pub fn ttft_display(&self) -> String {
        self.ttft
            .map(|d| format!("{}ms", d.as_millis()))
            .unwrap_or_else(|| "-".to_string())
    }

    /// Format `internal_status` as a string or `-` if `None`.
    pub fn internal_status_display(&self) -> String {
        self.internal_status
            .map(|s| s.to_string())
            .unwrap_or_else(|| "-".to_string())
    }

    /// Format token in/out as `prompt/completion` or `-` if both are `None`.
    pub fn tokens_display(&self) -> String {
        match (self.prompt_tokens, self.completion_tokens) {
            (Some(p), Some(c)) => format!("{}/{}", p, c),
            (Some(p), None) => format!("{}/-", p),
            (None, Some(c)) => format!("-/{}", c),
            (None, None) => "-".to_string(),
        }
    }

    /// Format cached token percentage relative to `prompt_tokens`, or `-`.
    pub fn cached_pct_display(&self) -> String {
        match (self.cached_tokens, self.prompt_tokens) {
            (Some(cached), Some(prompt)) if prompt > 0 => {
                format!("{:.0}%", (cached as f64 / prompt as f64) * 100.0)
            }
            _ => "-".to_string(),
        }
    }

    /// Format `tps` with 2 decimal places or `-` if `None`.
    pub fn tps_display(&self) -> String {
        self.tps
            .map(|t| format!("{:.2}", t))
            .unwrap_or_else(|| "-".to_string())
    }
}

/// Compute tokens-per-second from completion token count and streaming elapsed.
/// Returns `None` if either input is `None` or elapsed is zero.
pub fn compute_tps(
    completion_tokens: Option<usize>,
    streaming_elapsed: Option<Duration>,
) -> Option<f64> {
    match (completion_tokens, streaming_elapsed) {
        (Some(c), Some(d)) if d.as_secs_f64() > 0.0 => Some(c as f64 / d.as_secs_f64()),
        _ => None,
    }
}

/// Bounded FIFO ring buffer of terminal request records.
///
/// `max == 0` means unlimited. Otherwise, when `len() == max`, the oldest
/// entry is evicted before the new one is pushed.
#[derive(Debug)]
pub struct HistoryStore {
    records: VecDeque<HistoryRecord>,
    max: usize,
}

impl HistoryStore {
    pub fn new(max: usize) -> Self {
        HistoryStore {
            records: VecDeque::with_capacity(if max > 0 { max } else { 64 }),
            max,
        }
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Push a record, evicting the oldest if at capacity (FIFO).
    pub fn push(&mut self, record: HistoryRecord) {
        if self.max > 0 && self.records.len() == self.max {
            self.records.pop_front();
        }
        self.records.push_back(record);
    }

    /// Return all records newest-first (reverse insertion order).
    pub fn snapshot(&self) -> Vec<HistoryRecord> {
        self.records.iter().rev().cloned().collect()
    }
}

impl Default for HistoryStore {
    fn default() -> Self {
        Self::new(1000)
    }
}

/// Per-request lifecycle tracker.
///
/// Lives behind `Arc` inside `DashboardState`. The concurrency engine calls
/// `register_queued` / `mark_running` / `mark_done` / `mark_rejected` from the
/// acquire path (Task 3 hooks). A background task calls `prune_stale`
/// periodically.
#[derive(Debug)]
pub struct RequestTracker {
    requests: Arc<DashMap<Uuid, RequestRecord>>,
    history: RwLock<HistoryStore>,
}

impl RequestTracker {
    /// Create an empty tracker with default history capacity (1000).
    pub fn new() -> Self {
        RequestTracker::with_history_max(1000)
    }

    /// Create a tracker with a specific history capacity. `0` = unlimited.
    pub fn with_history_max(history_max: usize) -> Self {
        RequestTracker {
            requests: Arc::new(DashMap::new()),
            history: RwLock::new(HistoryStore::new(history_max)),
        }
    }

    /// Register a new request in the Queued state.
    pub fn register_queued(
        &self,
        id: Uuid,
        provider: &ProviderId,
        model: &ModelId,
        weight: Weight,
        client_protocol: ProtocolVersion,
        path: String,
    ) {
        let api_kind = ApiKind::from_path(&path);
        let record = RequestRecord {
            id,
            provider: provider.clone(),
            model: model.clone(),
            weight,
            status: RequestStatus::Queued,
            enqueued_at: Instant::now(),
            acquired_at: None,
            completed_at: None,
            enqueued_at_wall: SystemTime::now(),
            client_protocol,
            upstream_protocol: None,
            is_terminal: false,
            path,
            api_kind,
            cancellation_token: CancellationToken::new(),
            upstream_status: None,
            internal_status: None,
            ttft: None,
            first_body_frame_at: None,
            migrated_to_history: false,
            prompt_tokens: None,
            completion_tokens: None,
            cached_tokens: None,
            tps: None,
        };
        self.requests.insert(id, record);
    }

    /// Transition a request to Running, optionally recording the upstream protocol.
    pub fn mark_running(&self, id: Uuid, upstream_protocol: Option<ProtocolVersion>) {
        if let Some(mut entry) = self.requests.get_mut(&id) {
            entry.status = RequestStatus::Running;
            entry.acquired_at = Some(Instant::now());
            if let Some(proto) = upstream_protocol {
                entry.upstream_protocol = Some(proto);
            }
        }
    }

    /// Record the upstream protocol version without resetting `acquired_at`.
    ///
    /// Called after the upstream response is received but before the permit is
    /// moved into the body stream.
    pub fn set_upstream_protocol(&self, id: Uuid, protocol: ProtocolVersion) {
        if let Some(mut entry) = self.requests.get_mut(&id) {
            entry.upstream_protocol = Some(protocol);
        }
    }

    /// Record the upstream HTTP status and compute TTFT (time to first token)
    /// from the first body frame arrival. Called from `forward_with_timeouts`
    /// after the TTFB phase succeeds.
    pub fn set_upstream_status_and_ttft(&self, id: Uuid, status: u16) {
        if let Some(mut entry) = self.requests.get_mut(&id) {
            let now = Instant::now();
            entry.upstream_status = Some(status);
            entry.first_body_frame_at = Some(now);
            let start = entry.acquired_at.unwrap_or(entry.enqueued_at);
            entry.ttft = now.checked_duration_since(start);
        }
    }

    /// Record token usage extracted from the upstream response stream/body.
    /// Also computes a best-effort TPS from `completion_tokens` and elapsed
    /// time since `first_body_frame_at`. `to_history_record` recomputes TPS
    /// with the exact `streaming_elapsed` at migration time.
    pub fn set_token_usage(
        &self,
        id: Uuid,
        prompt: Option<usize>,
        completion: Option<usize>,
        cached: Option<usize>,
    ) {
        if let Some(mut entry) = self.requests.get_mut(&id) {
            entry.prompt_tokens = prompt;
            entry.completion_tokens = completion;
            entry.cached_tokens = cached;
            if let (Some(c), Some(f)) = (completion, entry.first_body_frame_at) {
                let elapsed = f.elapsed();
                if elapsed.as_secs_f64() > 0.0 {
                    entry.tps = Some(c as f64 / elapsed.as_secs_f64());
                }
            }
        }
    }

    /// Return the `ApiKind` for a tracked request, if it exists.
    pub fn api_kind(&self, id: Uuid) -> Option<ApiKind> {
        self.requests.get(&id).map(|r| r.api_kind)
    }

    /// True if the record is currently in a terminal state. Missing records are
    /// treated as terminal so that Drop guards do not attempt transitions.
    pub fn is_terminal(&self, id: Uuid) -> bool {
        self.requests
            .get(&id)
            .map_or(true, |entry| entry.is_terminal)
    }

    /// Transition a request to Done. Idempotent: no-op if already terminal.
    pub fn mark_done(&self, id: Uuid) {
        {
            let Some(mut entry) = self.requests.get_mut(&id) else {
                return;
            };
            if entry.is_terminal {
                return;
            }
            entry.status = RequestStatus::Done;
            entry.internal_status = Some(200);
            entry.completed_at = Some(Instant::now());
        }
        self.record_history(id);
        if let Some(mut entry) = self.requests.get_mut(&id) {
            entry.is_terminal = true;
        }
    }

    /// Transition a request to Rejected. Idempotent: no-op if already terminal.
    pub fn mark_rejected(&self, id: Uuid) {
        {
            let Some(mut entry) = self.requests.get_mut(&id) else {
                return;
            };
            if entry.is_terminal {
                return;
            }
            entry.status = RequestStatus::Rejected;
            entry.internal_status = Some(503);
            entry.completed_at = Some(Instant::now());
        }
        self.record_history(id);
        if let Some(mut entry) = self.requests.get_mut(&id) {
            entry.is_terminal = true;
        }
    }

    /// Transition a request to Cancelled. Idempotent: no-op if already terminal.
    pub fn mark_cancelled(&self, id: Uuid) {
        {
            let Some(mut entry) = self.requests.get_mut(&id) else {
                return;
            };
            if entry.is_terminal {
                return;
            }
            entry.status = RequestStatus::Cancelled;
            entry.internal_status = Some(400);
            entry.completed_at = Some(Instant::now());
        }
        self.record_history(id);
        if let Some(mut entry) = self.requests.get_mut(&id) {
            entry.is_terminal = true;
        }
    }

    /// Transition a request to Rejected with internal_status 504 (timeout).
    /// Idempotent: no-op if already terminal.
    pub fn mark_timeout(&self, id: Uuid) {
        {
            let Some(mut entry) = self.requests.get_mut(&id) else {
                return;
            };
            if entry.is_terminal {
                return;
            }
            entry.status = RequestStatus::Rejected;
            entry.internal_status = Some(504);
            entry.completed_at = Some(Instant::now());
        }
        self.record_history(id);
        if let Some(mut entry) = self.requests.get_mut(&id) {
            entry.is_terminal = true;
        }
    }

    /// Clone the request's cancellation token, if the record exists.
    pub fn cancellation_token(&self, id: Uuid) -> Option<CancellationToken> {
        self.requests.get(&id).map(|r| r.cancellation_token.clone())
    }

    /// Cancel a tracked request: aborts the upstream stream via the token and
    /// marks the record `Cancelled`. Returns `true` if the record existed and
    /// was not already terminal; `false` otherwise.
    pub fn cancel(&self, id: Uuid) -> bool {
        let Some(entry) = self.requests.get(&id) else {
            return false;
        };
        if entry.is_terminal {
            return false;
        }
        entry.cancellation_token.cancel();
        drop(entry);
        self.mark_cancelled(id);
        true
    }

    /// Remove Done/Rejected/Cancelled entries whose `completed_at` is older than
    /// `max_age`. Queued/Running entries are always retained. Records not yet
    /// migrated to history are migrated before removal.
    pub fn prune_stale(&self, max_age: Duration) {
        let cutoff = Instant::now()
            .checked_sub(max_age)
            .unwrap_or_else(Instant::now);
        let history = &self.history;
        self.requests.retain(|_, record| {
            let is_terminal_status = matches!(
                record.status,
                RequestStatus::Done | RequestStatus::Rejected | RequestStatus::Cancelled
            );
            if !is_terminal_status {
                return true;
            }
            let is_stale = record.completed_at.map_or(true, |t| t <= cutoff);
            if !is_stale {
                return true;
            }
            if !record.migrated_to_history {
                record.migrated_to_history = true;
                let hist = RequestTracker::to_history_record(record);
                if let Ok(mut store) = history.write() {
                    store.push(hist);
                }
            }
            false
        });
    }

    /// Read-only snapshot: iterate + clone, does NOT clear-and-rebuild.
    ///
    /// Sorted oldest → newest by enqueue time.
    pub fn snapshot(&self) -> Vec<RequestRecord> {
        let mut records: Vec<RequestRecord> = self
            .requests
            .iter()
            .map(|entry| entry.value().clone())
            .collect();
        records.sort_by_key(|a| a.enqueued_at);
        records
    }

    /// Convert a live `RequestRecord` into a terminal `HistoryRecord`.
    fn to_history_record(record: &RequestRecord) -> HistoryRecord {
        let total_time = record
            .completed_at
            .and_then(|c| c.checked_duration_since(record.enqueued_at));
        let streaming_elapsed = match (record.completed_at, record.first_body_frame_at) {
            (Some(c), Some(f)) => c.checked_duration_since(f),
            _ => None,
        };
        let tps = compute_tps(record.completion_tokens, streaming_elapsed).or(record.tps);
        HistoryRecord {
            id: record.id,
            provider: record.provider.clone(),
            model: record.model.clone(),
            api_kind: record.api_kind,
            status: record.status,
            enqueued_at_wall: DateTime::<Utc>::from(record.enqueued_at_wall),
            total_time,
            upstream_status: record.upstream_status,
            internal_status: record.internal_status,
            ttft: record.ttft,
            streaming_elapsed,
            prompt_tokens: record.prompt_tokens,
            completion_tokens: record.completion_tokens,
            cached_tokens: record.cached_tokens,
            tps,
        }
    }

    /// Migrate a live record into the history store. Sets `migrated_to_history`
    /// atomically to prevent double-push. No-op if already migrated or missing.
    pub fn record_history(&self, id: Uuid) {
        let history_record = {
            let Some(mut entry) = self.requests.get_mut(&id) else {
                return;
            };
            if entry.migrated_to_history {
                return;
            }
            entry.migrated_to_history = true;
            RequestTracker::to_history_record(&entry)
        };
        if let Ok(mut store) = self.history.write() {
            store.push(history_record);
        }
    }

    /// Return a newest-first snapshot of the history store.
    pub fn history(&self) -> Vec<HistoryRecord> {
        self.history
            .read()
            .map(|store| store.snapshot())
            .unwrap_or_default()
    }
}

impl Default for RequestTracker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_record(id: Uuid) -> (Uuid, ProviderId, ModelId, Weight) {
        (
            id,
            ProviderId::new("openai"),
            ModelId::new("gpt-4"),
            Weight::from(1.0),
        )
    }

    fn sample_protocol() -> ProtocolVersion {
        ProtocolVersion::Http11
    }

    #[test]
    fn protocol_version_display() {
        assert_eq!(format!("{}", ProtocolVersion::Http10), "h1.0");
        assert_eq!(format!("{}", ProtocolVersion::Http11), "h1.1");
        assert_eq!(format!("{}", ProtocolVersion::H2), "h2");
        assert_eq!(format!("{}", ProtocolVersion::H3), "h3");
    }

    #[test]
    fn protocol_version_from_http_version() {
        assert_eq!(
            ProtocolVersion::from(Version::HTTP_10),
            ProtocolVersion::Http10
        );
        assert_eq!(
            ProtocolVersion::from(Version::HTTP_11),
            ProtocolVersion::Http11
        );
        assert_eq!(ProtocolVersion::from(Version::HTTP_2), ProtocolVersion::H2);
        assert_eq!(ProtocolVersion::from(Version::HTTP_3), ProtocolVersion::H3);
    }

    #[test]
    fn enqueued_at_display_formats_hhmmss() {
        let wall = SystemTime::UNIX_EPOCH + Duration::from_secs(3661);
        let record = RequestRecord {
            id: Uuid::new_v4(),
            provider: ProviderId::new("openai"),
            model: ModelId::new("gpt-4"),
            weight: Weight::from(1.0),
            status: RequestStatus::Queued,
            enqueued_at: Instant::now(),
            acquired_at: None,
            completed_at: None,
            enqueued_at_wall: wall,
            client_protocol: sample_protocol(),
            upstream_protocol: None,
            is_terminal: false,
            path: "/v1/chat/completions".to_string(),
            api_kind: ApiKind::OpenAI,
            cancellation_token: CancellationToken::new(),
            upstream_status: None,
            internal_status: None,
            ttft: None,
            first_body_frame_at: None,
            migrated_to_history: false,
            prompt_tokens: None,
            completion_tokens: None,
            cached_tokens: None,
            tps: None,
        };
        let expected = DateTime::<Local>::from(wall).format("%H:%M:%S").to_string();
        assert_eq!(record.enqueued_at_display(), expected);
    }

    #[test]
    fn io_display_shows_client_and_upstream_or_dash() {
        let base = RequestRecord {
            id: Uuid::new_v4(),
            provider: ProviderId::new("openai"),
            model: ModelId::new("gpt-4"),
            weight: Weight::from(1.0),
            status: RequestStatus::Running,
            enqueued_at: Instant::now(),
            acquired_at: None,
            completed_at: None,
            enqueued_at_wall: SystemTime::now(),
            client_protocol: ProtocolVersion::Http11,
            upstream_protocol: None,
            is_terminal: false,
            path: "/v1/chat/completions".to_string(),
            api_kind: ApiKind::OpenAI,
            cancellation_token: CancellationToken::new(),
            upstream_status: None,
            internal_status: None,
            ttft: None,
            first_body_frame_at: None,
            migrated_to_history: false,
            prompt_tokens: None,
            completion_tokens: None,
            cached_tokens: None,
            tps: None,
        };

        let with_upstream = RequestRecord {
            upstream_protocol: Some(ProtocolVersion::Http11),
            ..base.clone()
        };
        assert_eq!(with_upstream.io_display(), "h1.1/h1.1");

        let without_upstream = RequestRecord {
            client_protocol: ProtocolVersion::Http10,
            upstream_protocol: None,
            ..base
        };
        assert_eq!(without_upstream.io_display(), "h1.0/-");
    }

    #[test]
    fn snapshot_sorted_oldest_first() {
        let tracker = RequestTracker::new();

        let id1 = Uuid::new_v4();
        let (id1, provider1, model1, weight1) = sample_record(id1);
        tracker.register_queued(
            id1,
            &provider1,
            &model1,
            weight1,
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        );
        std::thread::sleep(Duration::from_millis(10));

        let id2 = Uuid::new_v4();
        let (id2, provider2, model2, weight2) = sample_record(id2);
        tracker.register_queued(
            id2,
            &provider2,
            &model2,
            weight2,
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        );

        let snap = tracker.snapshot();
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0].id, id1, "oldest request should be first");
        assert_eq!(snap[1].id, id2, "newest request should be second");
        assert!(
            snap[0].enqueued_at <= snap[1].enqueued_at,
            "snapshot should be sorted oldest -> newest"
        );
    }

    #[test]
    fn lifecycle_queued_running_done() {
        let tracker = RequestTracker::new();
        let id = Uuid::new_v4();
        let (id, provider, model, weight) = sample_record(id);

        tracker.register_queued(
            id,
            &provider,
            &model,
            weight,
            sample_protocol(),
            "/v1/chat/completions".to_string(),
        );
        let snap = tracker.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].status, RequestStatus::Queued);
        assert!(snap[0].acquired_at.is_none());
        assert!(snap[0].completed_at.is_none());
        assert_eq!(snap[0].client_protocol, sample_protocol());
        assert!(snap[0].upstream_protocol.is_none());
        assert!(!snap[0].enqueued_at_display().is_empty());

        tracker.mark_running(id, Some(ProtocolVersion::Http11));
        let snap = tracker.snapshot();
        assert_eq!(snap[0].status, RequestStatus::Running);
        assert!(snap[0].acquired_at.is_some());
        assert!(snap[0].completed_at.is_none());
        assert_eq!(snap[0].upstream_protocol, Some(ProtocolVersion::Http11));

        tracker.mark_done(id);
        let snap = tracker.snapshot();
        assert_eq!(snap[0].status, RequestStatus::Done);
        assert!(snap[0].acquired_at.is_some());
        assert!(snap[0].completed_at.is_some());
    }

    #[test]
    fn rejected_path() {
        let tracker = RequestTracker::new();
        let id = Uuid::new_v4();
        let (id, provider, model, weight) = sample_record(id);

        tracker.register_queued(
            id,
            &provider,
            &model,
            weight,
            sample_protocol(),
            "/v1/chat/completions".to_string(),
        );
        tracker.mark_rejected(id);

        let snap = tracker.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].status, RequestStatus::Rejected);
        assert!(snap[0].completed_at.is_some());
        assert!(snap[0].acquired_at.is_none());
    }

    #[test]
    fn prune_removes_stale_but_not_live() {
        let tracker = RequestTracker::new();

        // Stale Done entry (completed ~50ms ago).
        let stale_id = Uuid::new_v4();
        let (stale_id, provider, model, weight) = sample_record(stale_id);
        tracker.register_queued(
            stale_id,
            &provider,
            &model,
            weight,
            sample_protocol(),
            "/v1/chat/completions".to_string(),
        );
        tracker.mark_done(stale_id);
        std::thread::sleep(Duration::from_millis(50));

        // Live Running entry — must survive pruning.
        let live_id = Uuid::new_v4();
        let (live_id, provider2, model2, weight2) = sample_record(live_id);
        tracker.register_queued(
            live_id,
            &provider2,
            &model2,
            weight2,
            sample_protocol(),
            "/v1/chat/completions".to_string(),
        );
        tracker.mark_running(live_id, None);

        // Recent Done entry — must survive pruning.
        let recent_id = Uuid::new_v4();
        let (recent_id, provider3, model3, weight3) = sample_record(recent_id);
        tracker.register_queued(
            recent_id,
            &provider3,
            &model3,
            weight3,
            sample_protocol(),
            "/v1/chat/completions".to_string(),
        );
        tracker.mark_done(recent_id);

        tracker.prune_stale(Duration::from_millis(25));

        let snap = tracker.snapshot();
        let ids: Vec<Uuid> = snap.iter().map(|r| r.id).collect();
        assert!(
            !ids.contains(&stale_id),
            "stale Done entry should have been pruned"
        );
        assert!(
            ids.contains(&live_id),
            "live Running entry should have been retained"
        );
        assert!(
            ids.contains(&recent_id),
            "recent Done entry should have been retained"
        );
        assert_eq!(
            snap.len(),
            2,
            "expected 2 entries after prune, got {}",
            snap.len()
        );
    }

    #[test]
    fn snapshot_is_read_only_clone() {
        let tracker = RequestTracker::new();
        let id = Uuid::new_v4();
        let (id, provider, model, weight) = sample_record(id);
        tracker.register_queued(
            id,
            &provider,
            &model,
            weight,
            sample_protocol(),
            "/v1/chat/completions".to_string(),
        );

        let snap1 = tracker.snapshot();
        assert_eq!(snap1.len(), 1);

        // Mutating the tracker after snapshot must not affect the snapshot.
        tracker.mark_done(id);
        assert_eq!(
            snap1[0].status,
            RequestStatus::Queued,
            "snapshot should reflect state at capture time"
        );

        // The original tracker still has the updated state.
        let snap2 = tracker.snapshot();
        assert_eq!(snap2[0].status, RequestStatus::Done);

        // Snapshot of empty tracker is empty.
        let empty = RequestTracker::new();
        assert!(empty.snapshot().is_empty());
    }

    #[test]
    fn concurrent_register_no_duplicates() {
        let tracker = RequestTracker::new();
        let total = 100usize;

        std::thread::scope(|s| {
            for _ in 0..total {
                let tracker = &tracker;
                s.spawn(move || {
                    let id = Uuid::new_v4();
                    let provider = ProviderId::new("openai");
                    let model = ModelId::new("gpt-4");
                    tracker.register_queued(
                        id,
                        &provider,
                        &model,
                        Weight::from(1.0),
                        sample_protocol(),
                        "/v1/chat/completions".to_string(),
                    );
                    tracker.mark_running(id, None);
                });
            }
        });

        let snap = tracker.snapshot();
        assert_eq!(
            snap.len(),
            total,
            "expected {} unique entries, got {}",
            total,
            snap.len()
        );

        let mut ids: Vec<Uuid> = snap.iter().map(|r| r.id).collect();
        ids.sort();
        let original_len = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), original_len, "found duplicate UUIDs after dedup");

        assert!(
            snap.iter().all(|r| r.status == RequestStatus::Running),
            "all entries should be Running"
        );
    }

    #[test]
    fn uuid_v4_format() {
        /// Validate that a string matches the RFC 4122 v4 layout:
        /// `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx` (lowercase hex).
        fn is_valid_v4(s: &str) -> bool {
            let parts: Vec<&str> = s.split('-').collect();
            parts.len() == 5
                && parts[0].len() == 8
                && parts[1].len() == 4
                && parts[2].len() == 4
                && parts[3].len() == 4
                && parts[4].len() == 12
                && parts[2].starts_with('4')
                && parts[3].chars().next().is_some_and(|c| "89ab".contains(c))
                && parts.iter().all(|p| {
                    p.chars()
                        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
                })
        }

        for _ in 0..1000 {
            let id = Uuid::new_v4();
            let s = id.to_string();
            assert!(
                is_valid_v4(&s),
                "UUID {} does not match RFC 4122 v4 format",
                s
            );
            // Hyphenated form is 36 chars (32 hex + 4 hyphens).
            assert_eq!(s.len(), 36, "unexpected UUID string length: {}", s);
        }
    }

    #[test]
    fn tracker_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<RequestTracker>();
        assert_send_sync::<RequestRecord>();
        assert_send_sync::<RequestStatus>();
        assert_send_sync::<ProtocolVersion>();
        assert_send_sync::<HistoryRecord>();
        assert_send_sync::<HistoryStore>();
    }
}

#[cfg(test)]
#[test]
fn enqueued_at_display_returns_local_time_format() {
    let record = RequestRecord {
        id: Uuid::new_v4(),
        provider: ProviderId::new("openai"),
        model: ModelId::new("gpt-4"),
        weight: Weight::from(1.0),
        status: RequestStatus::Queued,
        enqueued_at: Instant::now(),
        acquired_at: None,
        completed_at: None,
        enqueued_at_wall: SystemTime::now(),
        client_protocol: ProtocolVersion::Http11,
        upstream_protocol: None,
        is_terminal: false,
        path: "/v1/chat/completions".to_string(),
        api_kind: ApiKind::OpenAI,
        cancellation_token: CancellationToken::new(),
        upstream_status: None,
        internal_status: None,
        ttft: None,
        first_body_frame_at: None,
        migrated_to_history: false,
        prompt_tokens: None,
        completion_tokens: None,
        cached_tokens: None,
        tps: None,
    };
    let display = record.enqueued_at_display();
    assert_eq!(display.len(), 8, "expected HH:MM:SS, got {}", display);
    assert_eq!(
        display.matches(':').count(),
        2,
        "expected two colons in {}",
        display
    );
    assert!(
        display.bytes().enumerate().all(|(i, c)| {
            if i == 2 || i == 5 {
                c == b':'
            } else {
                c.is_ascii_digit()
            }
        }),
        "expected digits at all other positions in {}",
        display
    );
}

#[cfg(test)]
#[test]
fn local_offset_label_returns_nonempty() {
    let label = local_offset_label();
    assert_eq!(label.len(), 6, "expected [+-]HH.MM, got {}", label);
    assert!(label.starts_with('+') || label.starts_with('-'));
    assert_eq!(label.as_bytes()[3], b'.');
    assert!(label[1..3].chars().all(|c| c.is_ascii_digit()));
    assert!(label[4..6].chars().all(|c| c.is_ascii_digit()));
}

#[cfg(test)]
#[test]
fn api_kind_derives_from_path() {
    let cases = [
        // Leading-slash paths (client-facing).
        ("/v1/messages", ApiKind::Anthropic),
        ("/prefix/v1/messages", ApiKind::Anthropic),
        ("/v1/messages?stream=true", ApiKind::Anthropic),
        ("/v1/messages/batch", ApiKind::Unknown),
        ("/v1/messages/", ApiKind::Unknown),
        ("/v1/chat/completions", ApiKind::OpenAI),
        ("/v1/completions", ApiKind::OpenAI),
        ("/v1/models", ApiKind::Unknown),
        ("/foo/bar", ApiKind::Unknown),
        // Provider-stripped paths (handler-normalized, no leading slash).
        ("v1/messages", ApiKind::Anthropic),
        ("v1/chat/completions", ApiKind::OpenAI),
        ("v1/completions", ApiKind::OpenAI),
        ("mock/v1/messages", ApiKind::Anthropic),
        ("mock/v1/chat/completions", ApiKind::OpenAI),
        ("v1/messages?stream=true", ApiKind::Anthropic),
        ("v1/messages/", ApiKind::Unknown),
    ];

    for (path, expected) in cases {
        assert_eq!(
            ApiKind::from_path(path),
            expected,
            "path {} should map to {:?}",
            path,
            expected
        );
    }

    assert_eq!(format!("{}", ApiKind::Anthropic), "Anthropic");
    assert_eq!(format!("{}", ApiKind::OpenAI), "OpenAI");
    assert_eq!(format!("{}", ApiKind::Unknown), "Unknown");
}

#[cfg(test)]
#[test]
fn register_queued_stores_path_and_kind() {
    let tracker = RequestTracker::new();
    let id = Uuid::new_v4();
    let path = "/v1/messages".to_string();

    tracker.register_queued(
        id,
        &ProviderId::new("anthropic"),
        &ModelId::new("claude-3"),
        Weight::from(1.0),
        ProtocolVersion::Http11,
        path.clone(),
    );

    let snap = tracker.snapshot();
    assert_eq!(snap.len(), 1);
    assert_eq!(snap[0].path, path);
    assert_eq!(snap[0].api_kind, ApiKind::Anthropic);
}

#[cfg(test)]
#[test]
fn cancel_marks_cancelled_and_returns_true() {
    let tracker = RequestTracker::new();
    let id = Uuid::new_v4();
    let provider = ProviderId::new("openai");
    let model = ModelId::new("gpt-4");
    let weight = Weight::from(1.0);

    tracker.register_queued(
        id,
        &provider,
        &model,
        weight,
        ProtocolVersion::Http11,
        "/v1/chat/completions".to_string(),
    );

    assert!(
        tracker.cancel(id),
        "cancel should return true for live record"
    );

    let snap = tracker.snapshot();
    assert_eq!(snap.len(), 1);
    assert_eq!(
        snap[0].status,
        RequestStatus::Cancelled,
        "record should be Cancelled after cancel()"
    );
    assert!(
        snap[0].is_terminal,
        "record should be terminal after cancel()"
    );

    assert!(
        !tracker.cancel(id),
        "cancel should return false for already-terminal record"
    );

    let missing = Uuid::new_v4();
    assert!(
        !tracker.cancel(missing),
        "cancel should return false for missing record"
    );
}

#[cfg(test)]
fn sample_history_record(id: Uuid) -> HistoryRecord {
    HistoryRecord {
        id,
        provider: ProviderId::new("openai"),
        model: ModelId::new("gpt-4"),
        api_kind: ApiKind::OpenAI,
        status: RequestStatus::Done,
        enqueued_at_wall: DateTime::<Utc>::from(SystemTime::now()),
        total_time: Some(Duration::from_secs(1)),
        upstream_status: Some(200),
        internal_status: None,
        ttft: Some(Duration::from_millis(100)),
        streaming_elapsed: Some(Duration::from_millis(900)),
        prompt_tokens: Some(10),
        completion_tokens: Some(20),
        cached_tokens: None,
        tps: Some(22.2),
    }
}

#[cfg(test)]
#[test]
fn history_store_fifo_eviction() {
    let mut store = HistoryStore::new(3);
    let id1 = Uuid::new_v4();
    let id2 = Uuid::new_v4();
    let id3 = Uuid::new_v4();
    let id4 = Uuid::new_v4();

    store.push(sample_history_record(id1));
    store.push(sample_history_record(id2));
    store.push(sample_history_record(id3));
    assert_eq!(store.len(), 3);

    store.push(sample_history_record(id4));
    assert_eq!(store.len(), 3, "len should stay at max after eviction");

    let snap = store.snapshot();
    let ids: Vec<Uuid> = snap.iter().map(|r| r.id).collect();
    assert!(!ids.contains(&id1), "oldest record should be evicted");
    assert!(ids.contains(&id4), "newest record should be present");
    assert_eq!(snap[0].id, id4, "newest-first ordering");
    assert_eq!(snap[2].id, id2, "second-oldest should now be last");
}

#[cfg(test)]
#[test]
fn history_store_zero_max_unlimited() {
    let mut store = HistoryStore::new(0);
    for _ in 0..5 {
        store.push(sample_history_record(Uuid::new_v4()));
    }
    assert_eq!(store.len(), 5, "unlimited store should keep all records");
}

#[cfg(test)]
#[test]
fn tracker_history_records_and_reads() {
    let tracker = RequestTracker::with_history_max(10);
    let id = Uuid::new_v4();
    tracker.register_queued(
        id,
        &ProviderId::new("openai"),
        &ModelId::new("gpt-4"),
        Weight::from(1.0),
        ProtocolVersion::Http11,
        "/v1/chat/completions".to_string(),
    );
    tracker.record_history(id);

    let hist = tracker.history();
    assert_eq!(hist.len(), 1);
    assert_eq!(hist[0].id, id);
}

#[cfg(test)]
#[test]
fn tracker_history_send_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<HistoryRecord>();
    assert_send_sync::<HistoryStore>();
}

#[cfg(test)]
#[test]
fn mark_done_migrates_to_history() {
    let tracker = RequestTracker::new();
    let id = Uuid::new_v4();
    tracker.register_queued(
        id,
        &ProviderId::new("openai"),
        &ModelId::new("gpt-4"),
        Weight::from(1.0),
        ProtocolVersion::Http11,
        "/v1/chat/completions".to_string(),
    );
    tracker.mark_running(id, None);
    tracker.mark_done(id);

    let snap = tracker.snapshot();
    assert_eq!(snap.len(), 1);
    assert!(snap[0].migrated_to_history);
    assert!(snap[0].is_terminal);
    assert_eq!(snap[0].internal_status, Some(200));

    let hist = tracker.history();
    assert_eq!(hist.len(), 1);
    assert_eq!(hist[0].id, id);
    assert_eq!(hist[0].status, RequestStatus::Done);
    assert_eq!(hist[0].internal_status, Some(200));
    assert!(hist[0].total_time.is_some());
}

#[cfg(test)]
#[test]
fn internal_status_set_on_terminal() {
    let tracker = RequestTracker::new();
    let mk = || {
        let id = Uuid::new_v4();
        tracker.register_queued(
            id,
            &ProviderId::new("openai"),
            &ModelId::new("gpt-4"),
            Weight::from(1.0),
            ProtocolVersion::Http11,
            "/v1/chat/completions".to_string(),
        );
        id
    };

    let id1 = mk();
    tracker.mark_running(id1, None);
    tracker.mark_done(id1);
    assert_eq!(
        tracker
            .snapshot()
            .iter()
            .find(|r| r.id == id1)
            .unwrap()
            .internal_status,
        Some(200)
    );

    let id2 = mk();
    tracker.mark_rejected(id2);
    assert_eq!(
        tracker
            .snapshot()
            .iter()
            .find(|r| r.id == id2)
            .unwrap()
            .internal_status,
        Some(503)
    );

    let id3 = mk();
    tracker.mark_cancelled(id3);
    assert_eq!(
        tracker
            .snapshot()
            .iter()
            .find(|r| r.id == id3)
            .unwrap()
            .internal_status,
        Some(400)
    );

    let id4 = mk();
    tracker.mark_running(id4, None);
    tracker.mark_timeout(id4);
    assert_eq!(
        tracker
            .snapshot()
            .iter()
            .find(|r| r.id == id4)
            .unwrap()
            .internal_status,
        Some(504)
    );
}

#[cfg(test)]
#[test]
fn kill_queued_request_returns_400() {
    use crate::error::GatewayError;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    let tracker = RequestTracker::new();
    let id = Uuid::new_v4();
    tracker.register_queued(
        id,
        &ProviderId::new("openai"),
        &ModelId::new("gpt-4"),
        Weight::from(1.0),
        ProtocolVersion::Http11,
        "/v1/chat/completions".to_string(),
    );

    assert!(
        tracker.cancel(id),
        "cancel should return true for live queued request"
    );

    let snap = tracker.snapshot();
    let record = snap.iter().find(|r| r.id == id).expect("record exists");
    assert_eq!(record.status, RequestStatus::Cancelled);
    assert_eq!(
        record.internal_status,
        Some(400),
        "internal_status should be 400 for killed request"
    );
    assert!(record.is_terminal);

    let resp = GatewayError::Cancelled.into_response();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        resp.headers().get("x-umans-stop-reason"),
        Some(&axum::http::HeaderValue::from_static("cancelled")),
    );
}

#[cfg(test)]
#[tokio::test]
async fn kill_releases_permit_exactly_once() {
    use crate::concurrency::{MetricUpdate, ProviderLimiter};
    use crate::dashboard::tracked_permit::TrackedPermit;
    use tokio::sync::broadcast;

    let (tx, _rx) = broadcast::channel::<MetricUpdate>(256);
    let lim = Arc::new(ProviderLimiter::new(tx));
    lim.register(
        &ProviderId::new("test"),
        Weight::from(4.0),
        Duration::from_secs(30),
        64,
    );
    let tracker = Arc::new(RequestTracker::new());
    let id = Uuid::new_v4();
    tracker.register_queued(
        id,
        &ProviderId::new("test"),
        &ModelId::new("gpt-4"),
        Weight::from(1.0),
        ProtocolVersion::Http11,
        "/v1/chat/completions".to_string(),
    );
    let permit = lim
        .acquire(
            &ProviderId::new("test"),
            &ModelId::new("gpt-4"),
            Weight::from(1.0),
        )
        .await
        .unwrap();
    tracker.mark_running(id, None);
    let token = tracker.cancellation_token(id).unwrap();
    let tracked = TrackedPermit::new(permit, id, Arc::clone(&tracker), token);

    let snap = lim.snapshot().into_iter().next().unwrap();
    assert!(
        (snap.in_flight - 1.0).abs() < 1e-6,
        "in_flight should be 1.0"
    );

    assert!(tracker.cancel(id), "cancel should return true");

    drop(tracked);

    for _ in 0..100 {
        let s = lim.snapshot().into_iter().next().unwrap();
        if (s.in_flight - 0.0).abs() < 1e-6 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let snap = lim.snapshot().into_iter().next().unwrap();
    assert!(
        (snap.in_flight - 0.0).abs() < 1e-6,
        "in_flight should be 0.0 after permit drop"
    );

    assert!(
        !tracker.cancel(id),
        "cancel should return false for terminal record (idempotent)"
    );

    let snap = lim.snapshot().into_iter().next().unwrap();
    assert!(
        (snap.in_flight - 0.0).abs() < 1e-6,
        "in_flight should still be 0.0 after idempotent cancel"
    );

    let _permit2 = lim
        .acquire(
            &ProviderId::new("test"),
            &ModelId::new("gpt-4"),
            Weight::from(1.0),
        )
        .await
        .unwrap();
    let snap = lim.snapshot().into_iter().next().unwrap();
    assert!(
        (snap.in_flight - 1.0).abs() < 1e-6,
        "in_flight should be 1.0 after re-acquire"
    );
}

#[cfg(test)]
#[test]
fn no_double_push_on_prune() {
    let tracker = RequestTracker::new();
    let id = Uuid::new_v4();
    tracker.register_queued(
        id,
        &ProviderId::new("openai"),
        &ModelId::new("gpt-4"),
        Weight::from(1.0),
        ProtocolVersion::Http11,
        "/v1/chat/completions".to_string(),
    );
    tracker.mark_done(id);

    assert_eq!(tracker.history().len(), 1);

    std::thread::sleep(Duration::from_millis(50));
    tracker.prune_stale(Duration::from_millis(25));

    assert_eq!(
        tracker.history().len(),
        1,
        "prune_stale should not double-push to history"
    );
    assert!(
        tracker.snapshot().is_empty(),
        "stale record should be pruned from live map"
    );
}

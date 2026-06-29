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

use std::fmt;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use axum::http::Version;
use chrono::{DateTime, Local};

use dashmap::DashMap;
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
        if path.contains("/v1/messages") && !path.contains("/v1/messages/") {
            ApiKind::Anthropic
        } else if path.contains("/v1/chat/completions") || path.contains("/v1/completions") {
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

/// Per-request lifecycle tracker.
///
/// Lives behind `Arc` inside `DashboardState`. The concurrency engine calls
/// `register_queued` / `mark_running` / `mark_done` / `mark_rejected` from the
/// acquire path (Task 3 hooks). A background task calls `prune_stale`
/// periodically.
#[derive(Debug)]
pub struct RequestTracker {
    requests: Arc<DashMap<Uuid, RequestRecord>>,
}

impl RequestTracker {
    /// Create an empty tracker.
    pub fn new() -> Self {
        RequestTracker {
            requests: Arc::new(DashMap::new()),
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

    /// True if the record is currently in a terminal state. Missing records are
    /// treated as terminal so that Drop guards do not attempt transitions.
    pub fn is_terminal(&self, id: Uuid) -> bool {
        self.requests
            .get(&id)
            .map_or(true, |entry| entry.is_terminal)
    }

    /// Transition a request to Done. Idempotent: no-op if already terminal.
    pub fn mark_done(&self, id: Uuid) {
        if let Some(mut entry) = self.requests.get_mut(&id) {
            if entry.is_terminal {
                return;
            }
            entry.status = RequestStatus::Done;
            entry.completed_at = Some(Instant::now());
            entry.is_terminal = true;
        }
    }

    /// Transition a request to Rejected. Idempotent: no-op if already terminal.
    pub fn mark_rejected(&self, id: Uuid) {
        if let Some(mut entry) = self.requests.get_mut(&id) {
            if entry.is_terminal {
                return;
            }
            entry.status = RequestStatus::Rejected;
            entry.completed_at = Some(Instant::now());
            entry.is_terminal = true;
        }
    }

    /// Transition a request to Cancelled. Idempotent: no-op if already terminal.
    pub fn mark_cancelled(&self, id: Uuid) {
        if let Some(mut entry) = self.requests.get_mut(&id) {
            if entry.is_terminal {
                return;
            }
            entry.status = RequestStatus::Cancelled;
            entry.completed_at = Some(Instant::now());
            entry.is_terminal = true;
        }
    }

    /// Remove Done/Rejected entries whose `completed_at` is older than
    /// `max_age`. Queued/Running entries are always retained.
    pub fn prune_stale(&self, max_age: Duration) {
        let cutoff = Instant::now()
            .checked_sub(max_age)
            .unwrap_or_else(Instant::now);
        self.requests.retain(|_, record| match record.status {
            RequestStatus::Done | RequestStatus::Rejected => {
                record.completed_at.map_or(true, |t| t > cutoff)
            }
            _ => true,
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
        assert_eq!(ProtocolVersion::from(Version::HTTP_10), ProtocolVersion::Http10);
        assert_eq!(ProtocolVersion::from(Version::HTTP_11), ProtocolVersion::Http11);
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
        tracker.register_queued(id1, &provider1, &model1, weight1, ProtocolVersion::Http11, "/v1/chat/completions".to_string());
        std::thread::sleep(Duration::from_millis(10));

        let id2 = Uuid::new_v4();
        let (id2, provider2, model2, weight2) = sample_record(id2);
        tracker.register_queued(id2, &provider2, &model2, weight2, ProtocolVersion::Http11, "/v1/chat/completions".to_string());

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

        tracker.register_queued(id, &provider, &model, weight, sample_protocol(), "/v1/chat/completions".to_string());
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

        tracker.register_queued(id, &provider, &model, weight, sample_protocol(), "/v1/chat/completions".to_string());
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
        tracker.register_queued(stale_id, &provider, &model, weight, sample_protocol(), "/v1/chat/completions".to_string());
        tracker.mark_done(stale_id);
        std::thread::sleep(Duration::from_millis(50));

        // Live Running entry — must survive pruning.
        let live_id = Uuid::new_v4();
        let (live_id, provider2, model2, weight2) = sample_record(live_id);
        tracker.register_queued(live_id, &provider2, &model2, weight2, sample_protocol(), "/v1/chat/completions".to_string());
        tracker.mark_running(live_id, None);

        // Recent Done entry — must survive pruning.
        let recent_id = Uuid::new_v4();
        let (recent_id, provider3, model3, weight3) = sample_record(recent_id);
        tracker.register_queued(recent_id, &provider3, &model3, weight3, sample_protocol(), "/v1/chat/completions".to_string());
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
        tracker.register_queued(id, &provider, &model, weight, sample_protocol(), "/v1/chat/completions".to_string());

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
                && parts[3]
                    .chars()
                    .next()
                    .is_some_and(|c| "89ab".contains(c))
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
        ("/v1/messages", ApiKind::Anthropic),
        ("/prefix/v1/messages", ApiKind::Anthropic),
        ("/v1/messages?stream=true", ApiKind::Anthropic),
        ("/v1/messages/batch", ApiKind::Unknown),
        ("/v1/messages/", ApiKind::Unknown),
        ("/v1/chat/completions", ApiKind::OpenAI),
        ("/v1/completions", ApiKind::OpenAI),
        ("/v1/models", ApiKind::Unknown),
        ("/foo/bar", ApiKind::Unknown),
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

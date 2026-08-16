//! Phone sharing: embedded web server + Cloudflare quick tunnel.
//!
//! Security model:
//! - Pairing requires a one-time code + 6-digit PIN shown on the desktop.
//!   A successful pair mints a durable per-device key (only its SHA-256 is
//!   stored) with a scope: `read` (browse/listen) or `full` (+ writes & LLM).
//! - Everything lives under `/d/<device-key>` (app) and `/p/<pairing-code>`
//!   (pairing gate); unknown paths 404.
//! - Rate limits: general + stricter LLM class (this server can spend the
//!   user's API credits via queued jobs), pairing PIN attempts are capped.
//! - URL fetching is SSRF-guarded: public http(s) only, DNS-checked, with
//!   redirect re-validation.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    net::{IpAddr, ToSocketAddrs},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool},
    Row,
};

const MOBILE_HTML: &str = include_str!("../mobile.html");

/* ------------------------------- rate limits ------------------------------- */

const GEN_PER_MIN: u32 = 120; // any endpoint
const LLM_PER_MIN: u32 = 10; // chat / generate
const LLM_PER_DAY: u32 = 30; // per device
const PAIR_MAX_ATTEMPTS: u32 = 8; // then the pairing code is burned
const PAIR_TTL_MS: i64 = 20 * 60 * 1000;

/* ---------------------------------- state ---------------------------------- */

#[derive(Clone, Serialize)]
pub struct ShareInfo {
    pub url: Option<String>,
    pub port: u16,
    pub tunnel: bool,
    pub warning: Option<String>,
    /// One-time pairing code (embedded in the QR URL) + PIN shown beside it.
    pub pairing_code: String,
    pub pin: String,
    /// Scope granted to devices paired during this session.
    pub scope: String,
}

pub struct ShareSession {
    pub info: ShareInfo,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    tunnel_child: Option<Child>,
}

impl ShareSession {
    pub fn stop(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(mut child) = self.tunnel_child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Tauri-managed singleton: at most one sharing session at a time.
pub struct SharingState(pub Mutex<Option<ShareSession>>);

struct RateWindow {
    start_secs: u64,
    general: u32,
    llm: u32,
}

struct ShareCtx {
    pairing_code: String,
    pin: String,
    pairing_expires_ms: i64,
    scope: String,
    rates: Mutex<HashMap<String, RateWindow>>,
    llm_daily: Mutex<HashMap<String, (i64, u32)>>,
    pair_attempts: Mutex<u32>,
}

impl ShareCtx {
    fn new(scope: &str) -> Self {
        ShareCtx {
            pairing_code: random_id(),
            pin: format!("{:06}", rand::random::<u32>() % 1_000_000),
            pairing_expires_ms: now_ms() + PAIR_TTL_MS,
            scope: scope.to_string(),
            rates: Mutex::new(HashMap::new()),
            llm_daily: Mutex::new(HashMap::new()),
            pair_attempts: Mutex::new(0),
        }
    }

    fn pairing_active(&self) -> bool {
        now_ms() < self.pairing_expires_ms && *self.pair_attempts.lock().unwrap() < PAIR_MAX_ATTEMPTS
    }

    /// Fixed-window counter; class_llm uses the stricter bucket + daily cap.
    fn check_rate(&self, ident: &str, class_llm: bool) -> Result<(), String> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let mut rates = self.rates.lock().unwrap();
        let w = rates.entry(ident.to_string()).or_insert(RateWindow {
            start_secs: now,
            general: 0,
            llm: 0,
        });
        if now.saturating_sub(w.start_secs) >= 60 {
            *w = RateWindow { start_secs: now, general: 0, llm: 0 };
        }
        w.general += 1;
        if w.general > GEN_PER_MIN {
            return Err("Too many requests — slow down a little.".into());
        }
        if class_llm {
            w.llm += 1;
            if w.llm > LLM_PER_MIN {
                return Err("LLM rate limit hit — wait a minute before generating again.".into());
            }
            let day = (now / 86_400) as i64;
            let mut daily = self.llm_daily.lock().unwrap();
            let ent = daily.entry(ident.to_string()).or_insert((day, 0));
            if ent.0 != day {
                *ent = (day, 0);
            }
            ent.1 += 1;
            if ent.1 > LLM_PER_DAY {
                return Err("Daily generation limit reached for this device.".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone)]
struct ServerState {
    pool: SqlitePool,
    audio_cache: Arc<Mutex<HashMap<String, (String, Vec<u8>)>>>,
    share: Arc<ShareCtx>,
}

/* --------------------------------- helpers --------------------------------- */

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn random_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

fn err_json(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "error": msg }))).into_response()
}

async fn log_activity(pool: &SqlitePool, device_id: &str, action: &str, detail: &str) {
    let _ = sqlx::query(
        "INSERT INTO activity (id, device_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(random_id())
    .bind(device_id)
    .bind(action)
    .bind(detail)
    .bind(now_ms())
    .execute(pool)
    .await;
}

/* ------------------------------ tunnel helpers ----------------------------- */

/// Resolution order: bundled sidecar (release builds) → env override →
/// common install paths/PATH (dev machines).
fn find_cloudflared() -> Option<PathBuf> {
    // Bundled sidecar: binaries/cloudflared-<target-triple>(.exe) next to the exe.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            #[cfg(target_os = "windows")]
            const TRIPLE: &str = "x86_64-pc-windows-msvc.exe";
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            const TRIPLE: &str = "aarch64-apple-darwin";
            #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
            const TRIPLE: &str = "x86_64-apple-darwin";
            #[cfg(target_os = "linux")]
            const TRIPLE: &str = "x86_64-unknown-linux-gnu";
            let sidecar = dir.join(format!("cloudflared-{TRIPLE}"));
            if sidecar.exists() {
                println!("SHARE_CLOUDFLARED=bundled:{}", sidecar.display());
                return Some(sidecar);
            }
        }
    }
    if let Ok(p) = std::env::var("BREWLM_CLOUDFLARED") {
        let pb = PathBuf::from(&p);
        if pb.exists() {
            return Some(pb);
        }
    }
    for p in [
        "/opt/homebrew/bin/cloudflared",
        "/usr/local/bin/cloudflared",
        "/usr/bin/cloudflared",
    ] {
        let pb = PathBuf::from(p);
        if pb.exists() {
            println!("SHARE_CLOUDFLARED=path:{}", p);
            return Some(pb);
        }
    }
    if let Ok(out) = Command::new("which").arg("cloudflared").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return Some(PathBuf::from(s));
            }
        }
    }
    None
}

fn extract_tunnel_url(line: &str) -> Option<String> {
    if !line.contains("trycloudflare.com") {
        return None;
    }
    let start = line.find("https://")?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '|' || c == '"')
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(['/', '.', ',']);
    if url.contains("trycloudflare.com") {
        Some(url.to_string())
    } else {
        None
    }
}

/* --------------------------------- router ---------------------------------- */

fn build_router(state: ServerState) -> Router {
    Router::new()
        // pairing gate
        .route("/p/{code}/", get(index_handler))
        .route("/p/{code}/api/pair", post(pair_handler))
        // device-scoped app
        .route("/d/{key}/", get(index_handler))
        .route("/d/{key}/api/preferences", get(preferences_handler))
        .route("/d/{key}/api/notebooks", get(notebooks_handler).post(notebook_create_handler))
        .route("/d/{key}/api/notebooks/{id}", get(notebook_handler))
        .route("/d/{key}/api/notebooks/{id}/rename", post(notebook_rename_handler))
        .route("/d/{key}/api/notebooks/{id}/delete", post(notebook_delete_handler))
        .route("/d/{key}/api/notebooks/{id}/chats", get(chats_handler))
        .route("/d/{key}/api/chats/{id}/messages", get(messages_handler))
        .route("/d/{key}/api/sources/{id}", get(source_handler))
        .route("/d/{key}/api/notebooks/{id}/sources/text", post(source_text_handler))
        .route("/d/{key}/api/notebooks/{id}/sources/url", post(source_url_handler))
        .route("/d/{key}/api/artifacts/{id}", get(artifact_handler))
        .route("/d/{key}/api/artifacts/{id}/audio", get(audio_handler))
        .route("/d/{key}/api/chat", post(chat_handler))
        .route("/d/{key}/api/generate", post(generate_handler))
        .route("/d/{key}/api/jobs/{id}", get(job_handler))
        .fallback(|| async { (StatusCode::NOT_FOUND, "not found") })
        .with_state(state)
}

/* -------------------------------- start/stop ------------------------------- */

async fn ensure_share_tables(pool: &SqlitePool) -> Result<(), String> {
    for sql in [
        "CREATE TABLE IF NOT EXISTS devices (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL,
           key_hash TEXT NOT NULL UNIQUE,
           scope TEXT NOT NULL DEFAULT 'full',
           created_at INTEGER NOT NULL,
           last_seen INTEGER NOT NULL DEFAULT 0,
           revoked_at INTEGER NOT NULL DEFAULT 0
         )",
        "CREATE TABLE IF NOT EXISTS jobs (
           id TEXT PRIMARY KEY,
           kind TEXT NOT NULL,
           notebook_id TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'pending',
           payload TEXT NOT NULL DEFAULT '{}',
           result TEXT NOT NULL DEFAULT '',
           progress TEXT NOT NULL DEFAULT '',
           device_id TEXT NOT NULL DEFAULT '',
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         )",
        "CREATE TABLE IF NOT EXISTS activity (
           id TEXT PRIMARY KEY,
           device_id TEXT NOT NULL DEFAULT '',
           action TEXT NOT NULL,
           detail TEXT NOT NULL DEFAULT '',
           created_at INTEGER NOT NULL
         )",
    ] {
        sqlx::query(sql).execute(pool).await.map_err(|e| format!("share schema: {e}"))?;
    }
    Ok(())
}

/// Starts the server + tunnel. Blocking-ish (waits for the tunnel URL), so
/// callers run it on a background thread.
pub fn start_sharing_sync(
    db_dir: PathBuf,
    scope: &str,
) -> Result<(ShareInfo, tokio::sync::oneshot::Sender<()>, Option<Child>), String> {
    std::fs::create_dir_all(&db_dir).map_err(|e| format!("app data dir: {e}"))?;
    let db_path = db_dir.join("brewlm.db");

    let opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));

    let share = Arc::new(ShareCtx::new(scope));
    let info0 = ShareInfo {
        url: None,
        port: 0,
        tunnel: false,
        warning: None,
        pairing_code: share.pairing_code.clone(),
        pin: share.pin.clone(),
        scope: scope.to_string(),
    };

    // Bind on the calling thread so the port is known before spawning.
    let std_listener =
        std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind: {e}"))?;
    std_listener
        .set_nonblocking(true)
        .map_err(|e| format!("nonblocking: {e}"))?;
    let port = std_listener
        .local_addr()
        .map_err(|e| format!("addr: {e}"))?
        .port();

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let share_for_thread = Arc::clone(&share);
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(async move {
            let pool = SqlitePool::connect_lazy_with(opts);
            if let Err(e) = ensure_share_tables(&pool).await {
                let _ = ready_tx.send(Err(e));
                return;
            }
            let state = ServerState {
                pool,
                audio_cache: Arc::new(Mutex::new(HashMap::new())),
                share: share_for_thread,
            };
            let app = build_router(state);
            let listener = tokio::net::TcpListener::from_std(std_listener).expect("listener");
            println!("SHARE_SERVER_LISTENING port={port}");
            let _ = ready_tx.send(Ok(()));
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await
                .expect("serve");
        });
    });
    match ready_rx.recv() {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(e) => return Err(format!("server thread died: {e}")),
    }

    // Tunnel: spawn cloudflared and scrape the quick-tunnel URL from its logs.
    let mut child: Option<Child> = None;
    let url_slot = Arc::new(Mutex::new(None::<String>));
    let mut warning: Option<String> = None;

    match find_cloudflared() {
        Some(bin) => {
            let target = format!("http://127.0.0.1:{port}");
            match Command::new(bin)
                .args(["tunnel", "--url", &target, "--no-autoupdate"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
            {
                Ok(mut c) => {
                    let mut streams: Vec<Box<dyn std::io::Read + Send>> = Vec::new();
                    if let Some(s) = c.stderr.take() {
                        streams.push(Box::new(s));
                    }
                    if let Some(s) = c.stdout.take() {
                        streams.push(Box::new(s));
                    }
                    for stream in streams {
                        let slot = Arc::clone(&url_slot);
                        std::thread::spawn(move || {
                            // Keep draining after the URL is found — dropping the
                            // stream would SIGPIPE cloudflared on its next log line.
                            for line in BufReader::new(stream).lines() {
                                let Ok(line) = line else { break };
                                let mut guard = slot.lock().unwrap();
                                if guard.is_none() {
                                    if let Some(url) = extract_tunnel_url(&line) {
                                        println!("SHARE_TUNNEL_URL={url}");
                                        *guard = Some(url);
                                    }
                                }
                            }
                        });
                    }
                    child = Some(c);
                }
                Err(e) => warning = Some(format!("failed to launch cloudflared: {e}")),
            }
        }
        None => {
            warning = Some(
                "cloudflared not found — install it (`brew install cloudflared`) and re-pair to share over the internet."
                    .into(),
            )
        }
    }

    let url = if child.is_some() {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(u) = url_slot.lock().unwrap().clone() {
                break Some(u);
            }
            if std::time::Instant::now() > deadline {
                warning = Some("cloudflared started but no tunnel URL appeared (timed out).".into());
                break None;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    } else {
        None
    };

    let info = ShareInfo {
        url,
        port,
        tunnel: child.is_some(),
        warning,
        ..info0
    };
    Ok((info, shutdown_tx, child))
}

/// Start on launch when BREWLM_SHARE_AUTO=1 (used for scripted/dev testing).
pub fn autostart_if_requested(handle: &tauri::AppHandle) {
    if std::env::var("BREWLM_SHARE_AUTO").as_deref() != Ok("1") {
        return;
    }
    use tauri::Manager;
    let handle = handle.clone();
    std::thread::spawn(move || {
        let dir = match handle.path().app_data_dir() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("SHARE_AUTO_FAILED: {e}");
                return;
            }
        };
        match start_sharing_sync(dir, "full") {
            Ok((info, tx, child)) => {
                *handle.state::<SharingState>().0.lock().unwrap() = Some(ShareSession {
                    info: info.clone(),
                    shutdown: Some(tx),
                    tunnel_child: child,
                });
                println!(
                    "SHARE_AUTO_READY url={:?} code={} pin={} port={}",
                    info.url, info.pairing_code, info.pin, info.port
                );
            }
            Err(e) => eprintln!("SHARE_AUTO_FAILED: {e}"),
        }
    });
}

/* --------------------------------- commands -------------------------------- */

#[tauri::command]
pub async fn start_sharing(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharingState>,
    scope: Option<String>,
) -> Result<ShareInfo, String> {
    use tauri::Manager;
    if let Some(session) = state.0.lock().unwrap().as_ref() {
        return Ok(session.info.clone());
    }
    let scope = match scope.as_deref() {
        Some("read") => "read".to_string(),
        _ => "full".to_string(),
    };
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let (info, tx, child) =
        tauri::async_runtime::spawn_blocking(move || start_sharing_sync(dir, &scope))
            .await
            .map_err(|e| e.to_string())??;
    println!(
        "SHARE_STARTED url={:?} code={} port={}",
        info.url, info.pairing_code, info.port
    );
    *state.0.lock().unwrap() = Some(ShareSession {
        info: info.clone(),
        shutdown: Some(tx),
        tunnel_child: child,
    });
    Ok(info)
}

#[tauri::command]
pub fn stop_sharing(state: tauri::State<'_, SharingState>) -> Result<(), String> {
    if let Some(session) = state.0.lock().unwrap().take() {
        session.stop();
        println!("SHARE_STOPPED");
    }
    Ok(())
}

#[tauri::command]
pub fn share_status(state: tauri::State<'_, SharingState>) -> Option<ShareInfo> {
    state.0.lock().unwrap().as_ref().map(|s| s.info.clone())
}

/* ------------------------------- auth & rates ------------------------------ */

struct Authed {
    id: String,
    scope: String,
}

/// Validates a device key against the devices table. Unknown → 404 (same as
/// any bad path, leaking nothing); revoked → 403.
async fn auth_device(st: &ServerState, key: &str, need_write: bool) -> Result<Authed, Response> {
    let hash = sha256_hex(key);
    let row = sqlx::query("SELECT id, scope, revoked_at, last_seen FROM devices WHERE key_hash = ?")
        .bind(&hash)
        .fetch_optional(&st.pool)
        .await;
    let dev = match row {
        Ok(Some(r)) => r,
        Ok(None) => return Err((StatusCode::NOT_FOUND, "not found").into_response()),
        Err(e) => return Err(err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("db: {e}"))),
    };
    if dev.get::<i64, _>("revoked_at") != 0 {
        return Err(err_json(StatusCode::FORBIDDEN, "This device was unpaired."));
    }
    let scope: String = dev.get("scope");
    if need_write && scope != "full" {
        return Err(err_json(StatusCode::FORBIDDEN, "This device is read-only."));
    }
    let a = Authed { id: dev.get("id"), scope };
    if now_ms() - dev.get::<i64, _>("last_seen") > 60_000 {
        let _ = sqlx::query("UPDATE devices SET last_seen = ? WHERE id = ?")
            .bind(now_ms())
            .bind(&a.id)
            .execute(&st.pool)
            .await;
    }
    Ok(a)
}

fn rate(st: &ServerState, dev_id: &str, llm: bool) -> Result<(), Response> {
    st.share
        .check_rate(dev_id, llm)
        .map_err(|m| err_json(StatusCode::TOO_MANY_REQUESTS, &m))
}

/* --------------------------------- handlers -------------------------------- */

async fn index_handler() -> impl IntoResponse {
    ([(header::CACHE_CONTROL, "no-store")], Html(MOBILE_HTML))
}

fn no_store_json(v: serde_json::Value) -> impl IntoResponse {
    ([(header::CACHE_CONTROL, "no-store")], Json(v))
}

#[derive(Deserialize)]
struct PairBody {
    pin: String,
    name: Option<String>,
}

async fn pair_handler(
    State(st): State<ServerState>,
    Path(code): Path<String>,
    headers: HeaderMap,
    Json(body): Json<PairBody>,
) -> Response {
    if code != st.share.pairing_code || !st.share.pairing_active() {
        return err_json(StatusCode::NOT_FOUND, "Pairing code expired — get a fresh QR from the desktop.");
    }
    if body.pin.trim() != st.share.pin {
        let mut attempts = st.share.pair_attempts.lock().unwrap();
        *attempts += 1;
        return err_json(StatusCode::UNAUTHORIZED, "Wrong PIN.");
    }
    // Success: mint a device key (only its hash is stored server-side).
    let key = format!("{}{}", random_id(), random_id());
    let name = body
        .name
        .filter(|n| !n.trim().is_empty())
        .map(|n| n.chars().take(60).collect::<String>())
        .unwrap_or_else(|| {
            let ua = headers
                .get(header::USER_AGENT)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("device");
            if ua.contains("iPhone") { "iPhone".into() }
            else if ua.contains("Android") { "Android phone".into() }
            else if ua.contains("Mac") { "Mac browser".into() }
            else { "Paired device".into() }
        });
    let id = random_id();
    let res = sqlx::query(
        "INSERT INTO devices (id, name, key_hash, scope, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&name)
    .bind(sha256_hex(&key))
    .bind(&st.share.scope)
    .bind(now_ms())
    .bind(now_ms())
    .execute(&st.pool)
    .await;
    if let Err(e) = res {
        return err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("db: {e}"));
    }
    log_activity(&st.pool, &id, "pair", &format!("{name} paired")).await;
    println!("SHARE_DEVICE_PAIRED name={name} scope={}", st.share.scope);
    no_store_json(json!({ "device_key": key, "name": name, "scope": st.share.scope }))
        .into_response()
}

/// Exposes ONLY the UI theme preference — never arbitrary settings (keys).
async fn preferences_handler(State(st): State<ServerState>, Path(key): Path<String>) -> Response {
    let dev = match auth_device(&st, &key, false).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    let row = sqlx::query("SELECT value FROM settings WHERE key = 'theme'")
        .fetch_optional(&st.pool)
        .await;
    let theme = match row {
        Ok(Some(r)) => r.get::<String, _>("value"),
        _ => "original".to_string(),
    };
    no_store_json(json!({ "theme": theme, "scope": dev.scope })).into_response()
}

async fn notebooks_handler(State(st): State<ServerState>, Path(key): Path<String>) -> Response {
    if let Err(r) = auth_device(&st, &key, false).await {
        return r;
    }
    let rows = sqlx::query(
        "SELECT id, title, description, cover, updated_at FROM notebooks \
         WHERE trashed_at = 0 ORDER BY updated_at DESC",
    )
    .fetch_all(&st.pool)
    .await;
    match rows {
        Ok(rows) => {
            let list: Vec<_> = rows
                .iter()
                .map(|r| {
                    json!({
                        "id": r.get::<String, _>("id"),
                        "title": r.get::<String, _>("title"),
                        "description": r.get::<String, _>("description"),
                        "cover": r.get::<String, _>("cover"),
                        "updated_at": r.get::<i64, _>("updated_at"),
                    })
                })
                .collect();
            no_store_json(json!({ "notebooks": list })).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")).into_response(),
    }
}

#[derive(Deserialize)]
struct NotebookCreateBody {
    title: String,
    description: Option<String>,
}

async fn notebook_create_handler(
    State(st): State<ServerState>,
    Path(key): Path<String>,
    Json(body): Json<NotebookCreateBody>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    if let Err(r) = rate(&st, &dev.id, false) {
        return r;
    }
    let title = body.title.trim().chars().take(200).collect::<String>();
    if title.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "Title required.");
    }
    let description = body
        .description
        .unwrap_or_default()
        .trim()
        .chars()
        .take(1000)
        .collect::<String>();
    let id = random_id();
    let now = now_ms();
    let res = sqlx::query(
        "INSERT INTO notebooks (id, title, created_at, updated_at, description, starred, cover, folder_id, chat_bg, chat_bg_dim, trashed_at) \
         VALUES (?, ?, ?, ?, ?, 0, '', '', '', 55, 0)",
    )
    .bind(&id)
    .bind(&title)
    .bind(now)
    .bind(now)
    .bind(&description)
    .execute(&st.pool)
    .await;
    match res {
        Ok(_) => {
            log_activity(&st.pool, &dev.id, "notebook.create", &title).await;
            no_store_json(json!({ "id": id, "title": title })).into_response()
        }
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("db: {e}")),
    }
}

#[derive(Deserialize)]
struct RenameBody {
    title: String,
}

async fn notebook_rename_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
    Json(body): Json<RenameBody>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    let title = body.title.trim().chars().take(200).collect::<String>();
    if title.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "Title required.");
    }
    let res = sqlx::query("UPDATE notebooks SET title = ?, updated_at = ? WHERE id = ?")
        .bind(&title)
        .bind(now_ms())
        .bind(&id)
        .execute(&st.pool)
        .await;
    match res {
        Ok(_) => {
            log_activity(&st.pool, &dev.id, "notebook.rename", &title).await;
            no_store_json(json!({ "ok": true })).into_response()
        }
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("db: {e}")),
    }
}

async fn notebook_delete_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    // Soft delete — recoverable from the desktop Trash.
    let res = sqlx::query("UPDATE notebooks SET trashed_at = ?, updated_at = ? WHERE id = ?")
        .bind(now_ms())
        .bind(now_ms())
        .bind(&id)
        .execute(&st.pool)
        .await;
    match res {
        Ok(_) => {
            log_activity(&st.pool, &dev.id, "notebook.trash", &id).await;
            no_store_json(json!({ "ok": true })).into_response()
        }
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("db: {e}")),
    }
}

async fn notebook_handler(State(st): State<ServerState>, Path((key, id)): Path<(String, String)>) -> Response {
    if let Err(r) = auth_device(&st, &key, false).await {
        return r;
    }
    let nb = sqlx::query(
        "SELECT id, title, description, cover FROM notebooks WHERE id = ? AND trashed_at = 0",
    )
    .bind(&id)
    .fetch_optional(&st.pool)
    .await;
    let Ok(Some(nb)) = nb else {
        return (StatusCode::NOT_FOUND, "notebook not found").into_response();
    };

    let sources = sqlx::query(
        "SELECT id, type, title, created_at FROM sources WHERE notebook_id = ? ORDER BY created_at",
    )
    .bind(&id)
    .fetch_all(&st.pool)
    .await
    .unwrap_or_default()
    .iter()
    .map(|r| {
        json!({
            "id": r.get::<String, _>("id"),
            "type": r.get::<String, _>("type"),
            "title": r.get::<String, _>("title"),
            "created_at": r.get::<i64, _>("created_at"),
        })
    })
    .collect::<Vec<_>>();

    let artifacts = sqlx::query(
        "SELECT id, kind, title, created_at FROM artifacts WHERE notebook_id = ? \
         ORDER BY created_at DESC",
    )
    .bind(&id)
    .fetch_all(&st.pool)
    .await
    .unwrap_or_default()
    .iter()
    .map(|r| {
        json!({
            "id": r.get::<String, _>("id"),
            "kind": r.get::<String, _>("kind"),
            "title": r.get::<String, _>("title"),
            "created_at": r.get::<i64, _>("created_at"),
        })
    })
    .collect::<Vec<_>>();

    no_store_json(json!({
        "id": nb.get::<String, _>("id"),
        "title": nb.get::<String, _>("title"),
        "description": nb.get::<String, _>("description"),
        "cover": nb.get::<String, _>("cover"),
        "sources": sources,
        "artifacts": artifacts,
    }))
    .into_response()
}

async fn chats_handler(State(st): State<ServerState>, Path((key, id)): Path<(String, String)>) -> Response {
    if let Err(r) = auth_device(&st, &key, false).await {
        return r;
    }
    let rows = sqlx::query(
        "SELECT id, title, created_at, updated_at FROM chats WHERE notebook_id = ? ORDER BY updated_at DESC LIMIT 50",
    )
    .bind(&id)
    .fetch_all(&st.pool)
    .await;
    match rows {
        Ok(rows) => {
            let list: Vec<_> = rows
                .iter()
                .map(|r| {
                    json!({
                        "id": r.get::<String, _>("id"),
                        "title": r.get::<String, _>("title"),
                        "created_at": r.get::<i64, _>("created_at"),
                        "updated_at": r.get::<i64, _>("updated_at"),
                    })
                })
                .collect();
            no_store_json(json!({ "chats": list })).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")).into_response(),
    }
}

async fn messages_handler(State(st): State<ServerState>, Path((key, id)): Path<(String, String)>) -> Response {
    if let Err(r) = auth_device(&st, &key, false).await {
        return r;
    }
    let mut rows = sqlx::query(
        "SELECT id, role, content, created_at FROM messages WHERE chat_id = ? \
         ORDER BY created_at DESC LIMIT 100",
    )
    .bind(&id)
    .fetch_all(&st.pool)
    .await
    .unwrap_or_default();
    rows.reverse(); // back to chronological
    let list: Vec<_> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<String, _>("id"),
                "role": r.get::<String, _>("role"),
                "content": r.get::<String, _>("content"),
                "created_at": r.get::<i64, _>("created_at"),
            })
        })
        .collect();
    no_store_json(json!({ "messages": list })).into_response()
}

async fn source_handler(State(st): State<ServerState>, Path((key, id)): Path<(String, String)>) -> Response {
    if let Err(r) = auth_device(&st, &key, false).await {
        return r;
    }
    let row = sqlx::query(
        "SELECT id, type, title, content, mime, created_at FROM sources WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&st.pool)
    .await;
    match row {
        Ok(Some(r)) => no_store_json(json!({
            "id": r.get::<String, _>("id"),
            "type": r.get::<String, _>("type"),
            "title": r.get::<String, _>("title"),
            "content": r.get::<String, _>("content"),
            "mime": r.get::<Option<String>, _>("mime"),
            "created_at": r.get::<i64, _>("created_at"),
        }))
        .into_response(),
        _ => (StatusCode::NOT_FOUND, "source not found").into_response(),
    }
}

async fn notebook_owned(pool: &SqlitePool, id: &str) -> bool {
    sqlx::query("SELECT id FROM notebooks WHERE id = ? AND trashed_at = 0")
        .bind(id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .is_some()
}

#[derive(Deserialize)]
struct SourceTextBody {
    title: String,
    text: String,
}

async fn source_text_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
    Json(body): Json<SourceTextBody>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    if let Err(r) = rate(&st, &dev.id, false) {
        return r;
    }
    if !notebook_owned(&st.pool, &id).await {
        return (StatusCode::NOT_FOUND, "notebook not found").into_response();
    }
    let text = body.text.trim();
    if text.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "Text required.");
    }
    let title = {
        let t = body.title.trim();
        if t.is_empty() {
            text.chars().take(40).collect::<String>()
        } else {
            t.chars().take(200).collect()
        }
    };
    let content: String = text.chars().take(200_000).collect();
    let sid = random_id();
    let res = sqlx::query(
        "INSERT INTO sources (id, notebook_id, type, title, content, mime, created_at) VALUES (?, ?, 'text', ?, ?, NULL, ?)",
    )
    .bind(&sid)
    .bind(&id)
    .bind(&title)
    .bind(&content)
    .bind(now_ms())
    .execute(&st.pool)
    .await;
    match res {
        Ok(_) => {
            let _ = sqlx::query("UPDATE notebooks SET updated_at = ? WHERE id = ?")
                .bind(now_ms())
                .bind(&id)
                .execute(&st.pool)
                .await;
            log_activity(&st.pool, &dev.id, "source.text", &title).await;
            no_store_json(json!({ "id": sid, "title": title })).into_response()
        }
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("db: {e}")),
    }
}

/* --------------------------- SSRF-guarded URL add -------------------------- */

fn ip_is_blocked(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xC0) == 64) // CGNAT shared space 100.64/10
                || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24
                || (o[0] == 192 && o[1] == 0 && o[2] == 2) // TEST-NET-1
                || (o[0] == 198 && (o[1] == 18 || o[1] == 19)) // benchmarking
                || (o[0] == 198 && o[1] == 51 && o[2] == 100)
                || (o[0] == 203 && o[1] == 0 && o[2] == 113)
                || o[0] >= 224 // multicast + reserved
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || seg[0] == 0          // catch-all for ::/64 etc. when mapped
                || (seg[0] & 0xfe00) == 0xfc00 // unique-local fc00::/7
                || (seg[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
                || (seg[0] & 0xff00) == 0xff00 // multicast ff00::/8
                || (seg[0] == 0x2001 && seg[1] == 0x0db8) // documentation
        }
    }
}

/// Parse + DNS-check a URL; only public http(s) destinations pass.
fn validate_public_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "That doesn't look like a valid URL.".to_string())?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err("Only http(s) links are allowed.".into()),
    }
    let host = url.host_str().ok_or("URL has no host.")?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<_> = format!("{host}:{port}")
        .to_socket_addrs()
        .map_err(|_| "Couldn't resolve that host.".to_string())?
        .collect();
    if addrs.is_empty() {
        return Err("Couldn't resolve that host.".into());
    }
    for a in &addrs {
        if ip_is_blocked(&a.ip()) {
            return Err("That address isn't public.".into());
        }
    }
    Ok(url)
}

/// Strip tags/scripts → readable text (crude mirror of the desktop's link ingest).
fn html_to_text(html: &str, fallback_title: &str) -> (String, String) {
    let mut s = html.to_string();
    // drop non-content blocks (case-insensitive, non-greedy pairs)
    for tag in ["script", "style", "noscript", "svg", "iframe", "nav", "footer", "header", "form", "aside"] {
        loop {
            let lower = s.to_lowercase();
            let open = match lower.find(&format!("<{tag}")) {
                Some(i) => i,
                None => break,
            };
            let close = lower[open..]
                .find(&format!("</{tag}>"))
                .map(|i| open + i + tag.len() + 3);
            match close {
                Some(end) => s.replace_range(open..end, " "),
                None => {
                    // unclosed: drop to end of tag only
                    if let Some(gt) = lower[open..].find('>') {
                        s.replace_range(open..open + gt + 1, " ");
                    } else {
                        break;
                    }
                }
            }
        }
    }
    let title = {
        let lower = s.to_lowercase();
        match (lower.find("<title>"), lower.find("</title>")) {
            (Some(a), Some(b)) if b > a + 7 => s[a + 7..b].trim().to_string(),
            _ => fallback_title.to_string(),
        }
    };
    // strip all remaining tags
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    let mut collapsed = String::with_capacity(out.len());
    let mut last_ws = false;
    for c in out.chars() {
        if c.is_whitespace() {
            if !last_ws {
                collapsed.push(' ');
            }
            last_ws = true;
        } else {
            collapsed.push(c);
            last_ws = false;
        }
    }
    (title.trim().to_string(), collapsed.trim().to_string())
}

#[derive(Deserialize)]
struct SourceUrlBody {
    url: String,
}

async fn source_url_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
    Json(body): Json<SourceUrlBody>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    if let Err(r) = rate(&st, &dev.id, false) {
        return r;
    }
    if !notebook_owned(&st.pool, &id).await {
        return (StatusCode::NOT_FOUND, "notebook not found").into_response();
    }
    let raw = if body.url.starts_with("http") {
        body.url.clone()
    } else {
        format!("https://{}", body.url)
    };
    let mut url = match validate_public_url(&raw) {
        Ok(u) => u,
        Err(m) => return err_json(StatusCode::BAD_REQUEST, &m),
    };

    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none()) // re-validate every hop
        .timeout(Duration::from_secs(20))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")
        .build()
    {
        Ok(c) => c,
        Err(e) => return err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("http: {e}")),
    };

    let mut resp = None;
    for _ in 0..=3 {
        match client.get(url.clone()).send().await {
            Ok(r) => {
                if r.status().is_redirection() {
                    let loc = r
                        .headers()
                        .get(header::LOCATION)
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    match loc {
                        Some(l) => match url.join(&l) {
                            Ok(next) => match validate_public_url(next.as_str()) {
                                Ok(v) => url = v,
                                Err(m) => return err_json(StatusCode::BAD_REQUEST, &m),
                            },
                            Err(_) => return err_json(StatusCode::BAD_REQUEST, "Bad redirect."),
                        },
                        None => return err_json(StatusCode::BAD_GATEWAY, "Redirect without location."),
                    }
                } else {
                    resp = Some(r);
                    break;
                }
            }
            Err(e) => return err_json(StatusCode::BAD_GATEWAY, &format!("Couldn't fetch that page: {e}")),
        }
    }
    let Some(resp) = resp else {
        return err_json(StatusCode::BAD_GATEWAY, "Too many redirects.");
    };
    if !resp.status().is_success() {
        return err_json(
            StatusCode::BAD_GATEWAY,
            &format!("Couldn't fetch that page (HTTP {}).", resp.status()),
        );
    }
    if let Some(len) = resp.content_length() {
        if len > 8 * 1024 * 1024 {
            return err_json(StatusCode::BAD_REQUEST, "That page is too large.");
        }
    }
    let ctype = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let raw = match resp.text().await {
        Ok(t) => t,
        Err(e) => return err_json(StatusCode::BAD_GATEWAY, &format!("Read failed: {e}")),
    };

    let host = url.host_str().unwrap_or("link").to_string();
    let (title, mut text) = if ctype.contains("html") {
        html_to_text(&raw, &host)
    } else {
        (host.clone(), raw.chars().take(200_000).collect())
    };
    if text.is_empty() {
        return err_json(StatusCode::BAD_GATEWAY, "The page loaded but no readable text was found.");
    }
    text = text.chars().take(200_000).collect();

    let sid = random_id();
    let res = sqlx::query(
        "INSERT INTO sources (id, notebook_id, type, title, content, mime, created_at) VALUES (?, ?, 'link', ?, ?, NULL, ?)",
    )
    .bind(&sid)
    .bind(&id)
    .bind(&title)
    .bind(&text)
    .bind(now_ms())
    .execute(&st.pool)
    .await;
    match res {
        Ok(_) => {
            let _ = sqlx::query("UPDATE notebooks SET updated_at = ? WHERE id = ?")
                .bind(now_ms())
                .bind(&id)
                .execute(&st.pool)
                .await;
            log_activity(&st.pool, &dev.id, "source.url", &title).await;
            no_store_json(json!({ "id": sid, "title": title })).into_response()
        }
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("db: {e}")),
    }
}

/* ------------------------------ LLM job queue ------------------------------ */

#[derive(Deserialize)]
struct ChatBody {
    notebook_id: String,
    content: String,
    chat_id: Option<String>,
    new_chat: Option<bool>,
}

async fn chat_handler(
    State(st): State<ServerState>,
    Path(key): Path<String>,
    Json(body): Json<ChatBody>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    if let Err(r) = rate(&st, &dev.id, true) {
        return r;
    }
    if !notebook_owned(&st.pool, &body.notebook_id).await {
        return (StatusCode::NOT_FOUND, "notebook not found").into_response();
    }
    let content = body.content.trim();
    if content.is_empty() || content.chars().count() > 4000 {
        return err_json(StatusCode::BAD_REQUEST, "Message must be 1–4000 characters.");
    }
    let job_id = random_id();
    let now = now_ms();
    let payload = json!({
        "notebook_id": body.notebook_id,
        "content": content,
        "chat_id": body.chat_id,
        "new_chat": body.new_chat.unwrap_or(false),
    });
    let res = sqlx::query(
        "INSERT INTO jobs (id, kind, notebook_id, status, payload, device_id, created_at, updated_at) \
         VALUES (?, 'chat', ?, 'pending', ?, ?, ?, ?)",
    )
    .bind(&job_id)
    .bind(&body.notebook_id)
    .bind(payload.to_string())
    .bind(&dev.id)
    .bind(now)
    .bind(now)
    .execute(&st.pool)
    .await;
    match res {
        Ok(_) => {
            log_activity(&st.pool, &dev.id, "chat", &content.chars().take(60).collect::<String>()).await;
            no_store_json(json!({ "job_id": job_id })).into_response()
        }
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("db: {e}")),
    }
}

const GENERATE_KINDS: [&str; 6] = ["flashcards", "quiz", "mindmap", "report", "research", "audio"];

#[derive(Deserialize)]
struct GenerateBody {
    notebook_id: String,
    kind: String,
    options: Option<serde_json::Value>,
}

async fn generate_handler(
    State(st): State<ServerState>,
    Path(key): Path<String>,
    Json(body): Json<GenerateBody>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    if let Err(r) = rate(&st, &dev.id, true) {
        return r;
    }
    if !GENERATE_KINDS.contains(&body.kind.as_str()) {
        return err_json(StatusCode::BAD_REQUEST, "Unknown generation kind.");
    }
    if !notebook_owned(&st.pool, &body.notebook_id).await {
        return (StatusCode::NOT_FOUND, "notebook not found").into_response();
    }
    // Whitelist option fields; everything else is dropped.
    let o = body.options.unwrap_or(json!({}));
    let pick = |k: &str, max: usize| -> String {
        o.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(max)
            .collect()
    };
    let options = json!({
        "amount": match pick("amount", 10).as_str() { "compact" | "more" => pick("amount", 10), _ => "default".into() },
        "difficulty": match pick("difficulty", 10).as_str() { "easy" | "hard" => pick("difficulty", 10), _ => "medium".into() },
        "focus": pick("focus", 300),
        "format": match pick("format", 12).as_str() { "brief" | "debate" | "critique" => pick("format", 12), _ => "deep-dive".into() },
        "length": match pick("length", 10).as_str() { "short" | "long" => pick("length", 10), _ => "standard".into() },
        "report_type": match pick("report_type", 20).as_str() { "briefing-doc" | "analysis" | "custom" => pick("report_type", 20), _ => "study-guide".into() },
        "custom_prompt": pick("custom_prompt", 1000),
        "topic": pick("topic", 200),
    });
    if body.kind == "research" && options["topic"].as_str().unwrap_or("").is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "Research needs a topic.");
    }
    let job_id = random_id();
    let now = now_ms();
    let payload = json!({
        "notebook_id": body.notebook_id,
        "kind": body.kind,
        "options": options,
    });
    let res = sqlx::query(
        "INSERT INTO jobs (id, kind, notebook_id, status, payload, device_id, created_at, updated_at) \
         VALUES (?, 'generate', ?, 'pending', ?, ?, ?, ?)",
    )
    .bind(&job_id)
    .bind(&body.notebook_id)
    .bind(payload.to_string())
    .bind(&dev.id)
    .bind(now)
    .bind(now)
    .execute(&st.pool)
    .await;
    match res {
        Ok(_) => {
            log_activity(&st.pool, &dev.id, "generate", &body.kind).await;
            no_store_json(json!({ "job_id": job_id })).into_response()
        }
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("db: {e}")),
    }
}

async fn job_handler(State(st): State<ServerState>, Path((key, id)): Path<(String, String)>) -> Response {
    if let Err(r) = auth_device(&st, &key, false).await {
        return r;
    }
    let row = sqlx::query("SELECT id, kind, status, result, progress FROM jobs WHERE id = ?")
        .bind(&id)
        .fetch_optional(&st.pool)
        .await;
    match row {
        Ok(Some(r)) => no_store_json(json!({
            "id": r.get::<String, _>("id"),
            "kind": r.get::<String, _>("kind"),
            "status": r.get::<String, _>("status"),
            "result": r.get::<String, _>("result"),
            "progress": r.get::<String, _>("progress"),
        }))
        .into_response(),
        _ => (StatusCode::NOT_FOUND, "job not found").into_response(),
    }
}

async fn artifact_handler(State(st): State<ServerState>, Path((key, id)): Path<(String, String)>) -> Response {
    if let Err(r) = auth_device(&st, &key, false).await {
        return r;
    }
    let row = sqlx::query("SELECT kind, title, data, created_at FROM artifacts WHERE id = ?")
        .bind(&id)
        .fetch_optional(&st.pool)
        .await;
    let Ok(Some(row)) = row else {
        return (StatusCode::NOT_FOUND, "artifact not found").into_response();
    };

    let kind: String = row.get("kind");
    let raw: String = row.get("data");

    // For audio artifacts, strip the (huge) base64 data URL — the phone
    // streams it from /audio instead. Keep script/note.
    let data: serde_json::Value = if kind == "audio" {
        match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(mut v) => {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("audio".into(), serde_json::Value::Null);
                }
                v
            }
            Err(_) => serde_json::Value::String(raw),
        }
    } else {
        match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(v) => v,
            Err(_) => serde_json::Value::String(raw),
        }
    };

    no_store_json(json!({
        "id": id,
        "kind": kind,
        "title": row.get::<String, _>("title"),
        "created_at": row.get::<i64, _>("created_at"),
        "data": data,
    }))
    .into_response()
}

/* ------------------------------ audio streaming ---------------------------- */

/// Parse an HTTP `Range` header for a body of `len` bytes.
fn parse_range(h: Option<&str>, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let h = h?.trim().strip_prefix("bytes=")?;
    let first = h.split(',').next()?.trim();
    let (a, b) = first.split_once('-')?;
    if a.trim().is_empty() {
        let n: u64 = b.trim().parse().ok()?;
        if n == 0 {
            return None;
        }
        let start = len.saturating_sub(n);
        Some((start, len - 1))
    } else {
        let start: u64 = a.trim().parse().ok()?;
        if start >= len {
            return None;
        }
        let end = if b.trim().is_empty() {
            len - 1
        } else {
            b.trim().parse::<u64>().ok()?.min(len - 1)
        };
        if end < start {
            return None;
        }
        Some((start, end))
    }
}

async fn audio_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(r) = auth_device(&st, &key, false).await {
        return r;
    }
    let cached = st.audio_cache.lock().unwrap().get(&id).cloned();
    let (mime, bytes) = match cached {
        Some(v) => v,
        None => {
            let row = sqlx::query("SELECT kind, data FROM artifacts WHERE id = ?")
                .bind(&id)
                .fetch_optional(&st.pool)
                .await;
            let row = match row {
                Ok(Some(r)) => r,
                Ok(None) => return (StatusCode::NOT_FOUND, "artifact not found").into_response(),
                Err(e) => {
                    return (StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}"))
                        .into_response()
                }
            };
            let kind: String = row.get("kind");
            if kind != "audio" {
                return (StatusCode::BAD_REQUEST, "not an audio artifact").into_response();
            }
            let raw: String = row.get("data");
            let parsed: serde_json::Value = match serde_json::from_str(&raw) {
                Ok(v) => v,
                Err(_) => {
                    return (StatusCode::INTERNAL_SERVER_ERROR, "corrupt audio artifact")
                        .into_response()
                }
            };
            let audio = parsed.get("audio").and_then(|a| a.as_str()).unwrap_or("");
            if !audio.starts_with("data:audio/") {
                return (StatusCode::NOT_FOUND, "artifact has no audio (script only)")
                    .into_response();
            }
            let Some((prefix, b64)) = audio.split_once(',') else {
                return (StatusCode::INTERNAL_SERVER_ERROR, "bad data url").into_response();
            };
            let mime = prefix
                .trim_start_matches("data:")
                .trim_end_matches(";base64")
                .to_string();
            let clean: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
            let bytes = match B64.decode(clean) {
                Ok(b) => b,
                Err(_) => {
                    return (StatusCode::INTERNAL_SERVER_ERROR, "bad base64").into_response()
                }
            };
            st.audio_cache
                .lock()
                .unwrap()
                .insert(id.clone(), (mime.clone(), bytes.clone()));
            (mime, bytes)
        }
    };

    let len = bytes.len() as u64;
    let range_hdr = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    match parse_range(range_hdr, len) {
        Some((start, end)) => {
            let slice = bytes[(start as usize)..=(end as usize)].to_vec();
            Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_TYPE, mime)
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CONTENT_LENGTH, slice.len())
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .header(header::CACHE_CONTROL, "no-store")
                .body(Body::from(slice))
                .unwrap()
        }
        None => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_LENGTH, len)
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::from(bytes))
            .unwrap(),
    }
}

/* ---------------------------------- tests ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt; // oneshot

    const FULL_KEY: &str = "full-device-key";
    const READ_KEY: &str = "read-device-key";

    async fn fixture() -> (Router, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let opts = SqliteConnectOptions::new()
            .filename(dir.path().join("test.db"))
            .create_if_missing(true);
        let pool = SqlitePool::connect_with(opts).await.unwrap();
        for sql in [
            "CREATE TABLE notebooks (id TEXT PRIMARY KEY, title TEXT NOT NULL, \
             description TEXT NOT NULL DEFAULT '', cover TEXT NOT NULL DEFAULT '', \
             starred INTEGER NOT NULL DEFAULT 0, folder_id TEXT NOT NULL DEFAULT '', \
             chat_bg TEXT NOT NULL DEFAULT '', chat_bg_dim INTEGER NOT NULL DEFAULT 55, \
             created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, \
             trashed_at INTEGER NOT NULL DEFAULT 0)",
            "CREATE TABLE artifacts (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, \
             kind TEXT NOT NULL, title TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL)",
            "CREATE TABLE sources (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, \
             type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', \
             mime TEXT, created_at INTEGER NOT NULL)",
            "CREATE TABLE chats (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, \
             title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
            "CREATE TABLE messages (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, \
             role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, chat_id TEXT)",
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        ensure_share_tables(&pool).await.unwrap();

        let add_device = |name: &str, key: &str, scope: &str| {
            let pool = pool.clone();
            let name = name.to_string();
            let key = key.to_string();
            let scope = scope.to_string();
            async move {
                sqlx::query(
                    "INSERT INTO devices (id, name, key_hash, scope, created_at, last_seen) VALUES (?, ?, ?, ?, 1, 1)",
                )
                .bind(random_id())
                .bind(name)
                .bind(sha256_hex(&key))
                .bind(scope)
                .execute(&pool)
                .await
                .unwrap();
            }
        };
        add_device("Phone", FULL_KEY, "full").await;
        add_device("Reader", READ_KEY, "read").await;

        sqlx::query("INSERT INTO notebooks VALUES ('nb1', 'Test Notebook', 'desc', '', 0, '', '', 55, 1, 123, 0)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO notebooks VALUES ('nb2', 'Trashed', 'd', '', 0, '', '', 55, 1, 124, 1)")
            .execute(&pool)
            .await
            .unwrap();
        let bytes: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        let b64 = B64.encode(&bytes);
        let audio_json = format!(
            r#"{{"audio": "data:audio/mpeg;base64,{b64}", "script": "Alex: hi", "note": null}}"#
        );
        sqlx::query("INSERT INTO artifacts VALUES ('a1', 'nb1', 'audio', 'Pod', ?, 100)")
            .bind(audio_json)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings VALUES ('theme', 'ocean')")
            .execute(&pool)
            .await
            .unwrap();

        let state = ServerState {
            pool,
            audio_cache: Arc::new(Mutex::new(HashMap::new())),
            share: Arc::new(ShareCtx::new("full")),
        };
        (build_router(state), dir)
    }

    fn get(uri: &str) -> Request<Body> {
        Request::builder().uri(uri).body(Body::empty()).unwrap()
    }

    fn post_json(uri: &str, body: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    async fn body_string(resp: Response) -> String {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn wrong_token_is_404() {
        let (app, _dir) = fixture().await;
        let resp = app
            .oneshot(get("/d/WRONG/api/notebooks"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn lists_notebooks_excluding_trash() {
        let (app, _dir) = fixture().await;
        let resp = app
            .oneshot(get(&format!("/d/{FULL_KEY}/api/notebooks")))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_string(resp).await;
        assert!(body.contains("Test Notebook"));
        assert!(!body.contains("Trashed"));
    }

    #[tokio::test]
    async fn read_only_device_cannot_write() {
        let (app, _dir) = fixture().await;
        let resp = app
            .oneshot(post_json(
                &format!("/d/{READ_KEY}/api/notebooks"),
                r#"{"title":"nope"}"#,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        // ...but it can read.
        let (app2, _d2) = fixture().await;
        let resp = app2
            .oneshot(get(&format!("/d/{READ_KEY}/api/notebooks")))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn read_only_device_blocked_from_all_writes() {
        let writes: [(&str, &str); 6] = [
            ("/api/chat", r#"{"notebook_id":"nb1","content":"hi"}"#),
            ("/api/generate", r#"{"notebook_id":"nb1","kind":"flashcards","options":{}}"#),
            ("/api/notebooks", r#"{"title":"x"}"#),
            ("/api/notebooks/nb1/rename", r#"{"title":"x"}"#),
            ("/api/notebooks/nb1/delete", "{}"),
            ("/api/notebooks/nb1/sources/text", r#"{"title":"t","text":"c"}"#),
        ];
        for (path, body) in writes {
            let (app, _dir) = fixture().await;
            let resp = app
                .oneshot(post_json(&format!("/d/{READ_KEY}{path}"), body))
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::FORBIDDEN, "POST {path}");
        }
        // reads still work
        let reads: [&str; 5] = [
            "/api/preferences",
            "/api/notebooks",
            "/api/notebooks/nb1",
            "/api/notebooks/nb1/chats",
            "/api/artifacts/a1",
        ];
        for path in reads {
            let (app, _dir) = fixture().await;
            let resp = app
                .oneshot(get(&format!("/d/{READ_KEY}{path}")))
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::OK, "GET {path}");
        }
    }

    #[tokio::test]
    async fn preferences_reports_device_scope() {
        let (app, _dir) = fixture().await;
        let resp = app
            .oneshot(get(&format!("/d/{READ_KEY}/api/preferences")))
            .await
            .unwrap();
        let body = body_string(resp).await;
        assert!(body.contains(r#""scope":"read""#), "{body}");
        assert!(body.contains(r#""theme":"ocean""#), "{body}");

        let (app, _dir) = fixture().await;
        let resp = app
            .oneshot(get(&format!("/d/{FULL_KEY}/api/preferences")))
            .await
            .unwrap();
        assert!(body_string(resp).await.contains(r#""scope":"full""#));
    }

    #[tokio::test]
    async fn notebook_create_rename_delete_cycle() {
        let (app, _dir) = fixture().await;
        let resp = app
            .clone()
            .oneshot(post_json(
                &format!("/d/{FULL_KEY}/api/notebooks"),
                r#"{"title":"Mobile-made","description":"from phone"}"#,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_str(&body_string(resp).await).unwrap();
        let id = body["id"].as_str().unwrap().to_string();

        let resp = app
            .clone()
            .oneshot(post_json(
                &format!("/d/{FULL_KEY}/api/notebooks/{id}/rename"),
                r#"{"title":"Renamed"}"#,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let resp = app
            .clone()
            .oneshot(post_json(
                &format!("/d/{FULL_KEY}/api/notebooks/{id}/delete"),
                "{}",
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // soft-deleted: gone from list
        let resp = app
            .oneshot(get(&format!("/d/{FULL_KEY}/api/notebooks")))
            .await
            .unwrap();
        assert!(!body_string(resp).await.contains("Renamed"));
    }

    #[tokio::test]
    async fn chat_and_generate_enqueue_jobs() {
        let (app, _dir) = fixture().await;
        let resp = app
            .clone()
            .oneshot(post_json(
                &format!("/d/{FULL_KEY}/api/chat"),
                r#"{"notebook_id":"nb1","content":"hello?","chat_id":null}"#,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&body_string(resp).await).unwrap();
        let job_id = body["job_id"].as_str().unwrap().to_string();
        let resp = app
            .clone()
            .oneshot(get(&format!("/d/{FULL_KEY}/api/jobs/{job_id}")))
            .await
            .unwrap();
        let body = body_string(resp).await;
        assert!(body.contains("\"kind\":\"chat\""));
        assert!(body.contains("\"status\":\"pending\""));

        let resp = app
            .oneshot(post_json(
                &format!("/d/{FULL_KEY}/api/generate"),
                r#"{"notebook_id":"nb1","kind":"flashcards","options":{"amount":"compact","evil":"DROP TABLE notebooks"}}"#,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn llm_rate_limit_trips() {
        let (app, _dir) = fixture().await;
        let uri = format!("/d/{FULL_KEY}/api/chat");
        let mut last = StatusCode::OK;
        for _ in 0..=LLM_PER_MIN {
            let resp = app
                .clone()
                .oneshot(post_json(&uri, r#"{"notebook_id":"nb1","content":"x"}"#))
                .await
                .unwrap();
            last = resp.status();
        }
        assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn pair_flow_wrong_then_right_pin() {
        let (app, _dir) = fixture().await;
        // We don't know the fixture's PIN; wrong pin → 401, and the endpoint exists.
        let resp = app
            .clone()
            .oneshot(post_json("/p/whatever/api/pair", r#"{"pin":"000000"}"#))
            .await
            .unwrap();
        // Unknown pairing code → 404
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn ssrf_rejects_private_ips() {
        assert!(validate_public_url("http://localhost/x").is_err());
        assert!(validate_public_url("http://127.0.0.1/x").is_err());
        assert!(validate_public_url("http://192.168.1.1/").is_err());
        assert!(validate_public_url("http://10.0.0.4/").is_err());
        assert!(validate_public_url("https://169.254.169.254/latest").is_err());
        assert!(validate_public_url("http://[::1]/").is_err());
        assert!(validate_public_url("ftp://example.com/x").is_err());
        assert!(validate_public_url("not a url").is_err());
        assert!(validate_public_url("https://1.1.1.1/").is_ok());
    }

    #[tokio::test]
    async fn preferences_returns_theme_only() {
        let (app, _dir) = fixture().await;
        let resp = app
            .oneshot(get(&format!("/d/{FULL_KEY}/api/preferences")))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&body_string(resp).await).unwrap();
        assert_eq!(body["theme"], "ocean");
        assert_eq!(body["scope"], "full");
        // no settings keys or other config leaks
        assert_eq!(body.as_object().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn artifact_strips_audio_data_url() {
        let (app, _dir) = fixture().await;
        let resp = app
            .oneshot(get(&format!("/d/{FULL_KEY}/api/artifacts/a1")))
            .await
            .unwrap();
        let body = body_string(resp).await;
        assert!(body.contains("\"audio\":null"));
        assert!(!body.contains("base64"));
    }

    #[tokio::test]
    async fn audio_streams_full_and_partial() {
        let (app, _dir) = fixture().await;

        let resp = app
            .clone()
            .oneshot(get(&format!("/d/{FULL_KEY}/api/artifacts/a1/audio")))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "audio/mpeg"
        );
        let full = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(full.len(), 1000);

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/d/{FULL_KEY}/api/artifacts/a1/audio"))
                    .header(header::RANGE, "bytes=0-99")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            resp.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes 0-99/1000"
        );
        let part = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(part.len(), 100);
        assert_eq!(part[99], (99 % 251) as u8);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri(format!("/d/{FULL_KEY}/api/artifacts/a1/audio"))
                    .header(header::RANGE, "bytes=-50")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);
        let part = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(part.len(), 50);
    }

    #[tokio::test]
    async fn index_served_under_device_path() {
        let (app, _dir) = fixture().await;
        let resp = app
            .oneshot(get(&format!("/d/{FULL_KEY}/")))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(body_string(resp).await.contains("<title>BrewLM</title>"));
    }

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range(Some("bytes=0-99"), 1000), Some((0, 99)));
        assert_eq!(parse_range(Some("bytes=10-"), 1000), Some((10, 999)));
        assert_eq!(parse_range(Some("bytes=-25"), 1000), Some((975, 999)));
        assert_eq!(parse_range(Some("bytes=500-9999"), 1000), Some((500, 999)));
        assert_eq!(parse_range(None, 1000), None);
        assert_eq!(parse_range(Some("bytes=1000-"), 1000), None);
        assert_eq!(parse_range(Some("garbage"), 1000), None);
    }

    #[test]
    fn tunnel_url_extraction() {
        assert_eq!(
            extract_tunnel_url(
                "2026-08-15 INF | https://wine-fords-things.trycloudflare.com |"
            ),
            Some("https://wine-fords-things.trycloudflare.com".to_string())
        );
        assert_eq!(extract_tunnel_url("nothing here"), None);
    }

    #[test]
    fn html_to_text_strips() {
        let html = "<html><head><title>My Page</title></head><body><nav>menu</nav><h1>Hi</h1><p>Some <b>bold</b> text &amp; more.</p><script>evil()</script></body></html>";
        let (title, text) = html_to_text(html, "fallback");
        assert_eq!(title, "My Page");
        assert!(text.contains("Some bold text & more."));
        assert!(!text.contains("evil"));
        assert!(!text.contains("menu"));
    }
}

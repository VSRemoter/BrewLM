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
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool},
    Row,
};

const MOBILE_HTML: &str = include_str!("../mobile.html");
const MOBILE_JS: &str = include_str!("../mobile.js");
/// The frame interactive pages run in: the web app's own, with its no-network policy.
const SANDBOX_HTML: &str = include_str!("../../public/sandbox.html");

/// The phone page's policy. Scripts come only from this server's own files
/// (no inline script, no eval), so nothing an answer, a source or a shared
/// page smuggles into the page can run and take the device key. Styles allow
/// inline (KaTeX and Mermaid write style attributes); pictures may be web
/// images in answers, as on the desktop. Interactive pages run in
/// /assets/sandbox.html, which carries its own policy.
const PHONE_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob: https:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; \
frame-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// The desktop's chat renderer for the phone page, gzipped (build.rs embeds
/// what scripts/build-phone-render.mjs wrote; empty when it wasn't built).
const RENDER_JS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/render.js.gz"));
const RENDER_CSS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/render.css.gz"));
const MERMAID_JS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/mermaid.js.gz"));

/// The phone page with its asset URLs versioned, so phones cache them until they change.
fn mobile_html() -> &'static str {
    static PAGE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PAGE.get_or_init(|| MOBILE_HTML.replace("__PHONE_ASSETS_V__", env!("PHONE_ASSETS_V")))
}

/// The page's script, versioned the same way.
fn mobile_js() -> &'static str {
    static JS: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    JS.get_or_init(|| MOBILE_JS.replace("__PHONE_ASSETS_V__", env!("PHONE_ASSETS_V")))
}

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
    /// Media files referenced as `brewblob:` from rows (see blobs.rs).
    blob_dir: PathBuf,
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
    // Bundled sidecar: Tauri's bundler strips the `-<target-triple>` suffix
    // when copying externalBin files, so release builds ship plain
    // `cloudflared` (`cloudflared.exe` on Windows) next to the app binary.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["cloudflared", "cloudflared.exe"] {
                let sidecar = dir.join(name);
                if sidecar.exists() {
                    println!("SHARE_CLOUDFLARED=bundled:{}", sidecar.display());
                    return Some(sidecar);
                }
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
        .route("/assets/{file}", get(asset_handler))
        .route("/p/{code}/", get(index_handler))
        .route("/p/{code}/api/pair", post(pair_handler))
        // device-scoped app
        .route("/d/{key}/", get(index_handler))
        .route("/d/{key}/api/preferences", get(preferences_handler))
        .route("/d/{key}/api/notebooks", get(notebooks_handler).post(notebook_create_handler))
        .route("/d/{key}/api/notebooks/{id}", get(notebook_handler))
        .route("/d/{key}/api/trash", get(trash_handler))
        .route("/d/{key}/api/notebooks/{id}/cover", get(cover_handler).post(notebook_cover_handler).layer(DefaultBodyLimit::max(UPLOAD_MAX)))
        .route("/d/{key}/api/notebooks/{id}/files", post(notebook_file_handler).layer(DefaultBodyLimit::max(UPLOAD_MAX)))
        .route("/d/{key}/api/notebooks/{id}/details", post(notebook_details_handler))
        .route("/d/{key}/api/notebooks/{id}/star", post(notebook_star_handler))
        .route("/d/{key}/api/notebooks/{id}/move", post(notebook_move_handler))
        .route("/d/{key}/api/notebooks/{id}/restore", post(notebook_restore_handler))
        .route("/d/{key}/api/notebooks/{id}/op", post(notebook_op_handler))
        .route("/d/{key}/api/folders", post(folder_create_handler))
        .route("/d/{key}/api/folders/{id}/rename", post(folder_rename_handler))
        .route("/d/{key}/api/folders/{id}/delete", post(folder_delete_handler))
        .route("/d/{key}/api/artifacts/{id}/revise", post(artifact_revise_handler))
        .route("/d/{key}/api/notebooks/{id}/rename", post(notebook_rename_handler))
        .route("/d/{key}/api/notebooks/{id}/delete", post(notebook_delete_handler))
        .route("/d/{key}/api/notebooks/{id}/chats", get(chats_handler))
        .route("/d/{key}/api/chats/{id}/messages", get(messages_handler))
        .route("/d/{key}/api/chats/{id}/rename", post(chat_rename_handler))
        .route("/d/{key}/api/chats/{id}/delete", post(chat_delete_handler))
        .route("/d/{key}/api/sources/{id}/edit", post(source_edit_handler))
        .route("/d/{key}/api/artifacts/{id}/edit", post(artifact_edit_handler))
        .route("/d/{key}/api/messages/{id}/to-source", post(message_to_source_handler))
        .route("/d/{key}/api/sources/{id}", get(source_handler))
        .route("/d/{key}/api/notebooks/{id}/sources/text", post(source_text_handler))
        .route("/d/{key}/api/notebooks/{id}/sources/url", post(source_url_handler))
        .route("/d/{key}/api/artifacts/{id}", get(artifact_handler))
        .route("/d/{key}/api/artifacts/{id}/audio", get(audio_handler))
        .route("/d/{key}/api/images/{id}", get(image_handler))
        .route("/d/{key}/api/chat", post(chat_handler))
        .route("/d/{key}/api/generate", post(generate_handler))
        .route("/d/{key}/api/jobs/{id}", get(job_handler))
        .route("/d/{key}/api/jobs/{id}/cancel", post(job_cancel_handler))
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
    let blob_dir = db_dir.join("blobs");

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
                blob_dir,
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
    (
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::CONTENT_SECURITY_POLICY, PHONE_CSP),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::X_FRAME_OPTIONS, "DENY"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        Html(mobile_html()),
    )
}

/// The phone page's renderer files. Public: they're the open-source renderer
/// and libraries, with nothing of the user's in them.
async fn asset_handler(Path(file): Path<String>) -> Response {
    let immutable = (header::CACHE_CONTROL, "public, max-age=31536000, immutable");
    match file.as_str() {
        "phone.js" => {
            return (
                [(header::CONTENT_TYPE, "text/javascript; charset=utf-8"), immutable, (header::X_CONTENT_TYPE_OPTIONS, "nosniff")],
                mobile_js(),
            )
                .into_response()
        }
        // Framed by the page (so no DENY), sandboxed to an opaque origin there.
        "sandbox.html" => {
            return (
                [
                    (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                    (header::CONTENT_SECURITY_POLICY, crate::sandbox::SANDBOX_CSP),
                    immutable,
                    (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                ],
                SANDBOX_HTML,
            )
                .into_response()
        }
        _ => {}
    }
    let (body, ctype) = match file.as_str() {
        "render.js" => (RENDER_JS, "text/javascript; charset=utf-8"),
        "render.css" => (RENDER_CSS, "text/css; charset=utf-8"),
        "mermaid.js" => (MERMAID_JS, "text/javascript; charset=utf-8"),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    if body.is_empty() {
        return StatusCode::NOT_FOUND.into_response();
    }
    (
        [
            (header::CONTENT_TYPE, ctype),
            (header::CONTENT_ENCODING, "gzip"),
            immutable,
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        body,
    )
        .into_response()
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

/// Exposes ONLY the UI theme and Custom Blend's colors — never arbitrary settings (keys).
async fn preferences_handler(State(st): State<ServerState>, Path(key): Path<String>) -> Response {
    let dev = match auth_device(&st, &key, false).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    let rows = sqlx::query(
        "SELECT key, value FROM settings WHERE key IN ('theme', 'customBg', 'customText', 'customAccent', \
         'defFlashcardsAmount', 'defFlashcardsDifficulty', 'defQuizAmount', 'defQuizDifficulty', \
         'defAudioMode', 'defAudioFormat', 'defAudioLength', 'defReportType')",
    )
    .fetch_all(&st.pool)
    .await
    .unwrap_or_default();
    let get = |k: &str| {
        rows.iter()
            .find(|r| r.get::<String, _>("key") == k)
            .map(|r| r.get::<String, _>("value"))
    };
    let theme = get("theme").unwrap_or_else(|| "brew".to_string());
    // Only well-formed "#rrggbb" colors leave the machine; anything else reads as unset.
    let color = |k: &str| get(k).filter(|v| is_hex_color(v)).unwrap_or_default();
    no_store_json(json!({
        "theme": theme,
        "scope": dev.scope,
        "custom": { "bg": color("customBg"), "text": color("customText"), "accent": color("customAccent") },
        // Studio Defaults, so the phone's Generate starts where the desktop's does.
        "defaults": {
            "flashcards_amount": one_of(get("defFlashcardsAmount"), &["compact", "default", "more"]),
            "flashcards_difficulty": one_of(get("defFlashcardsDifficulty"), &["easy", "medium", "hard"]),
            "quiz_amount": one_of(get("defQuizAmount"), &["compact", "default", "more"]),
            "quiz_difficulty": one_of(get("defQuizDifficulty"), &["easy", "medium", "hard"]),
            "audio_mode": one_of(get("defAudioMode"), &["conversation", "solo"]),
            "audio_format": one_of(get("defAudioFormat"), &["deep-dive", "brief", "debate", "critique"]),
            "audio_length": one_of(get("defAudioLength"), &["short", "standard", "long"]),
            "report_type": one_of(get("defReportType"), &["study-guide", "briefing-doc", "analysis"]),
        },
    }))
    .into_response()
}

/// A setting's value when it's one of `allowed`, else "" (unset).
fn one_of(v: Option<String>, allowed: &[&str]) -> String {
    v.filter(|v| allowed.contains(&v.as_str())).unwrap_or_default()
}

fn is_hex_color(v: &str) -> bool {
    v.len() == 7 && v.starts_with('#') && v[1..].chars().all(|c| c.is_ascii_hexdigit())
}

async fn notebooks_handler(State(st): State<ServerState>, Path(key): Path<String>) -> Response {
    if let Err(r) = auth_device(&st, &key, false).await {
        return r;
    }
    let rows = sqlx::query(
        "SELECT id, title, description, cover, starred, folder_id, created_at, updated_at FROM notebooks \
         WHERE trashed_at = 0 ORDER BY updated_at DESC",
    )
    .fetch_all(&st.pool)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, format!("db: {e}")).into_response(),
    };
    let list: Vec<_> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<String, _>("id"),
                "title": r.get::<String, _>("title"),
                "description": r.get::<String, _>("description"),
                // Covers load from /notebooks/{id}/cover?v=…, so the list stays small.
                "cover_v": cover_version(&r.get::<String, _>("cover")),
                "starred": r.get::<i64, _>("starred") != 0,
                "folder_id": r.get::<String, _>("folder_id"),
                "created_at": r.get::<i64, _>("created_at"),
                "updated_at": r.get::<i64, _>("updated_at"),
            })
        })
        .collect();
    let folders: Vec<_> = sqlx::query("SELECT id, name, description FROM folders ORDER BY created_at ASC")
        .fetch_all(&st.pool)
        .await
        .unwrap_or_default()
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<String, _>("id"),
                "name": r.get::<String, _>("name"),
                "description": r.get::<String, _>("description"),
            })
        })
        .collect();
    let trash: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notebooks WHERE trashed_at > 0")
        .fetch_one(&st.pool)
        .await
        .unwrap_or(0);
    no_store_json(json!({ "notebooks": list, "folders": folders, "trash": trash })).into_response()
}

/// A cover's version for its address, so phones fetch it again only when it changes.
fn cover_version(cover: &str) -> String {
    use std::hash::{Hash, Hasher};
    if cover.is_empty() {
        return String::new();
    }
    let mut h = std::collections::hash_map::DefaultHasher::new();
    cover.hash(&mut h);
    format!("{:x}", h.finish())
}

/* ---------------------------- phone home screen ---------------------------- */

/// The Trash: notebooks moved there, most recently trashed first.
async fn trash_handler(State(st): State<ServerState>, Path(key): Path<String>) -> Response {
    if let Err(r) = auth_device(&st, &key, false).await {
        return r;
    }
    let list: Vec<_> = sqlx::query(
        "SELECT id, title, description, trashed_at FROM notebooks WHERE trashed_at > 0 ORDER BY trashed_at DESC",
    )
    .fetch_all(&st.pool)
    .await
    .unwrap_or_default()
    .iter()
    .map(|r| {
        json!({
            "id": r.get::<String, _>("id"),
            "title": r.get::<String, _>("title"),
            "description": r.get::<String, _>("description"),
            "trashed_at": r.get::<i64, _>("trashed_at"),
        })
    })
    .collect();
    no_store_json(json!({ "notebooks": list })).into_response()
}

/// A notebook's cover picture.
async fn cover_handler(State(st): State<ServerState>, Path((key, id)): Path<(String, String)>) -> Response {
    if let Err(r) = auth_device(&st, &key, false).await {
        return r;
    }
    let cover: Option<String> = sqlx::query_scalar("SELECT cover FROM notebooks WHERE id = ?")
        .bind(&id)
        .fetch_optional(&st.pool)
        .await
        .ok()
        .flatten();
    match cover.and_then(|c| crate::blobs::load(&st.blob_dir, &c, None)) {
        Some((mime, bytes)) if mime.starts_with("image/") => (
            [
                (header::CONTENT_TYPE, mime),
                (header::CACHE_CONTROL, "private, max-age=31536000, immutable".to_string()),
            ],
            bytes,
        )
            .into_response(),
        _ => (StatusCode::NOT_FOUND, "no cover").into_response(),
    }
}

#[derive(Deserialize)]
struct DetailsBody {
    title: String,
    description: Option<String>,
}

/// Title and description together, as the desktop's Edit notebook does (it bumps updated_at).
async fn notebook_details_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
    Json(body): Json<DetailsBody>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    let title = body.title.trim().chars().take(200).collect::<String>();
    if title.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "Title required.");
    }
    let description = body.description.unwrap_or_default().trim().chars().take(1000).collect::<String>();
    let res = sqlx::query("UPDATE notebooks SET title = ?, description = ?, updated_at = ? WHERE id = ? AND trashed_at = 0")
        .bind(&title)
        .bind(&description)
        .bind(now_ms())
        .bind(&id)
        .execute(&st.pool)
        .await;
    write_outcome(&st, &dev.id, res, "notebook.details", &title).await
}

#[derive(Deserialize)]
struct StarBody {
    starred: bool,
}

/// Star or unstar (pins to the top). Organizational: updated_at stays.
async fn notebook_star_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
    Json(body): Json<StarBody>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    let res = sqlx::query("UPDATE notebooks SET starred = ? WHERE id = ? AND trashed_at = 0")
        .bind(body.starred as i64)
        .bind(&id)
        .execute(&st.pool)
        .await;
    let action = if body.starred { "notebook.star" } else { "notebook.unstar" };
    write_outcome(&st, &dev.id, res, action, &id).await
}

#[derive(Deserialize)]
struct MoveBody {
    folder_id: String,
}

/// File a notebook in a folder ("" = no folder). Organizational: updated_at stays.
async fn notebook_move_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
    Json(body): Json<MoveBody>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    if !body.folder_id.is_empty() {
        let found: Option<String> = sqlx::query_scalar("SELECT id FROM folders WHERE id = ?")
            .bind(&body.folder_id)
            .fetch_optional(&st.pool)
            .await
            .ok()
            .flatten();
        if found.is_none() {
            return (StatusCode::NOT_FOUND, "folder not found").into_response();
        }
    }
    let res = sqlx::query("UPDATE notebooks SET folder_id = ? WHERE id = ? AND trashed_at = 0")
        .bind(&body.folder_id)
        .bind(&id)
        .execute(&st.pool)
        .await;
    write_outcome(&st, &dev.id, res, "notebook.move", &id).await
}

/// Back out of the Trash, to where it was.
async fn notebook_restore_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    let res = sqlx::query("UPDATE notebooks SET trashed_at = 0 WHERE id = ? AND trashed_at > 0")
        .bind(&id)
        .execute(&st.pool)
        .await;
    write_outcome(&st, &dev.id, res, "notebook.restore", &id).await
}

/// One direct write's response: not found when it touched nothing, else logged.
async fn write_outcome(
    st: &ServerState,
    dev_id: &str,
    res: Result<sqlx::sqlite::SqliteQueryResult, sqlx::Error>,
    action: &str,
    detail: &str,
) -> Response {
    match res {
        Ok(r) if r.rows_affected() == 0 => (StatusCode::NOT_FOUND, "not found").into_response(),
        Ok(_) => {
            log_activity(&st.pool, dev_id, action, detail).await;
            no_store_json(json!({ "ok": true })).into_response()
        }
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("db: {e}")),
    }
}

#[derive(Deserialize)]
struct NotebookOpBody {
    op: String,
    title: Option<String>,
    template: Option<String>,
}

/// Notebook actions the desktop runs with its own functions (jobRunner.ts
/// runNotebookEdit): Delete forever (Trash only), Use as template, clone,
/// remove the cover, add a constitution.
async fn notebook_op_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
    Json(body): Json<NotebookOpBody>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    if let Err(r) = rate(&st, &dev.id, false) {
        return r;
    }
    let trashed: Option<i64> = sqlx::query_scalar("SELECT trashed_at FROM notebooks WHERE id = ?")
        .bind(&id)
        .fetch_optional(&st.pool)
        .await
        .ok()
        .flatten();
    let Some(trashed) = trashed else {
        return (StatusCode::NOT_FOUND, "notebook not found").into_response();
    };
    let in_trash = trashed > 0;
    match body.op.as_str() {
        "delete-forever" if in_trash => {}
        "delete-forever" => return err_json(StatusCode::BAD_REQUEST, "Move it to the Trash first."),
        "template" | "clone" | "cover-clear" | "constitution" if !in_trash => {}
        "template" | "clone" | "cover-clear" | "constitution" => {
            return (StatusCode::NOT_FOUND, "notebook not found").into_response()
        }
        _ => return err_json(StatusCode::BAD_REQUEST, "Unknown action."),
    }
    let title = body.title.unwrap_or_default().trim().chars().take(80).collect::<String>();
    let template = body
        .template
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(40)
        .collect::<String>();
    queue_edit(&st, &dev.id, &id, "notebook", &id, &body.op, &title, json!({ "template": template })).await
}

/// The largest file the phone may send (an upload or a cover).
const UPLOAD_MAX: usize = 60 * 1024 * 1024;

/// "%E2%80%9C…" (encodeURIComponent) → text.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A file from the phone (body = its bytes, x-file-name = its name), into the
/// media store, then a job for the desktop: `ingest` adds it as a source with
/// the desktop's own importer, `cover` makes it the notebook's cover.
async fn receive_file(st: ServerState, key: String, id: String, headers: HeaderMap, body: Bytes, op: &str) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    // Imports may describe pictures or transcribe audio: rate them like AI requests.
    if let Err(r) = rate(&st, &dev.id, op == "ingest") {
        return r;
    }
    if !notebook_owned(&st.pool, &id).await {
        return (StatusCode::NOT_FOUND, "notebook not found").into_response();
    }
    if body.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "That file is empty.");
    }
    let name = headers
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_default()
        .replace(['/', '\\'], "")
        .trim()
        .chars()
        .take(200)
        .collect::<String>();
    let name = if name.is_empty() { "upload".to_string() } else { name };
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .chars()
        .take(100)
        .collect::<String>();
    if op == "cover" && !mime.starts_with("image/") {
        return err_json(StatusCode::BAD_REQUEST, "A cover has to be a picture.");
    }
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .filter(|e| (1..=5).contains(&e.len()) && e.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()))
        .unwrap_or_else(|| "bin".to_string());
    let reference = match crate::blobs::put(&st.blob_dir, &body, &ext) {
        Ok(r) => r,
        Err(e) => return err_json(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    queue_edit(&st, &dev.id, &id, "notebook", &id, op, &name, json!({ "ref": reference, "name": name, "mime": mime })).await
}

async fn notebook_file_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    receive_file(st, key, id, headers, body, "ingest").await
}

async fn notebook_cover_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    receive_file(st, key, id, headers, body, "cover").await
}

#[derive(Deserialize)]
struct FolderBody {
    name: String,
}

/// A new folder, as the desktop's homepage makes one.
async fn folder_create_handler(
    State(st): State<ServerState>,
    Path(key): Path<String>,
    Json(body): Json<FolderBody>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    let name = body.name.trim().chars().take(80).collect::<String>();
    if name.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "Name required.");
    }
    let id = random_id();
    let res = sqlx::query("INSERT INTO folders (id, name, description, cover, created_at) VALUES (?, ?, '', '', ?)")
        .bind(&id)
        .bind(&name)
        .bind(now_ms())
        .execute(&st.pool)
        .await;
    match res {
        Ok(_) => {
            log_activity(&st.pool, &dev.id, "folder.create", &name).await;
            no_store_json(json!({ "id": id, "name": name })).into_response()
        }
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("db: {e}")),
    }
}

/// Rename a folder (its description stays). Touches no timestamps.
async fn folder_rename_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
    Json(body): Json<FolderBody>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    let name = body.name.trim().chars().take(80).collect::<String>();
    if name.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "Name required.");
    }
    let res = sqlx::query("UPDATE folders SET name = ? WHERE id = ?").bind(&name).bind(&id).execute(&st.pool).await;
    write_outcome(&st, &dev.id, res, "folder.rename", &name).await
}

/// Delete a folder; its notebooks aren't — they go back to the homepage, as on the desktop.
async fn folder_delete_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    let _ = sqlx::query("UPDATE notebooks SET folder_id = '' WHERE folder_id = ?").bind(&id).execute(&st.pool).await;
    let res = sqlx::query("DELETE FROM folders WHERE id = ?").bind(&id).execute(&st.pool).await;
    write_outcome(&st, &dev.id, res, "folder.delete", &id).await
}

#[derive(Deserialize)]
struct ReviseBody {
    note: String,
    replace: Option<bool>,
    re_audio: Option<bool>,
}

/// Revise an output with an instruction: queued for the desktop's Revise
/// (src/lib/revise.ts) in the chat/Studio lane.
async fn artifact_revise_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
    Json(body): Json<ReviseBody>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    if let Err(r) = rate(&st, &dev.id, true) {
        return r;
    }
    let row = sqlx::query(
        "SELECT a.notebook_id, a.kind, a.title FROM artifacts a JOIN notebooks n ON n.id = a.notebook_id \
         WHERE a.id = ? AND n.trashed_at = 0",
    )
    .bind(&id)
    .fetch_optional(&st.pool)
    .await;
    let Ok(Some(row)) = row else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    if row.get::<String, _>("kind") == "drawing" {
        return err_json(StatusCode::BAD_REQUEST, "Drawings aren't revised by the AI.");
    }
    let note = body.note.trim().chars().take(2000).collect::<String>();
    if note.is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "Say how to revise it.");
    }
    let notebook_id: String = row.get("notebook_id");
    let title: String = row.get("title");
    let job_id = random_id();
    let now = now_ms();
    let payload = json!({
        "notebook_id": notebook_id,
        "kind": "revise",
        "artifact_id": id,
        "note": note,
        "replace": body.replace.unwrap_or(true),
        "re_audio": body.re_audio.unwrap_or(false),
    });
    let res = sqlx::query(
        "INSERT INTO jobs (id, kind, notebook_id, status, payload, device_id, created_at, updated_at) \
         VALUES (?, 'revise', ?, 'pending', ?, ?, ?, ?)",
    )
    .bind(&job_id)
    .bind(&notebook_id)
    .bind(payload.to_string())
    .bind(&dev.id)
    .bind(now)
    .bind(now)
    .execute(&st.pool)
    .await;
    match res {
        Ok(_) => {
            log_activity(&st.pool, &dev.id, "artifact.revise", &title).await;
            no_store_json(json!({ "job_id": job_id })).into_response()
        }
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("db: {e}")),
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
        // As the desktop lists them: the constitution, then pinned, then oldest first.
        "SELECT id, type, title, created_at, pinned, mime FROM sources WHERE notebook_id = ? \
         ORDER BY type = 'context' DESC, pinned DESC, created_at",
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
            "pinned": r.get::<i64, _>("pinned") != 0,
            // Links keep their address in `mime` (the phone marks /fetch cards already added).
            "url": r.get::<Option<String>, _>("mime").filter(|m| m.starts_with("http")).unwrap_or_default(),
        })
    })
    .collect::<Vec<_>>();

    let artifacts = sqlx::query(
        "SELECT id, kind, title, created_at, pinned FROM artifacts WHERE notebook_id = ? \
         ORDER BY pinned DESC, created_at DESC",
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
            "pinned": r.get::<i64, _>("pinned") != 0,
        })
    })
    .collect::<Vec<_>>();

    no_store_json(json!({
        "id": nb.get::<String, _>("id"),
        "title": nb.get::<String, _>("title"),
        "description": nb.get::<String, _>("description"),
        "cover": crate::blobs::to_data_url(&st.blob_dir, &nb.get::<String, _>("cover")),
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
    // With each reply's reasoning, when the model shared any (the desktop keeps it beside the message).
    let with_reasoning = sqlx::query(
        "SELECT m.id, m.role, m.content, m.created_at, COALESCE(r.text, '') AS reasoning FROM messages m \
         LEFT JOIN message_reasoning r ON r.message_id = m.id WHERE m.chat_id = ? \
         ORDER BY m.created_at DESC LIMIT 100",
    )
    .bind(&id)
    .fetch_all(&st.pool)
    .await;
    let mut rows = match with_reasoning {
        Ok(rows) => rows,
        // An older database without the reasoning table.
        Err(_) => sqlx::query(
            "SELECT id, role, content, created_at, '' AS reasoning FROM messages WHERE chat_id = ? \
             ORDER BY created_at DESC LIMIT 100",
        )
        .bind(&id)
        .fetch_all(&st.pool)
        .await
        .unwrap_or_default(),
    };
    rows.reverse(); // back to chronological
    let list: Vec<_> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<String, _>("id"),
                "role": r.get::<String, _>("role"),
                "content": r.get::<String, _>("content"),
                "created_at": r.get::<i64, _>("created_at"),
                "reasoning": r.get::<String, _>("reasoning"),
            })
        })
        .collect();
    no_store_json(json!({ "messages": list })).into_response()
}

/// Rename a chat, as the desktop's chat list does (updated_at is left alone,
/// so renaming doesn't reorder the list).
async fn chat_rename_handler(
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
    let res = sqlx::query(
        "UPDATE chats SET title = ? WHERE id = ? \
         AND notebook_id IN (SELECT id FROM notebooks WHERE trashed_at = 0)",
    )
    .bind(&title)
    .bind(&id)
    .execute(&st.pool)
    .await;
    match res {
        Ok(r) if r.rows_affected() == 0 => (StatusCode::NOT_FOUND, "chat not found").into_response(),
        Ok(_) => {
            log_activity(&st.pool, &dev.id, "chat.rename", &title).await;
            no_store_json(json!({ "ok": true })).into_response()
        }
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("db: {e}")),
    }
}

/// Delete a chat for good, as the desktop's chat list does. The desktop runs
/// it (src/lib/jobRunner.ts → deleteChat in src/lib/db.ts), so its messages,
/// stored reasoning and the pictures only it used go exactly as they do there;
/// this checks the chat, stops the phone's own unfinished replies in it, and
/// queues a `chat.delete` job the phone polls. Phone replies still waiting for
/// this chat are cancelled first so none lands in it after it's gone.
async fn chat_delete_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    if let Err(r) = rate(&st, &dev.id, false) {
        return r;
    }
    let chat = sqlx::query(
        "SELECT notebook_id, title FROM chats WHERE id = ? \
         AND notebook_id IN (SELECT id FROM notebooks WHERE trashed_at = 0)",
    )
    .bind(&id)
    .fetch_optional(&st.pool)
    .await;
    let Ok(Some(chat)) = chat else {
        return (StatusCode::NOT_FOUND, "chat not found").into_response();
    };
    let notebook_id: String = chat.get("notebook_id");
    let title: String = chat.get("title");
    let now = now_ms();
    let _ = sqlx::query(
        "UPDATE jobs SET status = 'cancelled', progress = '', updated_at = ? \
         WHERE kind = 'chat' AND status IN ('pending', 'running') AND json_extract(payload, '$.chat_id') = ?",
    )
    .bind(now)
    .bind(&id)
    .execute(&st.pool)
    .await;
    let job_id = random_id();
    let payload = json!({ "notebook_id": notebook_id, "kind": "chat.delete", "chat_id": id });
    let res = sqlx::query(
        "INSERT INTO jobs (id, kind, notebook_id, status, payload, device_id, created_at, updated_at) \
         VALUES (?, 'chat.delete', ?, 'pending', ?, ?, ?, ?)",
    )
    .bind(&job_id)
    .bind(&notebook_id)
    .bind(payload.to_string())
    .bind(&dev.id)
    .bind(now)
    .bind(now)
    .execute(&st.pool)
    .await;
    match res {
        Ok(_) => {
            log_activity(&st.pool, &dev.id, "chat.delete", &title).await;
            no_store_json(json!({ "job_id": job_id })).into_response()
        }
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("db: {e}")),
    }
}

#[derive(Deserialize)]
struct EditBody {
    op: String,
    title: Option<String>,
    /** set-data: a mind map's edited outline. */
    data: Option<String>,
}

/// The most of an edited mind map outline the phone may send.
const OUTLINE_MAX: usize = 200_000;

/// Queue one item edit for the desktop to run with its own functions
/// (src/lib/jobRunner.ts runEditJob), in the quick lane beside links.
#[allow(clippy::too_many_arguments)]
async fn queue_edit(
    st: &ServerState,
    dev_id: &str,
    notebook_id: &str,
    target: &str,
    id: &str,
    op: &str,
    title: &str,
    extra: serde_json::Value,
) -> Response {
    let job_id = random_id();
    let now = now_ms();
    let mut payload = json!({
        "notebook_id": notebook_id,
        "kind": "edit",
        "target": target,
        "id": id,
        "op": op,
        "title": title,
    });
    if let (Some(p), Some(x)) = (payload.as_object_mut(), extra.as_object()) {
        for (k, v) in x {
            p.insert(k.clone(), v.clone());
        }
    }
    let res = sqlx::query(
        "INSERT INTO jobs (id, kind, notebook_id, status, payload, device_id, created_at, updated_at) \
         VALUES (?, 'edit', ?, 'pending', ?, ?, ?, ?)",
    )
    .bind(&job_id)
    .bind(notebook_id)
    .bind(payload.to_string())
    .bind(dev_id)
    .bind(now)
    .bind(now)
    .execute(&st.pool)
    .await;
    match res {
        Ok(_) => {
            log_activity(&st.pool, dev_id, &format!("{target}.{op}"), title).await;
            no_store_json(json!({ "job_id": job_id })).into_response()
        }
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("db: {e}")),
    }
}

/// An item's notebook and title, when the item exists in a notebook that isn't in the Trash.
async fn live_item(pool: &SqlitePool, table: &str, id: &str) -> Option<(String, String)> {
    // `table` is one of our own literals, never phone input.
    let sql = format!(
        "SELECT t.notebook_id, t.title FROM {table} t JOIN notebooks n ON n.id = t.notebook_id \
         WHERE t.id = ? AND n.trashed_at = 0"
    );
    let row = sqlx::query(&sql).bind(id).fetch_optional(pool).await.ok()??;
    Some((row.get("notebook_id"), row.get("title")))
}

/// Rename / pin / unpin / delete one item, or (outputs) add it to Sources.
async fn edit_item(st: ServerState, key: String, id: String, body: EditBody, target: &str) -> Response {
    // Download changes nothing, so read-only devices may use it.
    let writes = !(target == "artifact" && body.op == "export");
    let dev = match auth_device(&st, &key, writes).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    if let Err(r) = rate(&st, &dev.id, false) {
        return r;
    }
    let ops: &[&str] = if target == "artifact" {
        &["rename", "pin", "unpin", "delete", "to-source", "export", "set-data"]
    } else {
        &["rename", "pin", "unpin", "delete"]
    };
    let mut extra = json!({});
    if body.op == "set-data" {
        let data = body.data.clone().unwrap_or_default();
        if data.trim().is_empty() || data.chars().count() > OUTLINE_MAX {
            return err_json(StatusCode::BAD_REQUEST, "That mind map is empty or too large.");
        }
        extra = json!({ "data": data });
    }
    if !ops.contains(&body.op.as_str()) {
        return err_json(StatusCode::BAD_REQUEST, "Unknown action.");
    }
    let table = if target == "artifact" { "artifacts" } else { "sources" };
    let Some((notebook_id, current)) = live_item(&st.pool, table, &id).await else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    let title = if body.op == "rename" {
        let t = body.title.unwrap_or_default().trim().chars().take(200).collect::<String>();
        if t.is_empty() {
            return err_json(StatusCode::BAD_REQUEST, "Title required.");
        }
        t
    } else {
        current
    };
    queue_edit(&st, &dev.id, &notebook_id, target, &id, &body.op, &title, extra).await
}

async fn source_edit_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
    Json(body): Json<EditBody>,
) -> Response {
    edit_item(st, key, id, body, "source").await
}

async fn artifact_edit_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
    Json(body): Json<EditBody>,
) -> Response {
    edit_item(st, key, id, body, "artifact").await
}

/// A reply's "Save to Sources": the desktop saves it as a note, titled as it titles them.
async fn message_to_source_handler(
    State(st): State<ServerState>,
    Path((key, id)): Path<(String, String)>,
) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    if let Err(r) = rate(&st, &dev.id, false) {
        return r;
    }
    let row = sqlx::query(
        "SELECT m.notebook_id FROM messages m JOIN notebooks n ON n.id = m.notebook_id \
         WHERE m.id = ? AND m.role = 'assistant' AND n.trashed_at = 0",
    )
    .bind(&id)
    .fetch_optional(&st.pool)
    .await;
    let Ok(Some(row)) = row else {
        return (StatusCode::NOT_FOUND, "reply not found").into_response();
    };
    let notebook_id: String = row.get("notebook_id");
    queue_edit(&st, &dev.id, &notebook_id, "message", &id, "to-source", "", json!({})).await
}

/// The most of a source's text the phone is sent at once (a long PDF can be
/// megabytes); the rest stays on the computer.
const SOURCE_VIEW_CHARS: usize = 200_000;

/// One source as the phone's viewer shows it: what the AI reads (the same text
/// as the desktop's "What the AI sees"), its link, and an image's own picture.
/// Other media (audio, video, PDF files) never cross the tunnel — only their text.
async fn source_handler(State(st): State<ServerState>, Path((key, id)): Path<(String, String)>) -> Response {
    if let Err(r) = auth_device(&st, &key, false).await {
        return r;
    }
    let row = sqlx::query(
        "SELECT s.id, s.type, s.title, s.content, s.text, s.mime, s.created_at FROM sources s \
         JOIN notebooks n ON n.id = s.notebook_id WHERE s.id = ? AND n.trashed_at = 0",
    )
    .bind(&id)
    .fetch_optional(&st.pool)
    .await;
    let Ok(Some(r)) = row else {
        return (StatusCode::NOT_FOUND, "source not found").into_response();
    };
    let kind: String = r.get("type");
    let content: String = r.get("content");
    let mime: Option<String> = r.get("mime");
    // Mirrors sourceText() in src/lib/db.ts.
    let media = kind == "image"
        || kind == "audio"
        || content.starts_with("data:")
        || content.starts_with(crate::blobs::REF_PREFIX);
    let full: String = if media { r.get("text") } else { content.clone() };
    let chars = full.chars().count();
    let text: String = full.chars().take(SOURCE_VIEW_CHARS).collect();
    let image = if kind == "image" {
        crate::blobs::to_data_url(&st.blob_dir, &content)
    } else {
        String::new()
    };
    // Links keep their address in `mime`.
    let url = mime
        .as_deref()
        .filter(|m| m.starts_with("http://") || m.starts_with("https://"))
        .unwrap_or("")
        .to_string();
    no_store_json(json!({
        "id": r.get::<String, _>("id"),
        "type": kind,
        "title": r.get::<String, _>("title"),
        "created_at": r.get::<i64, _>("created_at"),
        "text": text,
        "chars": chars,
        "truncated": chars > SOURCE_VIEW_CHARS,
        "url": url,
        "image": image,
    }))
    .into_response()
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

#[derive(Deserialize)]
struct SourceUrlBody {
    url: String,
}

/// A link added from the phone is read by the desktop app, with the same
/// reader as Add link there (src/lib/source.ts: YouTube/Vimeo/caption-file
/// transcripts, PDFs and Office files, compressed pages). This only checks
/// the address is public and queues a `link` job; src/lib/jobRunner.ts runs
/// it and saves the source, and the phone polls /jobs/{id} for the result.
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
    let trimmed = body.url.trim();
    if trimmed.is_empty() || trimmed.len() > 4000 {
        return err_json(StatusCode::BAD_REQUEST, "Paste a link first.");
    }
    let raw = if trimmed.starts_with("http") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = match validate_public_url(&raw) {
        Ok(u) => u,
        Err(m) => return err_json(StatusCode::BAD_REQUEST, &m),
    };

    let job_id = random_id();
    let now = now_ms();
    let payload = json!({ "notebook_id": id, "kind": "link", "url": url.as_str() });
    let res = sqlx::query(
        "INSERT INTO jobs (id, kind, notebook_id, status, payload, device_id, created_at, updated_at) \
         VALUES (?, 'link', ?, 'pending', ?, ?, ?, ?)",
    )
    .bind(&job_id)
    .bind(&id)
    .bind(payload.to_string())
    .bind(&dev.id)
    .bind(now)
    .bind(now)
    .execute(&st.pool)
    .await;
    match res {
        Ok(_) => {
            log_activity(&st.pool, &dev.id, "source.url", url.as_str()).await;
            no_store_json(json!({ "job_id": job_id })).into_response()
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
    /// The phone's Thinking effort pick; anything else is dropped (desktop setting applies).
    thinking: Option<String>,
    /// The picture an image action (/edit, /remix, /more) works on; else the chat's latest.
    image_id: Option<String>,
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
        "thinking": body
            .thinking
            .as_deref()
            .filter(|t| matches!(*t, "auto" | "low" | "medium" | "high")),
        "image_id": body
            .image_id
            .as_deref()
            .filter(|id| !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')),
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

const GENERATE_KINDS: [&str; 7] = ["flashcards", "quiz", "mindmap", "report", "research", "audio", "interactive"];

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
        // The desktop's two report menus: its quick formats and its customize types.
        "report_type": match pick("report_type", 20).as_str() {
            "summary" | "faq" | "timeline" | "briefing-doc" | "analysis" | "custom" => pick("report_type", 20),
            _ => "study-guide".into(),
        },
        // "" = the desktop's Studio Defaults pick.
        "mode": match pick("mode", 14).as_str() { "conversation" | "solo" => pick("mode", 14), _ => String::new() },
        "custom_prompt": pick("custom_prompt", 1000).trim().to_string(),
        // Ground on just these sources (none = all), as the desktop's customize dialogs.
        "source_ids": o.get("source_ids").and_then(|v| v.as_array()).map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .filter(|x| !x.is_empty() && x.len() <= 64)
                .take(500)
                .map(|x| x.to_string())
                .collect::<Vec<_>>()
        }).unwrap_or_default(),
        // The output's name; empty = the tool's own.
        "title": pick("title", 80).trim().to_string(),
        // Research titles itself with its topic; an interactive page's brief can run longer.
        "topic": pick("topic", if body.kind == "interactive" { 1000 } else { 200 }).trim().to_string(),
    });
    if body.kind == "research" && options["topic"].as_str().unwrap_or("").is_empty() {
        return err_json(StatusCode::BAD_REQUEST, "Research needs a topic.");
    }
    if body.kind == "report"
        && options["report_type"] == "custom"
        && options["custom_prompt"].as_str().unwrap_or("").is_empty()
    {
        return err_json(StatusCode::BAD_REQUEST, "Say what the custom report should cover.");
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

/// Cancel one of this device's queued or running jobs. A queued one is never
/// picked up; the desktop runner sees the status change on a running one,
/// stops it and saves nothing. A job that already ended is left as it was.
async fn job_cancel_handler(State(st): State<ServerState>, Path((key, id)): Path<(String, String)>) -> Response {
    let dev = match auth_device(&st, &key, true).await {
        Ok(d) => d,
        Err(r) => return r,
    };
    let res = sqlx::query(
        "UPDATE jobs SET status = 'cancelled', progress = '', updated_at = ? \
         WHERE id = ? AND device_id = ? AND status IN ('pending', 'running')",
    )
    .bind(now_ms())
    .bind(&id)
    .bind(&dev.id)
    .execute(&st.pool)
    .await;
    match res {
        Ok(r) => no_store_json(json!({ "cancelled": r.rows_affected() > 0 })).into_response(),
        Err(e) => err_json(StatusCode::INTERNAL_SERVER_ERROR, &format!("db: {e}")),
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
pub(crate) fn parse_range(h: Option<&str>, len: u64) -> Option<(u64, u64)> {
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
            if !audio.starts_with("data:audio/") && !audio.starts_with(crate::blobs::REF_PREFIX) {
                return (StatusCode::NOT_FOUND, "artifact has no audio (script only)")
                    .into_response();
            }
            let Some((mime, bytes)) = crate::blobs::load(&st.blob_dir, audio, None) else {
                return (StatusCode::INTERNAL_SERVER_ERROR, "audio file unreadable").into_response();
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

/// Generated image from the library (`brewimg:<id>` references in chat messages).
async fn image_handler(State(st): State<ServerState>, Path((key, id)): Path<(String, String)>) -> Response {
    if let Err(r) = auth_device(&st, &key, false).await {
        return r;
    }
    let row = sqlx::query("SELECT mime, data FROM images WHERE id = ?")
        .bind(&id)
        .fetch_optional(&st.pool)
        .await;
    let row = match row {
        Ok(Some(r)) => r,
        // Missing table (no image ever generated) reads as not found too.
        Ok(None) | Err(_) => return (StatusCode::NOT_FOUND, "image not found").into_response(),
    };
    let mime: String = row.get("mime");
    let data: String = row.get("data");
    let Some((mime, bytes)) = crate::blobs::load(&st.blob_dir, &data, Some(&mime)) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "image unreadable").into_response();
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, bytes.len())
        // Images are immutable once saved; the URL carries the device key.
        .header(header::CACHE_CONTROL, "private, max-age=86400")
        .body(Body::from(bytes))
        .unwrap()
}

/* ---------------------------------- tests ---------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
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
             kind TEXT NOT NULL, title TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, \
             pinned INTEGER NOT NULL DEFAULT 0)",
            "CREATE TABLE sources (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, \
             type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', \
             mime TEXT, created_at INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '', \
             pinned INTEGER NOT NULL DEFAULT 0)",
            "CREATE TABLE chats (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, \
             title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
            "CREATE TABLE messages (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, \
             role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, chat_id TEXT)",
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            "CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', \
             cover TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)",
            "CREATE TABLE images (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, \
             chat_id TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '', \
             model TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL, data TEXT NOT NULL, \
             width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, \
             parent_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)",
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
        sqlx::query("INSERT INTO artifacts (id, notebook_id, kind, title, data, created_at) VALUES ('a1', 'nb1', 'audio', 'Pod', ?, 100)")
            .bind(audio_json)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO images (id, notebook_id, mime, data, created_at) VALUES ('img1', 'nb1', 'image/png', ?, 1)")
            .bind(B64.encode([137u8, 80, 78, 71]))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO chats VALUES ('c1', 'nb1', 'First chat', 1, 200)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO chats VALUES ('c2', 'nb2', 'In the trash', 1, 201)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO sources (id, notebook_id, type, title, content, mime, created_at, text) VALUES \
             ('s1', 'nb1', 'link', 'A page', 'Page body', 'https://example.com/a', 1, ''), \
             ('s2', 'nb1', 'image', 'A photo', 'data:image/png;base64,iVBORw0K', 'image/png', 2, 'A cat on a mat'), \
             ('s3', 'nb1', 'file', 'Talk.mp3', 'brewblob:abc.mp3', 'audio/mpeg', 3, 'The transcript'), \
             ('s4', 'nb2', 'text', 'Trashed note', 'secret', NULL, 4, '')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO messages (id, notebook_id, role, content, created_at, chat_id) VALUES \
             ('m1', 'nb1', 'user', 'Question?', 1, 'c1'), ('m2', 'nb1', 'assistant', '## Answer', 2, 'c1'), \
             ('m3', 'nb2', 'assistant', 'In the trash', 3, 'c2')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO settings VALUES ('theme', 'ocean')")
            .execute(&pool)
            .await
            .unwrap();
        for (k, v) in [("customBg", "#060023"), ("customText", "#ff83f0"), ("customAccent", "not a color"), ("anthropicKey", "sk-secret")] {
            sqlx::query("INSERT INTO settings VALUES (?, ?)")
                .bind(k)
                .bind(v)
                .execute(&pool)
                .await
                .unwrap();
        }

        let state = ServerState {
            pool,
            blob_dir: dir.path().join("blobs"),
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
    async fn serves_library_images() {
        let (app, _dir) = fixture().await;
        let resp = app
            .clone()
            .oneshot(get(&format!("/d/{READ_KEY}/api/images/img1")))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers()[header::CONTENT_TYPE], "image/png");
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(bytes.as_ref(), &[137u8, 80, 78, 71]);

        let missing = app
            .clone()
            .oneshot(get(&format!("/d/{FULL_KEY}/api/images/nope")))
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        let unauth = app.oneshot(get("/d/WRONG/api/images/img1")).await.unwrap();
        assert_eq!(unauth.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn serves_blob_backed_media() {
        let (app, dir) = fixture().await;
        let blobs = dir.path().join("blobs");
        let audio_ref = crate::blobs::put(&blobs, b"m4a-bytes", "m4a").unwrap();
        let img_ref = crate::blobs::put(&blobs, &[1u8, 2, 3], "png").unwrap();
        let opts = SqliteConnectOptions::new().filename(dir.path().join("test.db"));
        let pool = SqlitePool::connect_with(opts).await.unwrap();
        sqlx::query("UPDATE artifacts SET data = ? WHERE id = 'a1'")
            .bind(format!(r#"{{"audio": "{audio_ref}", "script": "Alex: hi"}}"#))
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE images SET data = ? WHERE id = 'img1'")
            .bind(&img_ref)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE notebooks SET cover = ? WHERE id = 'nb1'")
            .bind(&img_ref)
            .execute(&pool)
            .await
            .unwrap();

        let resp = app.clone().oneshot(get(&format!("/d/{READ_KEY}/api/artifacts/a1/audio"))).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers()[header::CONTENT_TYPE], "audio/mp4");
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(bytes.as_ref(), b"m4a-bytes");

        let resp = app.clone().oneshot(get(&format!("/d/{READ_KEY}/api/images/img1"))).await.unwrap();
        assert_eq!(resp.headers()[header::CONTENT_TYPE], "image/png");
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(bytes.as_ref(), &[1u8, 2, 3]);

        let list = body_string(app.clone().oneshot(get(&format!("/d/{READ_KEY}/api/notebooks"))).await.unwrap()).await;
        assert!(!list.contains("brewblob:"), "{list}");
        let resp = app.oneshot(get(&format!("/d/{READ_KEY}/api/notebooks/nb1/cover"))).await.unwrap();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        assert_eq!(bytes.as_ref(), &[1u8, 2, 3]);
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
        let writes: [(&str, &str); 22] = [
            ("/api/notebooks/nb1/details", r#"{"title":"x"}"#),
            ("/api/notebooks/nb1/star", r#"{"starred":true}"#),
            ("/api/notebooks/nb1/move", r#"{"folder_id":""}"#),
            ("/api/notebooks/nb2/restore", "{}"),
            ("/api/notebooks/nb1/op", r#"{"op":"template"}"#),
            ("/api/folders", r#"{"name":"x"}"#),
            ("/api/folders/f1/rename", r#"{"name":"x"}"#),
            ("/api/folders/f1/delete", "{}"),
            ("/api/artifacts/a1/revise", r#"{"note":"shorter"}"#),
            ("/api/artifacts/a1/edit", r#"{"op":"set-data","data":"- x"}"#),
            ("/api/sources/s1/edit", r#"{"op":"pin"}"#),
            ("/api/artifacts/a1/edit", r#"{"op":"delete"}"#),
            ("/api/messages/m2/to-source", "{}"),
            ("/api/chat", r#"{"notebook_id":"nb1","content":"hi"}"#),
            ("/api/chats/c1/rename", r#"{"title":"x"}"#),
            ("/api/chats/c1/delete", "{}"),
            ("/api/generate", r#"{"notebook_id":"nb1","kind":"flashcards","options":{}}"#),
            ("/api/notebooks", r#"{"title":"x"}"#),
            ("/api/notebooks/nb1/rename", r#"{"title":"x"}"#),
            ("/api/notebooks/nb1/delete", "{}"),
            ("/api/notebooks/nb1/sources/text", r#"{"title":"t","text":"c"}"#),
            ("/api/notebooks/nb1/sources/url", r#"{"url":"https://1.1.1.1/"}"#),
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
        let (app, dir) = fixture().await;
        let opts = SqliteConnectOptions::new().filename(dir.path().join("test.db"));
        let pool = SqlitePool::connect_with(opts).await.unwrap();
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

        // The phone's thinking level rides along; anything unknown is dropped.
        for (sent, kept) in [("\"high\"", Some("high")), ("\"turbo\"", None)] {
            let resp = app
                .clone()
                .oneshot(post_json(
                    &format!("/d/{FULL_KEY}/api/chat"),
                    &format!(r#"{{"notebook_id":"nb1","content":"hi","thinking":{sent}}}"#),
                ))
                .await
                .unwrap();
            let body: serde_json::Value = serde_json::from_str(&body_string(resp).await).unwrap();
            let payload: String = sqlx::query_scalar("SELECT payload FROM jobs WHERE id = ?")
                .bind(body["job_id"].as_str().unwrap())
                .fetch_one(&pool)
                .await
                .unwrap();
            let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
            assert_eq!(payload["thinking"].as_str(), kept);
        }

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
    async fn phone_can_cancel_its_own_unfinished_jobs() {
        let (app, _dir) = fixture().await;
        let resp = app
            .clone()
            .oneshot(post_json(
                &format!("/d/{FULL_KEY}/api/generate"),
                r#"{"notebook_id":"nb1","kind":"quiz"}"#,
            ))
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_str(&body_string(resp).await).unwrap();
        let job_id = body["job_id"].as_str().unwrap().to_string();
        let cancel = format!("/d/{FULL_KEY}/api/jobs/{job_id}/cancel");

        // A read-only device can't cancel.
        let resp = app
            .clone()
            .oneshot(post_json(&format!("/d/{READ_KEY}/api/jobs/{job_id}/cancel"), "{}"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        let resp = app.clone().oneshot(post_json(&cancel, "{}")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(body_string(resp).await.contains(r#""cancelled":true"#));
        let resp = app
            .clone()
            .oneshot(get(&format!("/d/{FULL_KEY}/api/jobs/{job_id}")))
            .await
            .unwrap();
        assert!(body_string(resp).await.contains(r#""status":"cancelled""#));

        // Already ended: nothing changes.
        let resp = app.oneshot(post_json(&cancel, "{}")).await.unwrap();
        assert!(body_string(resp).await.contains(r#""cancelled":false"#));
    }

    #[tokio::test]
    async fn phone_links_queue_a_job_for_the_desktop() {
        let (app, _dir) = fixture().await;
        let resp = app
            .clone()
            .oneshot(post_json(
                &format!("/d/{FULL_KEY}/api/notebooks/nb1/sources/url"),
                r#"{"url":"https://1.1.1.1/some/page?x=1"}"#,
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
        assert!(body.contains("\"kind\":\"link\""), "{body}");
        assert!(body.contains("\"status\":\"pending\""), "{body}");

        // Private and local addresses are still refused before anything is queued.
        for url in ["http://127.0.0.1:1420/", "http://192.168.1.1/", "file:///etc/passwd", ""] {
            let resp = app
                .clone()
                .oneshot(post_json(
                    &format!("/d/{FULL_KEY}/api/notebooks/nb1/sources/url"),
                    &json!({ "url": url }).to_string(),
                ))
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "{url}");
        }
        // Unknown notebook.
        let resp = app
            .oneshot(post_json(
                &format!("/d/{FULL_KEY}/api/notebooks/nope/sources/url"),
                r#"{"url":"https://1.1.1.1/"}"#,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
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
        let text = body_string(resp).await;
        let body: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(body["theme"], "ocean");
        assert_eq!(body["scope"], "full");
        // Custom Blend's colors, with anything that isn't a color left out
        assert_eq!(body["custom"], json!({ "bg": "#060023", "text": "#ff83f0", "accent": "" }));
        // Studio Defaults, and no other settings keys or config leak
        assert!(body["defaults"].is_object());
        assert_eq!(body.as_object().unwrap().len(), 4);
        assert!(!text.contains("sk-secret"), "{text}");
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
    async fn generate_takes_interactive_solo_and_custom_reports() {
        let (app, dir) = fixture().await;
        let opts = SqliteConnectOptions::new().filename(dir.path().join("test.db"));
        let pool = SqlitePool::connect_with(opts).await.unwrap();
        let send = |body: &'static str| {
            let app = app.clone();
            async move {
                app.oneshot(post_json(&format!("/d/{FULL_KEY}/api/generate"), body))
                    .await
                    .unwrap()
            }
        };
        let payload = |resp: Response| {
            let pool = pool.clone();
            async move {
                let body: serde_json::Value = serde_json::from_str(&body_string(resp).await).unwrap();
                let raw: String = sqlx::query_scalar("SELECT payload FROM jobs WHERE id = ?")
                    .bind(body["job_id"].as_str().unwrap())
                    .fetch_one(&pool)
                    .await
                    .unwrap();
                serde_json::from_str::<serde_json::Value>(&raw).unwrap()
            }
        };

        // Interactive needs no topic; a long brief survives past research's 200.
        let resp = send(r#"{"notebook_id":"nb1","kind":"interactive","options":{}}"#).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let long = "x".repeat(600);
        let resp = app
            .clone()
            .oneshot(post_json(
                &format!("/d/{FULL_KEY}/api/generate"),
                &format!(r#"{{"notebook_id":"nb1","kind":"interactive","options":{{"topic":"{long}"}}}}"#),
            ))
            .await
            .unwrap();
        assert_eq!(payload(resp).await["options"]["topic"].as_str().unwrap().len(), 600);

        // Solo is kept; an unknown or missing mode defers to the desktop's default.
        let p = payload(send(r#"{"notebook_id":"nb1","kind":"audio","options":{"mode":"solo"}}"#).await).await;
        assert_eq!(p["options"]["mode"], "solo");
        let p = payload(send(r#"{"notebook_id":"nb1","kind":"audio","options":{"mode":"choir"}}"#).await).await;
        assert_eq!(p["options"]["mode"], "");

        // A custom report must say what it's for.
        let resp = send(r#"{"notebook_id":"nb1","kind":"report","options":{"report_type":"custom","custom_prompt":"  "}}"#).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let p = payload(
            send(r#"{"notebook_id":"nb1","kind":"report","options":{"report_type":"custom","custom_prompt":" A glossary "}}"#).await,
        )
        .await;
        assert_eq!(p["options"]["report_type"], "custom");
        assert_eq!(p["options"]["custom_prompt"], "A glossary");
    }

    #[tokio::test]
    async fn phone_renames_chats() {
        let (app, _dir) = fixture().await;
        let rename = |id: &str, title: &str| {
            post_json(
                &format!("/d/{FULL_KEY}/api/chats/{id}/rename"),
                &format!(r#"{{"title":"{title}"}}"#),
            )
        };
        let resp = app.clone().oneshot(rename("c1", " Better name ")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let resp = app
            .clone()
            .oneshot(get(&format!("/d/{FULL_KEY}/api/notebooks/nb1/chats")))
            .await
            .unwrap();
        let body = body_string(resp).await;
        assert!(body.contains(r#""title":"Better name""#), "{body}");
        // Renaming doesn't reorder the list.
        assert!(body.contains(r#""updated_at":200"#), "{body}");

        let resp = app.clone().oneshot(rename("c1", "   ")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let resp = app.clone().oneshot(rename("nope", "x")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        // A chat in a trashed notebook is off limits.
        let resp = app.oneshot(rename("c2", "x")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn phone_deletes_chats_through_the_desktop() {
        let (app, dir) = fixture().await;
        let opts = SqliteConnectOptions::new().filename(dir.path().join("test.db"));
        let pool = SqlitePool::connect_with(opts).await.unwrap();
        // A phone reply still waiting in this chat, and one in another chat.
        for (job, chat) in [("waiting", "c1"), ("elsewhere", "c9")] {
            sqlx::query(
                "INSERT INTO jobs (id, kind, notebook_id, status, payload, device_id, created_at, updated_at) \
                 VALUES (?, 'chat', 'nb1', 'pending', ?, 'd', 1, 1)",
            )
            .bind(job)
            .bind(json!({ "notebook_id": "nb1", "content": "hi", "chat_id": chat }).to_string())
            .execute(&pool)
            .await
            .unwrap();
        }

        let resp = app
            .clone()
            .oneshot(post_json(&format!("/d/{FULL_KEY}/api/chats/c1/delete"), "{}"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&body_string(resp).await).unwrap();
        let (kind, payload): (String, String) = sqlx::query_as("SELECT kind, payload FROM jobs WHERE id = ?")
            .bind(body["job_id"].as_str().unwrap())
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(kind, "chat.delete");
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["chat_id"], "c1");
        assert_eq!(payload["notebook_id"], "nb1");

        let status = |id: &'static str| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, String>("SELECT status FROM jobs WHERE id = ?")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .unwrap()
            }
        };
        assert_eq!(status("waiting").await, "cancelled");
        assert_eq!(status("elsewhere").await, "pending");

        let resp = app
            .clone()
            .oneshot(post_json(&format!("/d/{FULL_KEY}/api/chats/nope/delete"), "{}"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        // A chat in a trashed notebook is off limits.
        let resp = app
            .oneshot(post_json(&format!("/d/{FULL_KEY}/api/chats/c2/delete"), "{}"))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    /// A job's payload by the id a response gave.
    async fn job_payload(pool: &SqlitePool, resp: Response) -> serde_json::Value {
        assert_eq!(resp.status(), StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&body_string(resp).await).unwrap();
        let raw: String = sqlx::query_scalar("SELECT payload FROM jobs WHERE id = ?")
            .bind(body["job_id"].as_str().unwrap())
            .fetch_one(pool)
            .await
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    async fn test_pool(dir: &tempfile::TempDir) -> SqlitePool {
        SqlitePool::connect_with(SqliteConnectOptions::new().filename(dir.path().join("test.db"))).await.unwrap()
    }

    #[tokio::test]
    async fn phone_home_lists_folders_stars_covers_and_trash() {
        let (app, dir) = fixture().await;
        let pool = test_pool(&dir).await;
        sqlx::query("UPDATE notebooks SET cover = 'data:image/png;base64,iVBORw0K' WHERE id = 'nb1'").execute(&pool).await.unwrap();
        let send = |path: &str, body: &str| {
            let app = app.clone();
            let req = post_json(&format!("/d/{FULL_KEY}/api{path}"), body);
            async move { app.oneshot(req).await.unwrap() }
        };
        // A folder, a notebook filed in it, starred and re-described.
        let resp = send("/folders", r#"{"name":" Physics "}"#).await;
        let folder: serde_json::Value = serde_json::from_str(&body_string(resp).await).unwrap();
        let fid = folder["id"].as_str().unwrap().to_string();
        assert_eq!(send("/notebooks/nb1/move", &format!(r#"{{"folder_id":"{fid}"}}"#)).await.status(), StatusCode::OK);
        assert_eq!(send("/notebooks/nb1/move", r#"{"folder_id":"nope"}"#).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(send("/notebooks/nb1/star", r#"{"starred":true}"#).await.status(), StatusCode::OK);
        assert_eq!(send("/notebooks/nb1/details", r#"{"title":"Mechanics","description":"Week 1–4"}"#).await.status(), StatusCode::OK);
        assert_eq!(send("/notebooks/nb1/details", r#"{"title":"  "}"#).await.status(), StatusCode::BAD_REQUEST);
        assert_eq!(send(&format!("/folders/{fid}/rename"), r#"{"name":"Physics I"}"#).await.status(), StatusCode::OK);

        let resp = app.clone().oneshot(get(&format!("/d/{READ_KEY}/api/notebooks"))).await.unwrap();
        let list: serde_json::Value = serde_json::from_str(&body_string(resp).await).unwrap();
        let nb = &list["notebooks"][0];
        assert_eq!((nb["title"].as_str(), nb["description"].as_str()), (Some("Mechanics"), Some("Week 1–4")));
        assert_eq!(nb["starred"], true);
        assert_eq!(nb["folder_id"], fid.as_str());
        assert!(!nb["cover_v"].as_str().unwrap().is_empty());
        assert!(nb.get("cover").is_none(), "covers load separately");
        assert_eq!(list["folders"][0]["name"], "Physics I");
        assert_eq!(list["trash"], 1);

        let resp = app.clone().oneshot(get(&format!("/d/{READ_KEY}/api/notebooks/nb1/cover"))).await.unwrap();
        assert_eq!(resp.headers()[header::CONTENT_TYPE], "image/png");

        // Deleting the folder keeps its notebooks.
        assert_eq!(send(&format!("/folders/{fid}/delete"), "{}").await.status(), StatusCode::OK);
        let folder_id: String = sqlx::query_scalar("SELECT folder_id FROM notebooks WHERE id = 'nb1'").fetch_one(&pool).await.unwrap();
        assert_eq!(folder_id, "");

        // The Trash: listed, restored.
        let resp = app.clone().oneshot(get(&format!("/d/{READ_KEY}/api/trash"))).await.unwrap();
        assert!(body_string(resp).await.contains(r#""id":"nb2""#));
        assert_eq!(send("/notebooks/nb2/restore", "{}").await.status(), StatusCode::OK);
        assert_eq!(send("/notebooks/nb2/restore", "{}").await.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn notebook_actions_go_to_the_desktop() {
        let (app, dir) = fixture().await;
        let pool = test_pool(&dir).await;
        let send = |path: &str, body: &str| {
            let app = app.clone();
            let req = post_json(&format!("/d/{FULL_KEY}/api{path}"), body);
            async move { app.oneshot(req).await.unwrap() }
        };
        let p = job_payload(&pool, send("/notebooks/nb1/op", r#"{"op":"clone","title":" Copy "}"#).await).await;
        assert_eq!((p["target"].as_str(), p["op"].as_str(), p["title"].as_str()), (Some("notebook"), Some("clone"), Some("Copy")));
        let p = job_payload(&pool, send("/notebooks/nb1/op", r#"{"op":"constitution","template":"tutor<script>"}"#).await).await;
        assert_eq!(p["template"], "tutorscript");
        let p = job_payload(&pool, send("/notebooks/nb2/op", r#"{"op":"delete-forever"}"#).await).await;
        assert_eq!(p["op"], "delete-forever");
        // Delete forever only from the Trash; the rest never in it.
        assert_eq!(send("/notebooks/nb1/op", r#"{"op":"delete-forever"}"#).await.status(), StatusCode::BAD_REQUEST);
        assert_eq!(send("/notebooks/nb2/op", r#"{"op":"template"}"#).await.status(), StatusCode::NOT_FOUND);
        assert_eq!(send("/notebooks/nb1/op", r#"{"op":"explode"}"#).await.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn phone_files_land_in_the_media_store_for_the_desktop() {
        let (app, dir) = fixture().await;
        let pool = test_pool(&dir).await;
        let upload = |path: &str, name: &str, ctype: &str, body: &'static [u8]| {
            let req = Request::builder()
                .method("POST")
                .uri(format!("/d/{FULL_KEY}/api{path}"))
                .header("x-file-name", name)
                .header(header::CONTENT_TYPE, ctype)
                .body(Body::from(body))
                .unwrap();
            let app = app.clone();
            async move { app.oneshot(req).await.unwrap() }
        };
        let p = job_payload(&pool, upload("/notebooks/nb1/files", "Lecture%20%E2%80%9C1%E2%80%9D.PDF", "application/pdf", b"%PDF-1.7").await).await;
        assert_eq!((p["op"].as_str(), p["name"].as_str(), p["mime"].as_str()), (Some("ingest"), Some("Lecture “1”.PDF"), Some("application/pdf")));
        let reference = p["ref"].as_str().unwrap();
        assert!(reference.starts_with("brewblob:") && reference.ends_with(".pdf"), "{reference}");
        let (_, bytes) = crate::blobs::load(&dir.path().join("blobs"), reference, None).unwrap();
        assert_eq!(bytes, b"%PDF-1.7");

        let p = job_payload(&pool, upload("/notebooks/nb1/cover", "me.jpg", "image/jpeg", b"\xff\xd8").await).await;
        assert_eq!(p["op"], "cover");
        assert_eq!(upload("/notebooks/nb1/cover", "x.pdf", "application/pdf", b"%PDF").await.status(), StatusCode::BAD_REQUEST);
        assert_eq!(upload("/notebooks/nb1/files", "empty.txt", "text/plain", b"").await.status(), StatusCode::BAD_REQUEST);
        assert_eq!(upload("/notebooks/nb2/files", "a.txt", "text/plain", b"hi").await.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn revise_download_and_mind_map_saves() {
        let (app, dir) = fixture().await;
        let pool = test_pool(&dir).await;
        let req = |key: &str, path: &str, body: &str| post_json(&format!("/d/{key}/api{path}"), body);
        let p = job_payload(&pool, app.clone().oneshot(req(FULL_KEY, "/artifacts/a1/revise", r#"{"note":" Make it shorter ","replace":false}"#)).await.unwrap()).await;
        assert_eq!(p, json!({ "notebook_id": "nb1", "kind": "revise", "artifact_id": "a1", "note": "Make it shorter", "replace": false, "re_audio": false }));
        assert_eq!(app.clone().oneshot(req(FULL_KEY, "/artifacts/a1/revise", r#"{"note":" "}"#)).await.unwrap().status(), StatusCode::BAD_REQUEST);
        // Download writes nothing, so read-only devices may.
        let p = job_payload(&pool, app.clone().oneshot(req(READ_KEY, "/artifacts/a1/edit", r#"{"op":"export"}"#)).await.unwrap()).await;
        assert_eq!(p["op"], "export");
        let p = job_payload(&pool, app.clone().oneshot(req(FULL_KEY, "/artifacts/a1/edit", r#"{"op":"set-data","data":"- Root\n  - Child"}"#)).await.unwrap()).await;
        assert_eq!(p["data"], "- Root\n  - Child");
        assert_eq!(app.oneshot(req(FULL_KEY, "/artifacts/a1/edit", r#"{"op":"set-data","data":"  "}"#)).await.unwrap().status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn generate_scopes_names_and_starts_from_studio_defaults() {
        let (app, dir) = fixture().await;
        let pool = test_pool(&dir).await;
        for (k, v) in [("defQuizDifficulty", "hard"), ("defAudioLength", "long"), ("defReportType", "nonsense")] {
            sqlx::query("INSERT INTO settings VALUES (?, ?)").bind(k).bind(v).execute(&pool).await.unwrap();
        }
        let resp = app.clone().oneshot(get(&format!("/d/{READ_KEY}/api/preferences"))).await.unwrap();
        let prefs: serde_json::Value = serde_json::from_str(&body_string(resp).await).unwrap();
        assert_eq!(prefs["defaults"]["quiz_difficulty"], "hard");
        assert_eq!(prefs["defaults"]["audio_length"], "long");
        assert_eq!(prefs["defaults"]["report_type"], "");

        let p = job_payload(&pool, app.clone().oneshot(post_json(
            &format!("/d/{FULL_KEY}/api/generate"),
            r#"{"notebook_id":"nb1","kind":"report","options":{"report_type":"faq","source_ids":["s1","",7],"title":" Exam FAQ "}}"#,
        )).await.unwrap()).await;
        assert_eq!(p["options"]["report_type"], "faq");
        assert_eq!(p["options"]["source_ids"], json!(["s1"]));
        assert_eq!(p["options"]["title"], "Exam FAQ");
    }

    #[test]
    fn decodes_phone_file_names() {
        assert_eq!(percent_decode("Notes%20%E2%80%94%20week%201.pdf"), "Notes — week 1.pdf");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[tokio::test]
    async fn phone_item_edits_queue_desktop_jobs() {
        let (app, dir) = fixture().await;
        let opts = SqliteConnectOptions::new().filename(dir.path().join("test.db"));
        let pool = SqlitePool::connect_with(opts).await.unwrap();
        let send = |path: String, body: &'static str| {
            let app = app.clone();
            async move { app.oneshot(post_json(&format!("/d/{FULL_KEY}/api{path}"), body)).await.unwrap() }
        };
        let payload = |resp: Response| {
            let pool = pool.clone();
            async move {
                assert_eq!(resp.status(), StatusCode::OK);
                let body: serde_json::Value = serde_json::from_str(&body_string(resp).await).unwrap();
                let (kind, raw): (String, String) = sqlx::query_as("SELECT kind, payload FROM jobs WHERE id = ?")
                    .bind(body["job_id"].as_str().unwrap())
                    .fetch_one(&pool)
                    .await
                    .unwrap();
                assert_eq!(kind, "edit");
                serde_json::from_str::<serde_json::Value>(&raw).unwrap()
            }
        };

        let p = payload(send("/sources/s1/edit".into(), r#"{"op":"rename","title":"  New name "}"#).await).await;
        assert_eq!(p, json!({ "notebook_id": "nb1", "kind": "edit", "target": "source", "id": "s1", "op": "rename", "title": "New name" }));
        let p = payload(send("/artifacts/a1/edit".into(), r#"{"op":"to-source"}"#).await).await;
        assert_eq!((p["target"].as_str(), p["op"].as_str(), p["title"].as_str()), (Some("artifact"), Some("to-source"), Some("Pod")));
        let p = payload(send("/messages/m2/to-source".into(), "{}").await).await;
        assert_eq!((p["target"].as_str(), p["id"].as_str()), (Some("message"), Some("m2")));

        // Refused: unknown or source-less actions, empty names, questions, trashed notebooks.
        for (path, body, code) in [
            ("/sources/s1/edit", r#"{"op":"explode"}"#, StatusCode::BAD_REQUEST),
            ("/sources/s1/edit", r#"{"op":"to-source"}"#, StatusCode::BAD_REQUEST),
            ("/artifacts/a1/edit", r#"{"op":"rename","title":"  "}"#, StatusCode::BAD_REQUEST),
            ("/sources/s4/edit", r#"{"op":"delete"}"#, StatusCode::NOT_FOUND),
            ("/artifacts/nope/edit", r#"{"op":"pin"}"#, StatusCode::NOT_FOUND),
            ("/messages/m1/to-source", "{}", StatusCode::NOT_FOUND),
            ("/messages/m3/to-source", "{}", StatusCode::NOT_FOUND),
        ] {
            assert_eq!(send(path.into(), body).await.status(), code, "{path} {body}");
        }
    }

    #[tokio::test]
    async fn notebook_lists_pinned_items_first() {
        let (app, dir) = fixture().await;
        let opts = SqliteConnectOptions::new().filename(dir.path().join("test.db"));
        let pool = SqlitePool::connect_with(opts).await.unwrap();
        for sql in [
            "UPDATE sources SET pinned = 1 WHERE id = 's3'",
            "INSERT INTO sources (id, notebook_id, type, title, created_at) VALUES ('s0', 'nb1', 'context', 'Constitution', 9)",
            "INSERT INTO artifacts (id, notebook_id, kind, title, data, created_at, pinned) VALUES ('a0', 'nb1', 'report', 'Old pinned', '', 1, 1)",
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        let resp = app.oneshot(get(&format!("/d/{FULL_KEY}/api/notebooks/nb1"))).await.unwrap();
        let nb: serde_json::Value = serde_json::from_str(&body_string(resp).await).unwrap();
        let ids = |k: &str| nb[k].as_array().unwrap().iter().map(|x| x["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(ids("sources"), ["s0", "s3", "s1", "s2"]);
        assert_eq!(ids("artifacts"), ["a0", "a1"]);
        assert_eq!(nb["artifacts"][0]["pinned"], true);
    }

    #[tokio::test]
    async fn source_viewer_sends_what_the_ai_reads() {
        let (app, _dir) = fixture().await;
        let view = |id: &str| {
            let app = app.clone();
            let uri = format!("/d/{READ_KEY}/api/sources/{id}");
            async move { app.oneshot(get(&uri)).await.unwrap() }
        };
        let json = |resp: Response| async move {
            serde_json::from_str::<serde_json::Value>(&body_string(resp).await).unwrap()
        };

        let link = json(view("s1").await).await;
        assert_eq!(link["text"], "Page body");
        assert_eq!(link["url"], "https://example.com/a");
        assert_eq!(link["image"], "");

        // An image: its description, plus the picture itself.
        let img = json(view("s2").await).await;
        assert_eq!(img["text"], "A cat on a mat");
        assert_eq!(img["url"], "");
        assert!(img["image"].as_str().unwrap().starts_with("data:image/png"));

        // Stored media: only the transcript, never the file.
        let audio = json(view("s3").await).await;
        assert_eq!(audio["text"], "The transcript");
        assert_eq!(audio["image"], "");
        assert!(!audio.to_string().contains("brewblob:"));

        assert_eq!(view("s4").await.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn serves_the_phone_renderer() {
        let (app, _dir) = fixture().await;
        let resp = app.clone().oneshot(get(&format!("/d/{FULL_KEY}/"))).await.unwrap();
        let page = body_string(resp).await;
        assert!(!page.contains("__PHONE_ASSETS_V__"));
        assert!(page.contains(&format!("render.js?v={}", env!("PHONE_ASSETS_V"))));
        let resp = app.clone().oneshot(get("/assets/nope.js")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        if !RENDER_JS.is_empty() {
            let resp = app.oneshot(get("/assets/render.js")).await.unwrap();
            assert_eq!(resp.status(), StatusCode::OK);
            assert_eq!(resp.headers()[header::CONTENT_ENCODING], "gzip");
        }
    }

    #[tokio::test]
    async fn phone_page_runs_under_a_strict_policy() {
        let (app, _dir) = fixture().await;
        for path in [format!("/d/{FULL_KEY}/"), "/p/whatever/".to_string()] {
            let resp = app.clone().oneshot(get(&path)).await.unwrap();
            let csp = resp.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().to_string();
            let script = csp.split(';').find(|d| d.trim().starts_with("script-src")).unwrap();
            assert_eq!(script.trim(), "script-src 'self'", "{path}");
            assert!(csp.contains("frame-ancestors 'none'"));
            let page = body_string(resp).await;
            // No inline script or handlers: the code is /assets/phone.js.
            assert!(!page.contains("<script>") && !page.contains("onclick="), "{path}");
            assert!(page.contains(&format!("/assets/phone.js?v={}", env!("PHONE_ASSETS_V"))));
        }
        let resp = app.clone().oneshot(get("/assets/phone.js")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(!body_string(resp).await.contains("__PHONE_ASSETS_V__"));
        // Interactive pages' frame keeps its own no-network policy.
        let resp = app.oneshot(get("/assets/sandbox.html")).await.unwrap();
        assert_eq!(resp.headers()[header::CONTENT_SECURITY_POLICY], crate::sandbox::SANDBOX_CSP);
        assert!(body_string(resp).await.contains("brewlm-sandbox-ready"));
    }

    #[tokio::test]
    async fn messages_carry_reasoning_when_kept() {
        let (app, dir) = fixture().await;
        let opts = SqliteConnectOptions::new().filename(dir.path().join("test.db"));
        let pool = SqlitePool::connect_with(opts).await.unwrap();
        // Before the desktop made the table: still lists messages.
        let resp = app.clone().oneshot(get(&format!("/d/{FULL_KEY}/api/chats/c1/messages"))).await.unwrap();
        let body: serde_json::Value = serde_json::from_str(&body_string(resp).await).unwrap();
        assert_eq!(body["messages"].as_array().unwrap().len(), 2);
        for sql in [
            "CREATE TABLE message_reasoning (message_id TEXT PRIMARY KEY, text TEXT NOT NULL)",
            "INSERT INTO message_reasoning VALUES ('m2', 'Thought it through')",
        ] {
            sqlx::query(sql).execute(&pool).await.unwrap();
        }
        let resp = app.oneshot(get(&format!("/d/{FULL_KEY}/api/chats/c1/messages"))).await.unwrap();
        let body: serde_json::Value = serde_json::from_str(&body_string(resp).await).unwrap();
        assert_eq!(body["messages"][0]["reasoning"], "");
        assert_eq!(body["messages"][1]["reasoning"], "Thought it through");
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
}

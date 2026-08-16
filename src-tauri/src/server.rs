//! Phone sharing: embedded read-only web server + Cloudflare quick tunnel.
//!
//! - `axum` server on 127.0.0.1 (random port) serving a mobile client and a
//!   JSON API over the existing `brewlm.db` SQLite file (WAL lets it coexist
//!   with the webview's own connection).
//! - Everything lives under `/s/{token}` — requests without the per-session
//!   random token fall through to a 404.
//! - `cloudflared` (Quick Tunnel, no account) exposes the server to phones on
//!   any network; the desktop only makes an outbound connection.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;
use serde_json::json;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePool},
    Row,
};

const MOBILE_HTML: &str = include_str!("../mobile.html");

/* ---------------------------------- state ---------------------------------- */

#[derive(Clone, Serialize)]
pub struct ShareInfo {
    /// Public tunnel URL (e.g. https://x-y-z.trycloudflare.com) when cloudflared
    /// is available; null while starting or when the binary is missing.
    pub url: Option<String>,
    pub token: String,
    pub port: u16,
    pub tunnel: bool,
    pub warning: Option<String>,
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

#[derive(Clone)]
struct ServerState {
    pool: SqlitePool,
    /// artifact id → (mime, decoded audio bytes); artifacts are immutable.
    audio_cache: Arc<Mutex<HashMap<String, (String, Vec<u8>)>>>,
}

/* ------------------------------ start / stop ------------------------------- */

fn random_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn find_cloudflared() -> Option<PathBuf> {
    for p in [
        "/opt/homebrew/bin/cloudflared",
        "/usr/local/bin/cloudflared",
        "/usr/bin/cloudflared",
    ] {
        let pb = PathBuf::from(p);
        if pb.exists() {
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

fn build_router(state: ServerState, token: &str) -> Router {
    let base = format!("/s/{token}");
    Router::new()
        .route(&base, get(index_handler))
        .route(&format!("{base}/"), get(index_handler))
        .route(&format!("{base}/api/notebooks"), get(notebooks_handler))
        .route(
            &format!("{base}/api/preferences"),
            get(preferences_handler),
        )
        .route(
            &format!("{base}/api/notebooks/{{id}}"),
            get(notebook_handler),
        )
        .route(
            &format!("{base}/api/artifacts/{{id}}"),
            get(artifact_handler),
        )
        .route(
            &format!("{base}/api/artifacts/{{id}}/audio"),
            get(audio_handler),
        )
        .fallback(|| async { (StatusCode::NOT_FOUND, "not found") })
        .with_state(state)
}

/// Starts the server + tunnel. Blocking-ish (waits for the tunnel URL), so
/// callers run it on a background thread. Returns the session pieces.
pub fn start_sharing_sync(
    db_dir: PathBuf,
) -> Result<(ShareInfo, tokio::sync::oneshot::Sender<()>, Option<Child>), String> {
    std::fs::create_dir_all(&db_dir).map_err(|e| format!("app data dir: {e}"))?;
    let db_path = db_dir.join("brewlm.db");

    let opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5));

    let token = random_token();

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
    let token_for_thread = token.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(async move {
            // Pool and router live inside the runtime (sqlx spawns a reaper at pool creation).
            let pool = SqlitePool::connect_lazy_with(opts);
            let state = ServerState {
                pool,
                audio_cache: Arc::new(Mutex::new(HashMap::new())),
            };
            let app = build_router(state, &token_for_thread);
            let listener = tokio::net::TcpListener::from_std(std_listener).expect("listener");
            println!("SHARE_SERVER_LISTENING port={port}");
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await
                .expect("serve");
        });
    });

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
        // Quick tunnels usually land within a few seconds.
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
        token,
        port,
        tunnel: child.is_some(),
        warning,
    };
    Ok((info, shutdown_tx, child))
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
        match start_sharing_sync(dir) {
            Ok((info, tx, child)) => {
                *handle.state::<SharingState>().0.lock().unwrap() = Some(ShareSession {
                    info: info.clone(),
                    shutdown: Some(tx),
                    tunnel_child: child,
                });
                println!(
                    "SHARE_AUTO_READY url={:?} token={} port={}",
                    info.url, info.token, info.port
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
) -> Result<ShareInfo, String> {
    use tauri::Manager;
    if let Some(session) = state.0.lock().unwrap().as_ref() {
        return Ok(session.info.clone());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let (info, tx, child) =
        tauri::async_runtime::spawn_blocking(move || start_sharing_sync(dir))
            .await
            .map_err(|e| e.to_string())??;
    println!(
        "SHARE_STARTED url={:?} token={} port={}",
        info.url, info.token, info.port
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

/* --------------------------------- handlers -------------------------------- */

async fn index_handler() -> impl axum::response::IntoResponse {
    (
        [(header::CACHE_CONTROL, "no-store")],
        Html(MOBILE_HTML),
    )
}

fn no_store_json(v: serde_json::Value) -> impl axum::response::IntoResponse {
    ([(header::CACHE_CONTROL, "no-store")], Json(v))
}

async fn notebooks_handler(State(st): State<ServerState>) -> Response {
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

/// Exposes ONLY the UI theme preference — never arbitrary settings (keys).
async fn preferences_handler(State(st): State<ServerState>) -> Response {
    let row = sqlx::query("SELECT value FROM settings WHERE key = 'theme'")
        .fetch_optional(&st.pool)
        .await;
    let theme = match row {
        Ok(Some(r)) => r.get::<String, _>("value"),
        _ => "original".to_string(),
    };
    no_store_json(json!({ "theme": theme })).into_response()
}

async fn notebook_handler(State(st): State<ServerState>, Path(id): Path<String>) -> Response {
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

async fn artifact_handler(State(st): State<ServerState>, Path(id): Path<String>) -> Response {
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
/// Returns (start, end) inclusive, or None to send the whole body.
fn parse_range(h: Option<&str>, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let h = h?.trim().strip_prefix("bytes=")?;
    // Only single ranges are supported (browsers only ever send one).
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
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
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

    async fn fixture() -> (Router, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let opts = SqliteConnectOptions::new()
            .filename(dir.path().join("test.db"))
            .create_if_missing(true);
        let pool = SqlitePool::connect_with(opts).await.unwrap();
        sqlx::query(
            "CREATE TABLE notebooks (id TEXT PRIMARY KEY, title TEXT NOT NULL, \
             description TEXT NOT NULL DEFAULT '', cover TEXT NOT NULL DEFAULT '', \
             updated_at INTEGER NOT NULL, trashed_at INTEGER NOT NULL DEFAULT 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE artifacts (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, \
             kind TEXT NOT NULL, title TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO notebooks VALUES ('nb1', 'Test Notebook', 'desc', '', 123, 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO notebooks VALUES ('nb2', 'Trashed', 'd', '', 124, 1)")
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
        sqlx::query(
            "INSERT INTO artifacts VALUES ('f1', 'nb1', 'flashcards', 'Cards', '[]', 101)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
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
        };
        (build_router(state, "test-token"), dir)
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
            .oneshot(
                Request::builder()
                    .uri("/s/WRONG/api/notebooks")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn lists_notebooks_excluding_trash() {
        let (app, _dir) = fixture().await;
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/s/test-token/api/notebooks")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_string(resp).await;
        assert!(body.contains("Test Notebook"));
        assert!(!body.contains("Trashed"));
    }

    #[tokio::test]
    async fn artifact_strips_audio_data_url() {
        let (app, _dir) = fixture().await;
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/s/test-token/api/artifacts/a1")
                    .body(Body::empty())
                    .unwrap(),
            )
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
            .oneshot(
                Request::builder()
                    .uri("/s/test-token/api/artifacts/a1/audio")
                    .body(Body::empty())
                    .unwrap(),
            )
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
                    .uri("/s/test-token/api/artifacts/a1/audio")
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

        // suffix range
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/s/test-token/api/artifacts/a1/audio")
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
    async fn index_served_under_token() {
        let (app, _dir) = fixture().await;
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/s/test-token/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_string(resp).await;
        assert!(body.contains("<title>BrewLM</title>"));
    }

    #[tokio::test]
    async fn preferences_returns_theme_only() {
        let (app, _dir) = fixture().await;
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/s/test-token/api/preferences")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_string(resp).await;
        assert_eq!(body, r#"{"theme":"ocean"}"#);
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

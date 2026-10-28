//! Content-addressed media store.
//!
//! Media (podcast audio, images, covers, chat backgrounds) lives as files in
//! `<app data>/blobs/<sha256>.<ext>` instead of base64 inside SQLite; rows hold
//! a `brewblob:<sha256>.<ext>` reference. Identical bytes share one file, so
//! clones and re-saves cost nothing, and Sync can move each file once.
//!
//! - `blob_put` stores raw bytes (sent as the IPC body) and returns the ref.
//! - The `brewblob` URI scheme serves files to the webview, with Range support
//!   so `<audio>` can seek, and CORS so `fetch()`/canvas can read them.
//! - `blob_gc` deletes files no row references any more.
//! - `backup_export` / `backup_restore_zip` bundle the database + blobs.
//! - `snapshot_before_media_move` keeps a safety copy while the one-time media
//!   migration rewrites audio (WAV → AAC is lossy).

use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use sha2::{Digest, Sha256};
use tauri::{
    http::{header, Request, Response, StatusCode},
    Manager,
};

pub const REF_PREFIX: &str = "brewblob:";

pub fn blob_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("blobs"))
}

/// `<64 hex>.<ext>` — the only file names the store creates or serves.
fn valid_name(name: &str) -> bool {
    let Some((hash, ext)) = name.split_once('.') else {
        return false;
    };
    hash.len() == 64
        && hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && (1..=5).contains(&ext.len())
        && ext.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

pub fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "weba" => "audio/webm",
        "flac" => "audio/flac",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Write bytes under their hash (atomically: temp file + rename). Returns the ref.
pub fn put(dir: &Path, bytes: &[u8], ext: &str) -> Result<String, String> {
    let ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    let hash = format!("{:x}", Sha256::digest(bytes));
    let name = format!("{hash}.{ext}");
    if !valid_name(&name) {
        return Err(format!("bad blob extension: {ext:?}"));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("blobs dir: {e}"))?;
    let path = dir.join(&name);
    if !path.exists() {
        let tmp = dir.join(format!(".{name}.{}.tmp", rand::random::<u32>()));
        std::fs::write(&tmp, bytes).map_err(|e| format!("write blob: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("store blob: {e}")
        })?;
    }
    Ok(format!("{REF_PREFIX}{name}"))
}

/// Media bytes + mime for a stored value: a `brewblob:` ref, a `data:` URL, or
/// (image library rows) raw base64 with the mime kept beside it.
pub fn load(dir: &Path, value: &str, raw_b64_mime: Option<&str>) -> Option<(String, Vec<u8>)> {
    let value = value.trim();
    if let Some(name) = value.strip_prefix(REF_PREFIX) {
        if !valid_name(name) {
            return None;
        }
        let bytes = std::fs::read(dir.join(name)).ok()?;
        let ext = name.rsplit('.').next().unwrap_or("");
        let mime = raw_b64_mime.unwrap_or(mime_for_ext(ext)).to_string();
        return Some((mime, bytes));
    }
    if let Some(rest) = value.strip_prefix("data:") {
        let (prefix, b64) = rest.split_once(',')?;
        let mime = prefix.trim_end_matches(";base64").to_string();
        let clean: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
        return Some((mime, B64.decode(clean).ok()?));
    }
    let mime = raw_b64_mime?;
    Some((mime.to_string(), B64.decode(value).ok()?))
}

/// A `data:` URL for a stored value (the phone client embeds covers/images inline).
pub fn to_data_url(dir: &Path, value: &str) -> String {
    if !value.starts_with(REF_PREFIX) {
        return value.to_string();
    }
    match load(dir, value, None) {
        Some((mime, bytes)) => format!("data:{mime};base64,{}", B64.encode(bytes)),
        None => String::new(),
    }
}

/* -------------------------------- commands -------------------------------- */

/// Raw IPC body = the file bytes; `x-blob-ext` header = extension (mp3, jpg…).
#[tauri::command]
pub async fn blob_put(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("blob_put expects raw bytes".into());
    };
    let ext = request
        .headers()
        .get("x-blob-ext")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("bin")
        .to_string();
    let dir = blob_dir(&app)?;
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || put(&dir, &bytes, &ext))
        .await
        .map_err(|e| e.to_string())?
}

/// Which of these file names (`<hash>.<ext>`, `brewblob:` prefix optional)
/// this device doesn't have — Sync downloads them. Invalid names are dropped.
#[tauri::command]
pub fn blob_missing(app: tauri::AppHandle, names: Vec<String>) -> Result<Vec<String>, String> {
    Ok(missing(&blob_dir(&app)?, names))
}

fn missing(dir: &Path, names: Vec<String>) -> Vec<String> {
    names
        .into_iter()
        .map(|n| n.trim_start_matches(REF_PREFIX).to_string())
        .filter(|n| valid_name(n) && !dir.join(n).exists())
        .collect()
}

#[derive(serde::Serialize)]
pub struct GcResult {
    removed: u32,
    freed_bytes: u64,
}

/// Delete blobs not named in `keep` that are older than `grace_ms` (a file is
/// written a moment before the row that references it).
#[tauri::command]
pub async fn blob_gc(app: tauri::AppHandle, keep: Vec<String>, grace_ms: u64) -> Result<GcResult, String> {
    let dir = blob_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || gc(&dir, &keep, grace_ms))
        .await
        .map_err(|e| e.to_string())?
}

fn gc(dir: &Path, keep: &[String], grace_ms: u64) -> Result<GcResult, String> {
    let keep: HashSet<&str> = keep.iter().map(|r| r.trim_start_matches(REF_PREFIX)).collect();
    let cutoff = SystemTime::now() - Duration::from_millis(grace_ms);
    let mut out = GcResult { removed: 0, freed_bytes: 0 };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(out); // no blobs yet
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_tmp = name.starts_with('.') && name.ends_with(".tmp");
        if !is_tmp && (!valid_name(&name) || keep.contains(name.as_str())) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.modified().map(|m| m > cutoff).unwrap_or(true) {
            continue;
        }
        if std::fs::remove_file(entry.path()).is_ok() {
            out.removed += 1;
            out.freed_bytes += meta.len();
        }
    }
    Ok(out)
}

/// Zip the database (WAL already checkpointed by the caller) + every blob.
/// Media is already compressed, so entries are stored, not deflated.
#[tauri::command]
pub async fn backup_export(app: tauri::AppHandle, dest: String) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || export_zip(&data_dir, Path::new(&dest)))
        .await
        .map_err(|e| e.to_string())?
}

fn export_zip(data_dir: &Path, dest: &Path) -> Result<(), String> {
    use zip::write::SimpleFileOptions;
    let opts = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);
    let tmp = dest.with_extension("partial");
    let file = File::create(&tmp).map_err(|e| format!("create backup: {e}"))?;
    let mut zw = zip::ZipWriter::new(file);
    let add = |zw: &mut zip::ZipWriter<File>, name: &str, path: &Path| -> Result<(), String> {
        zw.start_file(name, opts).map_err(|e| e.to_string())?;
        let mut f = File::open(path).map_err(|e| format!("read {name}: {e}"))?;
        std::io::copy(&mut f, zw).map_err(|e| format!("write {name}: {e}"))?;
        Ok(())
    };
    add(&mut zw, "brewlm.db", &data_dir.join("brewlm.db"))?;
    if let Ok(entries) = std::fs::read_dir(data_dir.join("blobs")) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if valid_name(&name) {
                add(&mut zw, &format!("blobs/{name}"), &entry.path())?;
            }
        }
    }
    zw.finish().map_err(|e| e.to_string())?.flush().map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dest).map_err(|e| format!("save backup: {e}"))
}

/// Restore a zip backup: replace brewlm.db, add its blobs. The caller closes
/// the database and truncates the WAL sidecars first, then reloads.
#[tauri::command]
pub async fn backup_restore_zip(app: tauri::AppHandle, src: String) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || restore_zip(&data_dir, Path::new(&src)))
        .await
        .map_err(|e| e.to_string())?
}

fn restore_zip(data_dir: &Path, src: &Path) -> Result<(), String> {
    let file = File::open(src).map_err(|e| format!("open backup: {e}"))?;
    // Backups are stored uncompressed, so what they unpack to is about their
    // own size; allow for one recompressed elsewhere, but never a "zip bomb"
    // that would fill the disk.
    let zipped = file.metadata().map_err(|e| format!("open backup: {e}"))?.len();
    let mut budget = zipped.saturating_mul(10).saturating_add(64 << 20);
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("not a BrewLM backup: {e}"))?;
    if zip.index_for_name("brewlm.db").is_none() {
        return Err("not a BrewLM backup (no brewlm.db inside)".into());
    }
    let blobs = data_dir.join("blobs");
    std::fs::create_dir_all(&blobs).map_err(|e| format!("blobs dir: {e}"))?;
    let mut db_tmp: Option<PathBuf> = None;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let target = if name == "brewlm.db" {
            let p = data_dir.join("brewlm.db.restoring");
            db_tmp = Some(p.clone());
            p
        } else if let Some(blob) = name.strip_prefix("blobs/").filter(|n| valid_name(n)) {
            blobs.join(blob)
        } else {
            continue; // ignore anything we didn't write
        };
        let mut out = File::create(&target).map_err(|e| format!("restore {name}: {e}"))?;
        let copied = std::io::copy(&mut (&mut entry).take(budget + 1), &mut out)
            .map_err(|e| format!("restore {name}: {e}"))?;
        if copied > budget {
            drop(out);
            let _ = std::fs::remove_file(&target);
            if let Some(p) = &db_tmp {
                let _ = std::fs::remove_file(p);
            }
            return Err("not a BrewLM backup (it unpacks to far more than its size)".into());
        }
        budget -= copied;
    }
    let db_tmp = db_tmp.ok_or("backup has no database")?;
    std::fs::rename(db_tmp, data_dir.join("brewlm.db")).map_err(|e| format!("restore database: {e}"))
}

/* --------------------------- migration snapshot --------------------------- */

const MEDIA_SNAPSHOT: &str = "brewlm.db.before-media-move";
const SNAPSHOT_KEEP: Duration = Duration::from_secs(30 * 86_400);

/// Copy the database once, before the media migration first compresses audio.
/// `VACUUM INTO` writes a consistent snapshot even while the app has the file
/// open. An existing snapshot is kept as is. Errors (disk full…) tell the
/// caller to leave audio untouched. The file is a plain `.db` backup, so
/// Settings → Import backup can restore it.
#[tauri::command]
pub async fn snapshot_before_media_move(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    snapshot(&dir).await.map(|p| p.to_string_lossy().to_string())
}

async fn snapshot(dir: &Path) -> Result<PathBuf, String> {
    use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions};
    let dest = dir.join(MEDIA_SNAPSHOT);
    if dest.exists() {
        return Ok(dest);
    }
    let tmp = dir.join(format!("{MEDIA_SNAPSHOT}.partial"));
    let _ = std::fs::remove_file(&tmp);
    let mut conn = SqliteConnectOptions::new()
        .filename(dir.join("brewlm.db"))
        .busy_timeout(Duration::from_secs(10))
        .connect()
        .await
        .map_err(|e| format!("open database: {e}"))?;
    sqlx::query("VACUUM INTO ?")
        .bind(tmp.to_string_lossy().to_string())
        .execute(&mut conn)
        .await
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("snapshot: {e}")
        })?;
    std::fs::rename(&tmp, &dest).map_err(|e| format!("snapshot: {e}"))?;
    Ok(dest)
}

/// Delete the migration snapshot once it is 30 days old. The caller only asks
/// when no audio is still waiting to be compressed.
#[tauri::command]
pub fn prune_media_snapshot(app: tauri::AppHandle) -> Result<bool, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(prune_snapshot(&dir, SNAPSHOT_KEEP))
}

fn prune_snapshot(dir: &Path, keep: Duration) -> bool {
    let path = dir.join(MEDIA_SNAPSHOT);
    let old = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .map(|t| t.elapsed().map(|age| age >= keep).unwrap_or(false))
        .unwrap_or(false);
    old && std::fs::remove_file(path).is_ok()
}

/* ------------------------------ URI scheme -------------------------------- */

/// `brewblob://localhost/<name>` (macOS/Linux) or `http://brewblob.localhost/<name>`
/// (Windows). Serves whole files or a single byte range.
pub fn serve(app: &tauri::AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let respond = |status: StatusCode| Response::builder().status(status).body(Vec::new()).unwrap();
    let name = request.uri().path().trim_start_matches('/').to_string();
    if !valid_name(&name) {
        return respond(StatusCode::NOT_FOUND);
    }
    let Ok(dir) = blob_dir(app) else {
        return respond(StatusCode::INTERNAL_SERVER_ERROR);
    };
    let Ok(mut file) = File::open(dir.join(&name)) else {
        return respond(StatusCode::NOT_FOUND);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mime = mime_for_ext(name.rsplit('.').next().unwrap_or(""));
    let base = || {
        Response::builder()
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range, Content-Length, Accept-Ranges")
            // Content-addressed: a name's bytes never change.
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
    };
    let range = request.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
    match crate::server::parse_range(range, len) {
        Some((start, end)) => {
            let mut buf = vec![0u8; (end - start + 1) as usize];
            if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err() {
                return respond(StatusCode::INTERNAL_SERVER_ERROR);
            }
            base()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
                .header(header::CONTENT_LENGTH, buf.len())
                .body(buf)
                .unwrap()
        }
        None => {
            let mut buf = Vec::with_capacity(len as usize);
            if file.read_to_end(&mut buf).is_err() {
                return respond(StatusCode::INTERNAL_SERVER_ERROR);
            }
            base().status(StatusCode::OK).header(header::CONTENT_LENGTH, buf.len()).body(buf).unwrap()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_is_content_addressed_and_loadable() {
        let dir = tempfile::tempdir().unwrap();
        let a = put(dir.path(), b"hello", "MP3").unwrap();
        let b = put(dir.path(), b"hello", ".mp3").unwrap();
        assert_eq!(a, b);
        assert!(a.starts_with("brewblob:") && a.ends_with(".mp3"));
        let (mime, bytes) = load(dir.path(), &a, None).unwrap();
        assert_eq!((mime.as_str(), bytes.as_slice()), ("audio/mpeg", b"hello".as_slice()));
        assert!(put(dir.path(), b"x", "../../etc").is_err());
    }

    #[test]
    fn load_accepts_data_urls_and_raw_base64() {
        let dir = tempfile::tempdir().unwrap();
        let (m, b) = load(dir.path(), "data:image/png;base64,aGk=", None).unwrap();
        assert_eq!((m.as_str(), b.as_slice()), ("image/png", b"hi".as_slice()));
        let (m, b) = load(dir.path(), "aGk=", Some("image/jpeg")).unwrap();
        assert_eq!((m.as_str(), b.as_slice()), ("image/jpeg", b"hi".as_slice()));
        assert!(load(dir.path(), "brewblob:../secret", None).is_none());
    }

    #[test]
    fn missing_lists_only_absent_valid_names() {
        let dir = tempfile::tempdir().unwrap();
        let have = put(dir.path(), b"have", "png").unwrap();
        let absent = format!("{}.m4a", "a".repeat(64));
        let got = missing(dir.path(), vec![have, format!("brewblob:{absent}"), "../etc/passwd".into()]);
        assert_eq!(got, vec![absent]);
    }

    #[test]
    fn gc_keeps_referenced_and_recent_files() {
        let dir = tempfile::tempdir().unwrap();
        let keep = put(dir.path(), b"keep", "png").unwrap();
        let drop = put(dir.path(), b"drop", "png").unwrap();
        // Everything is brand new: the grace period protects it.
        assert_eq!(gc(dir.path(), &[keep.clone()], 60_000).unwrap().removed, 0);
        let r = gc(dir.path(), &[keep.clone()], 0).unwrap();
        assert_eq!(r.removed, 1);
        assert!(load(dir.path(), &keep, None).is_some());
        assert!(load(dir.path(), &drop, None).is_none());
    }

    #[tokio::test]
    async fn snapshot_copies_once_and_prunes_when_old() {
        use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions, Connection};
        let dir = tempfile::tempdir().unwrap();
        let mut conn = SqliteConnectOptions::new()
            .filename(dir.path().join("brewlm.db"))
            .create_if_missing(true)
            .connect()
            .await
            .unwrap();
        sqlx::query("CREATE TABLE t (v TEXT)").execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO t VALUES ('original')").execute(&mut conn).await.unwrap();

        let snap = snapshot(dir.path()).await.unwrap();
        sqlx::query("UPDATE t SET v = 'changed'").execute(&mut conn).await.unwrap();
        // A second call keeps the first snapshot (taken before any change).
        assert_eq!(snapshot(dir.path()).await.unwrap(), snap);
        let mut copy = SqliteConnectOptions::new().filename(&snap).connect().await.unwrap();
        let v: (String,) = sqlx::query_as("SELECT v FROM t").fetch_one(&mut copy).await.unwrap();
        assert_eq!(v.0, "original");
        // Windows can't delete a file that is still open.
        copy.close().await.unwrap();

        assert!(!prune_snapshot(dir.path(), Duration::from_secs(3600)), "fresh snapshot is kept");
        assert!(prune_snapshot(dir.path(), Duration::ZERO));
        assert!(!snap.exists());
    }

    #[test]
    fn backup_round_trip() {
        let src = tempfile::tempdir().unwrap();
        std::fs::write(src.path().join("brewlm.db"), b"db-bytes").unwrap();
        let r = put(&src.path().join("blobs"), b"audio", "m4a").unwrap();
        let zip_path = src.path().join("b.zip");
        export_zip(src.path(), &zip_path).unwrap();

        let dst = tempfile::tempdir().unwrap();
        std::fs::write(dst.path().join("brewlm.db"), b"old").unwrap();
        restore_zip(dst.path(), &zip_path).unwrap();
        assert_eq!(std::fs::read(dst.path().join("brewlm.db")).unwrap(), b"db-bytes");
        assert!(load(&dst.path().join("blobs"), &r, None).is_some());
    }
}

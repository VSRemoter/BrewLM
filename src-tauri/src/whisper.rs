//! Built-in transcription: whisper.cpp's `whisper-cli`, bundled as a sidecar
//! (scripts/build-whisper.sh), with speech models downloaded on demand.
//!
//! The program ships with the app (a few MB, signed with it); the models are
//! data (150–575 MB), fetched only when someone turns this on, checked
//! against SHA-256 sums pinned here, and stored in the app's data folder.
//! Nothing leaves the computer while transcribing.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, Manager};

/// A speech model the app knows how to fetch and verify.
pub struct ModelSpec {
    pub id: &'static str,
    pub file: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

/// Pinned from huggingface.co/ggerganov/whisper.cpp (each file's LFS sha256).
pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "fast",
        file: "ggml-base.bin",
        bytes: 147_951_465,
        sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    },
    ModelSpec {
        id: "accurate",
        file: "ggml-large-v3-turbo-q5_0.bin",
        bytes: 574_041_195,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    },
];

const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

pub fn spec(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

fn models_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("whisper-models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The bundled program, else one set with BREWLM_WHISPER_CLI or on the PATH
/// (Homebrew's whisper-cpp), so a build without the sidecar still works.
pub fn find_whisper_cli() -> Option<PathBuf> {
    // Tauri's bundler strips the `-<target-triple>` suffix and puts sidecars
    // next to the app binary (target/debug in dev).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["whisper-cli", "whisper-cli.exe"] {
                let p = dir.join(name);
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    if let Ok(p) = std::env::var("BREWLM_WHISPER_CLI") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    for p in ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli", "/usr/bin/whisper-cli"] {
        if Path::new(p).exists() {
            return Some(PathBuf::from(p));
        }
    }
    None
}

/* ------------------------------- model status ------------------------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    id: &'static str,
    file: &'static str,
    bytes: u64,
    installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperStatus {
    /// The whisper-cli program was found.
    available: bool,
    models: Vec<ModelStatus>,
}

/// A model counts as installed only at its full size (a crash mid-download leaves a .part).
fn installed(dir: &Path, m: &ModelSpec) -> bool {
    std::fs::metadata(dir.join(m.file)).map(|md| md.len() == m.bytes).unwrap_or(false)
}

#[tauri::command]
pub fn whisper_status(app: tauri::AppHandle) -> Result<WhisperStatus, String> {
    let dir = models_dir(&app)?;
    Ok(WhisperStatus {
        available: find_whisper_cli().is_some(),
        models: MODELS
            .iter()
            .map(|m| ModelStatus { id: m.id, file: m.file, bytes: m.bytes, installed: installed(&dir, m) })
            .collect(),
    })
}

#[tauri::command]
pub fn whisper_delete_model(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let m = spec(&id).ok_or("unknown model")?;
    let dir = models_dir(&app)?;
    for p in [dir.join(m.file), dir.join(format!("{}.part", m.file))] {
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/* --------------------------------- download --------------------------------- */

fn cancelled() -> &'static Mutex<HashSet<String>> {
    static C: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashSet::new()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    id: String,
    received: u64,
    total: u64,
}

/// Lower-case hex of a digest.
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// True when a download's size and SHA-256 match the pinned ones.
pub fn matches_pin(received: u64, sha256_hex: &str, m: &ModelSpec) -> bool {
    received == m.bytes && sha256_hex == m.sha256
}

/// Fetch a model into the data folder, reporting progress as
/// `whisper-download` events. Written to `<file>.part` and renamed only once
/// its size and SHA-256 match, so a half or tampered file is never used.
#[tauri::command]
pub async fn whisper_download_model(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let m = spec(&id).ok_or("unknown model")?;
    let dir = models_dir(&app)?;
    let dest = dir.join(m.file);
    if installed(&dir, m) {
        return Ok(());
    }
    cancelled().lock().unwrap().remove(&id);
    let part = dir.join(format!("{}.part", m.file));
    let result = download(&app, m, &part).await;
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
        return result;
    }
    std::fs::rename(&part, &dest).map_err(|e| e.to_string())
}

async fn download(app: &tauri::AppHandle, m: &ModelSpec, part: &Path) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent("BrewLM")
        .build()
        .map_err(|e| e.to_string())?;
    let mut res = client
        .get(format!("{MODEL_URL}{}", m.file))
        .send()
        .await
        .map_err(|_| "Couldn't reach Hugging Face to download the speech model. Check your internet connection.".to_string())?;
    if !res.status().is_success() {
        return Err(format!("The speech model download failed (HTTP {}).", res.status().as_u16()));
    }
    let mut file = std::fs::File::create(part).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    loop {
        let chunk = match res.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(_) => return Err("The download was interrupted. Try again.".into()),
        };
        if cancelled().lock().unwrap().remove(m.id) {
            return Err("cancelled".into());
        }
        file.write_all(&chunk).map_err(|e| format!("Couldn't save the speech model: {e}"))?;
        hasher.update(&chunk);
        received += chunk.len() as u64;
        if received > m.bytes {
            return Err("The download is larger than the speech model should be, so it was discarded.".into());
        }
        // About every 1% (and at the end), not on every chunk.
        if received - last_emit >= m.bytes / 100 || received == m.bytes {
            last_emit = received;
            let _ = app.emit("whisper-download", DownloadProgress { id: m.id.into(), received, total: m.bytes });
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    if !matches_pin(received, &hex(&hasher.finalize()), m) {
        return Err("The downloaded speech model didn't match its checksum, so it was discarded. Try again.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn whisper_cancel_download(id: String) {
    cancelled().lock().unwrap().insert(id);
}

/* -------------------------------- transcribe -------------------------------- */

fn running() -> &'static Mutex<Option<Arc<Mutex<Child>>>> {
    static R: OnceLock<Mutex<Option<Arc<Mutex<Child>>>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

/// One transcription at a time: the model fills memory and all cores.
fn one_at_a_time() -> &'static tokio::sync::Mutex<()> {
    static L: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    L.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// "…progress =  45%" → 45 (whisper-cli's -pp lines on stderr).
pub fn parse_progress(line: &str) -> Option<u32> {
    let rest = line.split("progress =").nth(1)?;
    rest.trim().trim_end_matches('%').trim().parse().ok()
}

/// whisper-cli's arguments for one file.
pub fn cli_args(model: &Path, wav: &Path, out_base: &Path, threads: usize) -> Vec<String> {
    vec![
        "-m".into(),
        model.display().to_string(),
        "-f".into(),
        wav.display().to_string(),
        "-l".into(),
        "auto".into(),
        "-t".into(),
        threads.to_string(),
        "-otxt".into(),
        "-of".into(),
        out_base.display().to_string(),
        "-pp".into(),
    ]
}

/// Raw IPC body = 16 kHz WAV bytes; `x-whisper-model` header = model id.
/// Returns the transcript; `whisper-progress` events carry the percentage.
#[tauri::command]
pub async fn whisper_transcribe(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("whisper_transcribe expects raw audio bytes".into());
    };
    let id = request
        .headers()
        .get("x-whisper-model")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("fast")
        .to_string();
    let m = spec(&id).ok_or("unknown model")?;
    let dir = models_dir(&app)?;
    if !installed(&dir, m) {
        return Err("The speech model isn't downloaded yet. Download it in Settings → Local Models.".into());
    }
    let bin = find_whisper_cli().ok_or("Built-in transcription isn't included in this build of BrewLM.")?;
    let tmp = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("whisper-tmp");
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let stem = tmp.join(format!("clip-{:016x}", rand::random::<u64>()));
    let wav = stem.with_extension("wav");
    std::fs::write(&wav, bytes).map_err(|e| e.to_string())?;
    let model = dir.join(m.file);

    let _turn = one_at_a_time().lock().await;
    let app2 = app.clone();
    let stem2 = stem.clone();
    let wav2 = wav.clone();
    let out = tauri::async_runtime::spawn_blocking(move || run(&app2, &bin, &model, &wav2, &stem2))
        .await
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&wav);
    let _ = std::fs::remove_file(stem.with_extension("txt"));
    out
}

fn run(app: &tauri::AppHandle, bin: &Path, model: &Path, wav: &Path, stem: &Path) -> Result<String, String> {
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
    let mut cmd = Command::new(bin);
    cmd.args(cli_args(model, wav, stem, threads))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashes up
    }
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start built-in transcription: {e}"))?;
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    *running().lock().unwrap() = Some(child.clone());

    // Progress and the tail of the log (for a readable error) from stderr.
    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let reader = stderr.map(|s| {
        let app = app.clone();
        let tail = tail.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                if let Some(p) = parse_progress(&line) {
                    let _ = app.emit("whisper-progress", p);
                }
                let mut t = tail.lock().unwrap();
                t.push(line);
                if t.len() > 12 {
                    t.remove(0);
                }
            }
        })
    });

    let status = loop {
        if let Some(st) = child.lock().unwrap().try_wait().map_err(|e| e.to_string())? {
            break st;
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    };
    *running().lock().unwrap() = None;
    if let Some(r) = reader {
        let _ = r.join();
    }
    if !status.success() {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            if status.signal().is_some() {
                return Err("cancelled".into());
            }
        }
        let log = tail.lock().unwrap().join("\n");
        return Err(format!("Built-in transcription failed: {}", log.lines().last().unwrap_or("no details")));
    }
    let text = std::fs::read_to_string(stem.with_extension("txt")).map_err(|e| format!("No transcript came back: {e}"))?;
    Ok(text.trim().to_string())
}

/// Stop the transcription that's running, if any.
#[tauri::command]
pub fn whisper_cancel() {
    if let Some(child) = running().lock().unwrap().as_ref() {
        let _ = child.lock().unwrap().kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_progress_lines() {
        assert_eq!(parse_progress("whisper_print_progress_callback: progress =  45%"), Some(45));
        assert_eq!(parse_progress("progress = 100%"), Some(100));
        assert_eq!(parse_progress("whisper_init_from_file: loading model"), None);
    }

    #[test]
    fn checks_size_and_checksum() {
        let good = ModelSpec {
            id: "t",
            file: "m.bin",
            bytes: 5,
            sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        };
        let digest = hex(&Sha256::digest(b"hello"));
        assert!(matches_pin(5, &digest, &good));
        assert!(!matches_pin(5, &hex(&Sha256::digest(b"hellp")), &good));
        assert!(!matches_pin(6, &digest, &good));
    }

    #[test]
    fn every_model_is_pinned() {
        for m in MODELS {
            assert_eq!(m.sha256.len(), 64, "{}", m.id);
            assert!(m.bytes > 100_000_000, "{}", m.id);
        }
    }
}

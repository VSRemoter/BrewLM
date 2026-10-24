//! Applying pulled BrewLM Sync changes to the local database.
//!
//! The sync engine (src/lib/sync.ts) pulls changes from the server and hands
//! them here in batches. Each batch is written in ONE transaction on its own
//! connection, with `sync_state.applying = '1'` so the change-tracking
//! triggers stay silent (a pulled change must not bounce back out).
//!
//! Conflicts are last-writer-wins per row on the HLC string
//! (`<13-digit ms>:<4-digit counter>:<device id>`, which sorts correctly as
//! text). A row's local version is its pending outbox edit if there is one,
//! else the HLC it was last synced at. Equal or older remote versions are
//! skipped. Only columns this version of the app knows are written, so a
//! newer device's extra columns can't break an older one.

use std::{collections::HashSet, path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteConnection},
    ConnectOptions, Connection, Row,
};
use tauri::Manager;

/// Synced tables and their primary key (mirrors SYNCED_TABLES in db.ts).
const SYNCED: &[(&str, &str)] = &[
    ("notebooks", "id"),
    ("folders", "id"),
    ("sources", "id"),
    ("chats", "id"),
    ("messages", "id"),
    ("artifacts", "id"),
    ("images", "id"),
    ("settings", "key"),
    ("usage_events", "id"),
];

fn pk_of(tbl: &str) -> Option<&'static str> {
    SYNCED.iter().find(|(t, _)| *t == tbl).map(|(_, pk)| *pk)
}

#[derive(Deserialize)]
pub struct RemoteChange {
    pub tbl: String,
    pub row_id: String,
    pub hlc: String,
    pub deleted: bool,
    #[serde(default)]
    pub row: Option<serde_json::Map<String, Value>>,
}

#[derive(Deserialize)]
pub struct Pushed {
    pub tbl: String,
    pub row_id: String,
    /// The outbox time that was pushed; a newer local edit keeps its entry.
    pub changed_at: i64,
    /// None = the server held a newer version (stale): just drop the entry.
    pub hlc: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ApplyResult {
    /// Indexes (into the batch) of the changes that were written.
    pub applied: Vec<usize>,
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("brewlm.db"))
}

async fn connect(path: &PathBuf) -> Result<SqliteConnection, String> {
    SqliteConnectOptions::new()
        .filename(path)
        .busy_timeout(Duration::from_secs(10))
        .connect()
        .await
        .map_err(|e| format!("open database: {e}"))
}

fn hlc_ms(hlc: &str) -> i64 {
    hlc.split(':').next().and_then(|ms| ms.parse().ok()).unwrap_or(0)
}

fn local_hlc(ms: i64, device: &str) -> String {
    format!("{ms:013}:0000:{device}")
}

#[tauri::command]
pub async fn sync_apply(
    app: tauri::AppHandle,
    device_id: String,
    changes: Vec<RemoteChange>,
) -> Result<ApplyResult, String> {
    let mut conn = connect(&db_path(&app)?).await?;
    apply(&mut conn, &device_id, &changes).await
}

/// After a push: record the HLC each row was synced at and clear its outbox
/// entry, unless the row was edited again while the push was in flight.
#[tauri::command]
pub async fn sync_mark_pushed(app: tauri::AppHandle, pushed: Vec<Pushed>) -> Result<(), String> {
    let mut conn = connect(&db_path(&app)?).await?;
    mark_pushed(&mut conn, &pushed).await
}

/// Where to sync. Release builds use the BrewLM Sync service; dev builds use
/// `BREWLM_SYNC_URL` if set (none = sync off), and `BREWLM_SYNC_TOKEN`
/// (+ `_VAULT`, `_PASSWORD`) skips accounts for the two-copy dev setup.
#[tauri::command]
pub fn sync_config() -> Option<serde_json::Value> {
    if !cfg!(debug_assertions) {
        return Some(serde_json::json!({ "url": "https://sync.brewlm.com" }));
    }
    let url = std::env::var("BREWLM_SYNC_URL").ok()?;
    let token = std::env::var("BREWLM_SYNC_TOKEN").ok();
    let vault = std::env::var("BREWLM_SYNC_VAULT").unwrap_or_else(|_| "dev".into());
    // Optional: set up or unlock the vault with this password, without the UI.
    let password = std::env::var("BREWLM_SYNC_PASSWORD").ok();
    Some(serde_json::json!({ "url": url, "token": token, "vault": vault, "password": password }))
}

/// Sync activity in the terminal that launched the app (the webview console
/// isn't visible when two dev copies run side by side).
#[tauri::command]
pub fn sync_log(line: String) {
    println!("[sync] {line}");
}

async fn columns(conn: &mut SqliteConnection, tbl: &str) -> Result<HashSet<String>, String> {
    let rows = sqlx::query(&format!("PRAGMA table_info({tbl})"))
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().map(|r| r.get::<String, _>("name")).collect())
}

fn bind_value<'q>(
    q: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    v: &'q Value,
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    match v {
        Value::Null => q.bind(None::<String>),
        Value::Bool(b) => q.bind(*b as i64),
        Value::Number(n) => match n.as_i64() {
            Some(i) => q.bind(i),
            None => q.bind(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => q.bind(s.as_str()),
        other => q.bind(other.to_string()),
    }
}

pub async fn apply(
    conn: &mut SqliteConnection,
    device_id: &str,
    changes: &[RemoteChange],
) -> Result<ApplyResult, String> {
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("INSERT INTO sync_state (key, value) VALUES ('applying', '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    let mut applied = Vec::new();
    let mut known: std::collections::HashMap<String, HashSet<String>> = Default::default();
    for (i, c) in changes.iter().enumerate() {
        let Some(pk) = pk_of(&c.tbl) else { continue };

        // Local version: a pending edit beats the last synced HLC.
        let pending: Option<i64> = sqlx::query_scalar("SELECT changed_at FROM sync_outbox WHERE tbl = ? AND row_id = ?")
            .bind(&c.tbl)
            .bind(&c.row_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        let local = match pending {
            Some(ms) => Some(local_hlc(ms, device_id)),
            None => sqlx::query("SELECT hlc, changed_at FROM sync_meta WHERE tbl = ? AND row_id = ?")
                .bind(&c.tbl)
                .bind(&c.row_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| e.to_string())?
                .map(|r| {
                    let h: String = r.get("hlc");
                    if h.is_empty() { local_hlc(r.get("changed_at"), device_id) } else { h }
                }),
        };
        if local.as_deref().is_some_and(|l| l >= c.hlc.as_str()) {
            continue;
        }

        if c.deleted {
            sqlx::query(&format!("DELETE FROM {} WHERE {pk} = ?", c.tbl))
                .bind(&c.row_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            if c.tbl == "sources" {
                sqlx::query("DELETE FROM source_chunks WHERE source_id = ?")
                    .bind(&c.row_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        } else {
            let Some(row) = &c.row else { continue };
            if !known.contains_key(&c.tbl) {
                let cols = columns(&mut tx, &c.tbl).await?;
                known.insert(c.tbl.clone(), cols);
            }
            let cols = &known[&c.tbl];
            let fields: Vec<(&String, &Value)> = row.iter().filter(|(k, _)| cols.contains(*k)).collect();
            if row.get(pk).and_then(|v| v.as_str()) != Some(c.row_id.as_str()) {
                continue; // a row must carry its own key
            }
            // Edited source text invalidates the local retrieval index (rebuilt lazily).
            if c.tbl == "sources" {
                let old: Option<(String, String)> = sqlx::query_as("SELECT content, text FROM sources WHERE id = ?")
                    .bind(&c.row_id)
                    .fetch_optional(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
                let new = (row.get("content").and_then(|v| v.as_str()), row.get("text").and_then(|v| v.as_str()));
                if old.as_ref().map(|(a, b)| (Some(a.as_str()), Some(b.as_str()))) != Some(new) {
                    sqlx::query("DELETE FROM source_chunks WHERE source_id = ?")
                        .bind(&c.row_id)
                        .execute(&mut *tx)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
            let names: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
            let updates: Vec<String> = names
                .iter()
                .filter(|n| **n != pk)
                .map(|n| format!("\"{n}\" = excluded.\"{n}\""))
                .collect();
            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({pk}) DO {}",
                c.tbl,
                names.iter().map(|n| format!("\"{n}\"")).collect::<Vec<_>>().join(", "),
                vec!["?"; names.len()].join(", "),
                if updates.is_empty() { "NOTHING".to_string() } else { format!("UPDATE SET {}", updates.join(", ")) }
            );
            let mut q = sqlx::query(&sql);
            for (_, v) in &fields {
                q = bind_value(q, v);
            }
            q.execute(&mut *tx).await.map_err(|e| format!("apply {}: {e}", c.tbl))?;
        }

        sqlx::query(
            "INSERT INTO sync_meta (tbl, row_id, changed_at, deleted, hlc) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (tbl, row_id) DO UPDATE SET changed_at = excluded.changed_at,
               deleted = excluded.deleted, hlc = excluded.hlc",
        )
        .bind(&c.tbl)
        .bind(&c.row_id)
        .bind(hlc_ms(&c.hlc))
        .bind(c.deleted as i64)
        .bind(&c.hlc)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        sqlx::query("DELETE FROM sync_outbox WHERE tbl = ? AND row_id = ?")
            .bind(&c.tbl)
            .bind(&c.row_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        applied.push(i);
    }

    sqlx::query("DELETE FROM sync_state WHERE key = 'applying'")
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(ApplyResult { applied })
}

pub async fn mark_pushed(conn: &mut SqliteConnection, pushed: &[Pushed]) -> Result<(), String> {
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    for p in pushed {
        if let Some(hlc) = &p.hlc {
            sqlx::query("UPDATE sync_meta SET hlc = ? WHERE tbl = ? AND row_id = ?")
                .bind(hlc)
                .bind(&p.tbl)
                .bind(&p.row_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
        }
        sqlx::query("DELETE FROM sync_outbox WHERE tbl = ? AND row_id = ? AND changed_at = ?")
            .bind(&p.tbl)
            .bind(&p.row_id)
            .bind(p.changed_at)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ME: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const THEM: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const NOW: &str = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

    /// The tracked-table setup db.ts creates, for one table plus sources.
    async fn db() -> (SqliteConnection, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let mut c = SqliteConnectOptions::new()
            .filename(dir.path().join("t.db"))
            .create_if_missing(true)
            .connect()
            .await
            .unwrap();
        for sql in [
            "CREATE TABLE chats (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, title TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0)".to_string(),
            "CREATE TABLE sources (id TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '')".into(),
            "CREATE TABLE source_chunks (id TEXT PRIMARY KEY, source_id TEXT NOT NULL)".into(),
            "CREATE TABLE sync_meta (tbl TEXT NOT NULL, row_id TEXT NOT NULL, changed_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL DEFAULT '', PRIMARY KEY (tbl, row_id))".into(),
            "CREATE TABLE sync_outbox (tbl TEXT NOT NULL, row_id TEXT NOT NULL, changed_at INTEGER NOT NULL, PRIMARY KEY (tbl, row_id))".into(),
            "CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)".into(),
            format!(
                "CREATE TRIGGER t_chats AFTER UPDATE ON chats WHEN NOT EXISTS (SELECT 1 FROM sync_state WHERE key = 'applying' AND value = '1')
                 BEGIN INSERT INTO sync_outbox (tbl, row_id, changed_at) VALUES ('chats', NEW.id, {NOW})
                 ON CONFLICT (tbl, row_id) DO UPDATE SET changed_at = excluded.changed_at; END"
            ),
        ] {
            sqlx::query(&sql).execute(&mut c).await.unwrap();
        }
        sqlx::query("INSERT INTO chats VALUES ('c1', 'n1', 'Local title', 0)").execute(&mut c).await.unwrap();
        (c, dir)
    }

    fn change(row_id: &str, hlc_ms: i64, row: Option<Value>) -> RemoteChange {
        RemoteChange {
            tbl: "chats".into(),
            row_id: row_id.into(),
            hlc: format!("{hlc_ms:013}:0000:{THEM}"),
            deleted: row.is_none(),
            row: row.map(|r| r.as_object().unwrap().clone()),
        }
    }

    async fn title(c: &mut SqliteConnection, id: &str) -> Option<String> {
        sqlx::query_scalar("SELECT title FROM chats WHERE id = ?").bind(id).fetch_optional(c).await.unwrap()
    }

    #[tokio::test]
    async fn newer_remote_wins_and_stays_silent() {
        let (mut c, _d) = db().await;
        sqlx::query("INSERT INTO sync_meta VALUES ('chats', 'c1', 1000, 0, ?)")
            .bind(format!("{:013}:0000:{ME}", 1000))
            .execute(&mut c)
            .await
            .unwrap();
        let r = apply(&mut c, ME, &[change("c1", 2000, Some(json!({"id": "c1", "notebook_id": "n1", "title": "Remote", "pinned": 1, "unknown_col": 5})))]).await.unwrap();
        assert_eq!(r.applied, vec![0]);
        assert_eq!(title(&mut c, "c1").await.as_deref(), Some("Remote"));
        // The trigger didn't fire: nothing to bounce back out.
        let outbox: i64 = sqlx::query_scalar("SELECT count(*) FROM sync_outbox").fetch_one(&mut c).await.unwrap();
        assert_eq!(outbox, 0);
        let hlc: String = sqlx::query_scalar("SELECT hlc FROM sync_meta WHERE row_id = 'c1'").fetch_one(&mut c).await.unwrap();
        assert!(hlc.starts_with("0000000002000"));
        // And the flag is gone: later local edits are tracked again.
        sqlx::query("UPDATE chats SET title = 'Edited' WHERE id = 'c1'").execute(&mut c).await.unwrap();
        let outbox: i64 = sqlx::query_scalar("SELECT count(*) FROM sync_outbox").fetch_one(&mut c).await.unwrap();
        assert_eq!(outbox, 1);
    }

    #[tokio::test]
    async fn pending_local_edit_beats_older_remote() {
        let (mut c, _d) = db().await;
        sqlx::query("INSERT INTO sync_outbox VALUES ('chats', 'c1', 5000)").execute(&mut c).await.unwrap();
        let r = apply(&mut c, ME, &[change("c1", 4000, Some(json!({"id": "c1", "notebook_id": "n1", "title": "Older remote"})))]).await.unwrap();
        assert!(r.applied.is_empty());
        assert_eq!(title(&mut c, "c1").await.as_deref(), Some("Local title"));
        // ...but a newer remote beats it, and the losing local edit is dropped.
        apply(&mut c, ME, &[change("c1", 6000, Some(json!({"id": "c1", "notebook_id": "n1", "title": "Newer remote"})))]).await.unwrap();
        assert_eq!(title(&mut c, "c1").await.as_deref(), Some("Newer remote"));
        let outbox: i64 = sqlx::query_scalar("SELECT count(*) FROM sync_outbox").fetch_one(&mut c).await.unwrap();
        assert_eq!(outbox, 0);
    }

    #[tokio::test]
    async fn deletes_inserts_and_partial_rows() {
        let (mut c, _d) = db().await;
        apply(&mut c, ME, &[change("c1", 9000, None), change("c2", 9000, Some(json!({"id": "c2", "notebook_id": "n1", "title": "New"})))]).await.unwrap();
        assert_eq!(title(&mut c, "c1").await, None);
        assert_eq!(title(&mut c, "c2").await.as_deref(), Some("New"));
        let deleted: i64 = sqlx::query_scalar("SELECT deleted FROM sync_meta WHERE row_id = 'c1'").fetch_one(&mut c).await.unwrap();
        assert_eq!(deleted, 1);
        // A row whose key doesn't match is ignored; unknown tables too.
        let mut bad = change("c3", 9000, Some(json!({"id": "other", "notebook_id": "n", "title": "x"})));
        let r = apply(&mut c, ME, std::slice::from_ref(&bad)).await.unwrap();
        assert!(r.applied.is_empty());
        bad.tbl = "devices".into();
        assert!(apply(&mut c, ME, &[bad]).await.unwrap().applied.is_empty());
    }

    #[tokio::test]
    async fn changed_source_text_drops_its_index() {
        let (mut c, _d) = db().await;
        sqlx::query("INSERT INTO sources VALUES ('s1', 'old', '')").execute(&mut c).await.unwrap();
        sqlx::query("INSERT INTO source_chunks VALUES ('k1', 's1')").execute(&mut c).await.unwrap();
        let src = |content: &str, ms: i64| RemoteChange {
            tbl: "sources".into(),
            row_id: "s1".into(),
            hlc: format!("{ms:013}:0000:{THEM}"),
            deleted: false,
            row: Some(json!({"id": "s1", "content": content, "text": ""}).as_object().unwrap().clone()),
        };
        apply(&mut c, ME, &[src("old", 100)]).await.unwrap();
        let chunks: i64 = sqlx::query_scalar("SELECT count(*) FROM source_chunks").fetch_one(&mut c).await.unwrap();
        assert_eq!(chunks, 1, "same text keeps the index");
        apply(&mut c, ME, &[src("new", 200)]).await.unwrap();
        let chunks: i64 = sqlx::query_scalar("SELECT count(*) FROM source_chunks").fetch_one(&mut c).await.unwrap();
        assert_eq!(chunks, 0);
    }

    #[tokio::test]
    async fn mark_pushed_keeps_edits_made_during_the_push() {
        let (mut c, _d) = db().await;
        sqlx::query("INSERT INTO sync_meta VALUES ('chats', 'c1', 100, 0, '')").execute(&mut c).await.unwrap();
        sqlx::query("INSERT INTO sync_outbox VALUES ('chats', 'c1', 100), ('chats', 'c2', 300)").execute(&mut c).await.unwrap();
        let hlc = format!("{:013}:0000:{ME}", 100);
        mark_pushed(&mut c, &[
            Pushed { tbl: "chats".into(), row_id: "c1".into(), changed_at: 100, hlc: Some(hlc.clone()) },
            // c2 was edited again (300) after we read it at 200: keep its entry.
            Pushed { tbl: "chats".into(), row_id: "c2".into(), changed_at: 200, hlc: None },
        ]).await.unwrap();
        let left: Vec<String> = sqlx::query_scalar("SELECT row_id FROM sync_outbox").fetch_all(&mut c).await.unwrap();
        assert_eq!(left, vec!["c2"]);
        let saved: String = sqlx::query_scalar("SELECT hlc FROM sync_meta WHERE row_id = 'c1'").fetch_one(&mut c).await.unwrap();
        assert_eq!(saved, hlc);
    }
}

//! The [`Store`] itself.

use crate::models::*;
use crate::schema::MIGRATIONS;
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// Errors of the store.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("errore del database locale: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("dati del database locale non validi: {0}")]
    Json(#[from] serde_json::Error),
    #[error("il database locale è più recente di questa versione dell'app (schema {found}, supportato {supported})")]
    SchemaTooNew { found: i64, supported: i64 },
    #[error("errore di I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("il database locale è stato interrotto da un altro thread (lock avvelenato)")]
    Poisoned,
}

/// Current time in unix milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Handle to the local database. Cloning shares the same connection.
#[derive(Debug, Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

type Result<T> = std::result::Result<T, StoreError>;

impl Store {
    /// Opens (creating it if needed) the database at `path` and applies the migrations.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        Self::init(conn)
    }

    /// In-memory database (tests, tools).
    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let s = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        s.migrate()?;
        Ok(s)
    }

    fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let mut g = self.conn.lock().map_err(|_| StoreError::Poisoned)?;
        f(&mut g)
    }

    fn migrate(&self) -> Result<()> {
        self.with(|c| {
            let current: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
            let supported = MIGRATIONS.len() as i64;
            if current > supported {
                return Err(StoreError::SchemaTooNew {
                    found: current,
                    supported,
                });
            }
            for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
                let tx = c.transaction()?;
                tx.execute_batch(sql)?;
                tx.pragma_update(None, "user_version", (i + 1) as i64)?;
                tx.commit()?;
            }
            Ok(())
        })
    }

    /// Schema version currently applied.
    pub fn schema_version(&self) -> Result<i64> {
        self.with(|c| Ok(c.pragma_query_value(None, "user_version", |r| r.get(0))?))
    }

    // ---- projects -----------------------------------------------------------------------

    /// Inserts or replaces a linked project.
    pub fn upsert_project(&self, p: &ProjectRecord) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO projects (project_id, repo_full_name, remote_url, folder, linked_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(project_id) DO UPDATE SET repo_full_name = excluded.repo_full_name,
                   remote_url = excluded.remote_url, folder = excluded.folder, linked_at = excluded.linked_at",
                params![p.project_id, p.repo_full_name, p.remote_url, p.folder, p.linked_at],
            )?;
            Ok(())
        })
    }

    fn row_project(r: &Row<'_>) -> rusqlite::Result<ProjectRecord> {
        Ok(ProjectRecord {
            project_id: r.get(0)?,
            repo_full_name: r.get(1)?,
            remote_url: r.get(2)?,
            folder: r.get(3)?,
            linked_at: r.get(4)?,
        })
    }

    /// A project by id.
    pub fn get_project(&self, project_id: &str) -> Result<Option<ProjectRecord>> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT project_id, repo_full_name, remote_url, folder, linked_at FROM projects WHERE project_id = ?1",
                params![project_id],
                Self::row_project,
            )
            .optional()?)
        })
    }

    /// All linked projects, oldest first.
    pub fn list_projects(&self) -> Result<Vec<ProjectRecord>> {
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT project_id, repo_full_name, remote_url, folder, linked_at FROM projects ORDER BY linked_at, project_id",
            )?;
            let rows = st.query_map([], Self::row_project)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// Removes a project and all its per-project data (journal, conflicts, watches, file states, settings).
    pub fn delete_project(&self, project_id: &str) -> Result<()> {
        self.with(|c| {
            let tx = c.transaction()?;
            for t in ["journal", "conflicts", "guard_watches", "file_states"] {
                tx.execute(
                    &format!("DELETE FROM {t} WHERE project_id = ?1"),
                    params![project_id],
                )?;
            }
            tx.execute("DELETE FROM settings WHERE scope = ?1", params![project_id])?;
            tx.execute(
                "DELETE FROM projects WHERE project_id = ?1",
                params![project_id],
            )?;
            tx.commit()?;
            Ok(())
        })
    }

    // ---- settings -----------------------------------------------------------------------

    /// Raw setting value. `scope` is `"app"` or a project id.
    pub fn get_setting(&self, scope: &str, key: &str) -> Result<Option<String>> {
        self.with(|c| {
            Ok(c.query_row(
                "SELECT value FROM settings WHERE scope = ?1 AND key = ?2",
                params![scope, key],
                |r| r.get(0),
            )
            .optional()?)
        })
    }

    /// Writes a raw setting value.
    pub fn set_setting(&self, scope: &str, key: &str, value: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO settings (scope, key, value) VALUES (?1, ?2, ?3)
                 ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
                params![scope, key, value],
            )?;
            Ok(())
        })
    }

    /// Deletes a setting.
    pub fn delete_setting(&self, scope: &str, key: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "DELETE FROM settings WHERE scope = ?1 AND key = ?2",
                params![scope, key],
            )?;
            Ok(())
        })
    }

    /// JSON setting.
    pub fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        scope: &str,
        key: &str,
    ) -> Result<Option<T>> {
        match self.get_setting(scope, key)? {
            Some(s) => Ok(Some(serde_json::from_str(&s)?)),
            None => Ok(None),
        }
    }

    /// Writes a JSON setting.
    pub fn set_json<T: serde::Serialize>(&self, scope: &str, key: &str, value: &T) -> Result<()> {
        self.set_setting(scope, key, &serde_json::to_string(value)?)
    }

    /// Publication policy of a project (default: assisted, 10 minutes).
    pub fn get_publish_policy(&self, project_id: &str) -> Result<PublishPolicy> {
        Ok(self
            .get_json::<PublishPolicy>(project_id, "publishPolicy")?
            .unwrap_or_default())
    }

    /// Stores the publication policy of a project.
    pub fn set_publish_policy(&self, project_id: &str, policy: &PublishPolicy) -> Result<()> {
        self.set_json(project_id, "publishPolicy", policy)
    }

    // ---- journal ------------------------------------------------------------------------

    /// Starts an operation and returns its id.
    pub fn journal_begin(
        &self,
        op_id: &str,
        project_id: &str,
        kind: &str,
        step: &str,
        payload: &serde_json::Value,
    ) -> Result<()> {
        let now = now_ms();
        self.with(|c| {
            c.execute(
                "INSERT INTO journal (op_id, project_id, kind, step, payload, started_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![op_id, project_id, kind, step, serde_json::to_string(payload)?, now],
            )?;
            Ok(())
        })
    }

    /// Records the step reached, optionally replacing the payload.
    pub fn journal_step(
        &self,
        op_id: &str,
        step: &str,
        payload: Option<&serde_json::Value>,
    ) -> Result<()> {
        let now = now_ms();
        self.with(|c| {
            match payload {
                Some(p) => c.execute(
                    "UPDATE journal SET step = ?2, payload = ?3, updated_at = ?4 WHERE op_id = ?1",
                    params![op_id, step, serde_json::to_string(p)?, now],
                )?,
                None => c.execute(
                    "UPDATE journal SET step = ?2, updated_at = ?3 WHERE op_id = ?1",
                    params![op_id, step, now],
                )?,
            };
            Ok(())
        })
    }

    /// Closes an operation with an outcome (`ok`, `failed`, `recovered`, ...).
    pub fn journal_finish(&self, op_id: &str, outcome: &str, note: Option<&str>) -> Result<()> {
        let now = now_ms();
        self.with(|c| {
            c.execute(
                "UPDATE journal SET outcome = ?2, note = ?3, finished_at = ?4, updated_at = ?4 WHERE op_id = ?1",
                params![op_id, outcome, note, now],
            )?;
            Ok(())
        })
    }

    fn row_journal(r: &Row<'_>) -> rusqlite::Result<JournalEntry> {
        let payload: String = r.get(4)?;
        Ok(JournalEntry {
            op_id: r.get(0)?,
            project_id: r.get(1)?,
            kind: r.get(2)?,
            step: r.get(3)?,
            payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
            started_at: r.get(5)?,
            updated_at: r.get(6)?,
            finished_at: r.get(7)?,
            outcome: r.get(8)?,
            note: r.get(9)?,
        })
    }

    const JOURNAL_COLS: &'static str =
        "op_id, project_id, kind, step, payload, started_at, updated_at, finished_at, outcome, note";

    /// Operations of a project that were never closed (crash), oldest first.
    pub fn journal_unfinished(&self, project_id: &str) -> Result<Vec<JournalEntry>> {
        self.with(|c| {
            let mut st = c.prepare(&format!(
                "SELECT {} FROM journal WHERE project_id = ?1 AND finished_at IS NULL ORDER BY started_at, rowid",
                Self::JOURNAL_COLS
            ))?;
            let rows = st.query_map(params![project_id], Self::row_journal)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// Most recent operations of a project, newest first.
    pub fn journal_recent(&self, project_id: &str, limit: u32) -> Result<Vec<JournalEntry>> {
        self.with(|c| {
            let mut st = c.prepare(&format!(
                "SELECT {} FROM journal WHERE project_id = ?1 ORDER BY started_at DESC, rowid DESC LIMIT ?2",
                Self::JOURNAL_COLS
            ))?;
            let rows = st.query_map(params![project_id, limit], Self::row_journal)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// One journal entry.
    pub fn journal_get(&self, op_id: &str) -> Result<Option<JournalEntry>> {
        self.with(|c| {
            Ok(c.query_row(
                &format!(
                    "SELECT {} FROM journal WHERE op_id = ?1",
                    Self::JOURNAL_COLS
                ),
                params![op_id],
                Self::row_journal,
            )
            .optional()?)
        })
    }

    /// Deletes finished journal entries older than `before_ms` (keeps the table small).
    pub fn journal_prune(&self, before_ms: i64) -> Result<usize> {
        self.with(|c| {
            Ok(c.execute(
                "DELETE FROM journal WHERE finished_at IS NOT NULL AND finished_at < ?1",
                params![before_ms],
            )?)
        })
    }

    // ---- conflicts ----------------------------------------------------------------------

    const CONFLICT_COLS: &'static str = "id, project_id, status, created_at, base_sha, ours_sha, theirs_sha, theirs_version, theirs_author, remote_branch_pushed, origin, files, resolution, resolution_sha, resolved_at, resolved_version";

    fn row_conflict(r: &Row<'_>) -> rusqlite::Result<ConflictRecord> {
        let files: String = r.get(11)?;
        let resolution: Option<String> = r.get(12)?;
        let status: String = r.get(2)?;
        Ok(ConflictRecord {
            id: r.get(0)?,
            project_id: r.get(1)?,
            status: ConflictStatus::parse(&status),
            created_at: r.get(3)?,
            base_sha: r.get(4)?,
            ours_sha: r.get(5)?,
            theirs_sha: r.get(6)?,
            theirs_version: r.get(7)?,
            theirs_author: r.get(8)?,
            remote_branch_pushed: r.get::<_, i64>(9)? != 0,
            origin: r.get(10)?,
            files: serde_json::from_str(&files).unwrap_or_default(),
            resolution: resolution.and_then(|s| serde_json::from_str(&s).ok()),
            resolution_sha: r.get(13)?,
            resolved_at: r.get(14)?,
            resolved_version: r.get(15)?,
        })
    }

    /// Inserts or replaces a conflict.
    pub fn save_conflict(&self, c: &ConflictRecord) -> Result<()> {
        self.with(|conn| {
            conn.execute(
                "INSERT OR REPLACE INTO conflicts (id, project_id, status, created_at, base_sha, ours_sha, theirs_sha,
                    theirs_version, theirs_author, remote_branch_pushed, origin, files, resolution, resolution_sha,
                    resolved_at, resolved_version)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
                params![
                    c.id,
                    c.project_id,
                    c.status.as_str(),
                    c.created_at,
                    c.base_sha,
                    c.ours_sha,
                    c.theirs_sha,
                    c.theirs_version,
                    c.theirs_author,
                    c.remote_branch_pushed as i64,
                    c.origin,
                    serde_json::to_string(&c.files)?,
                    c.resolution.as_ref().map(|v| v.to_string()),
                    c.resolution_sha,
                    c.resolved_at,
                    c.resolved_version
                ],
            )?;
            Ok(())
        })
    }

    /// One conflict.
    pub fn get_conflict(&self, project_id: &str, id: &str) -> Result<Option<ConflictRecord>> {
        self.with(|c| {
            Ok(c.query_row(
                &format!(
                    "SELECT {} FROM conflicts WHERE project_id = ?1 AND id = ?2",
                    Self::CONFLICT_COLS
                ),
                params![project_id, id],
                Self::row_conflict,
            )
            .optional()?)
        })
    }

    /// Conflicts of a project, newest first.
    pub fn list_conflicts(
        &self,
        project_id: &str,
        include_resolved: bool,
    ) -> Result<Vec<ConflictRecord>> {
        self.with(|c| {
            let sql =
                format!(
                "SELECT {} FROM conflicts WHERE project_id = ?1 {} ORDER BY created_at DESC, id",
                Self::CONFLICT_COLS,
                if include_resolved { "" } else { "AND status != 'resolved'" }
            );
            let mut st = c.prepare(&sql)?;
            let rows = st.query_map(params![project_id], Self::row_conflict)?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    // ---- guard watches ------------------------------------------------------------------

    /// Inserts or replaces the surveillance of a file.
    pub fn save_watch(&self, w: &GuardWatch) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT OR REPLACE INTO guard_watches (project_id, path, old_blob, new_blob, old_commit, new_commit,
                    version, written_at, suspected) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    w.project_id,
                    w.path,
                    w.old_blob,
                    w.new_blob,
                    w.old_commit,
                    w.new_commit,
                    w.version,
                    w.written_at,
                    w.suspected as i64
                ],
            )?;
            Ok(())
        })
    }

    /// Active surveillances of a project.
    pub fn list_watches(&self, project_id: &str) -> Result<Vec<GuardWatch>> {
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT project_id, path, old_blob, new_blob, old_commit, new_commit, version, written_at, suspected
                 FROM guard_watches WHERE project_id = ?1 ORDER BY path",
            )?;
            let rows = st.query_map(params![project_id], |r| {
                Ok(GuardWatch {
                    project_id: r.get(0)?,
                    path: r.get(1)?,
                    old_blob: r.get(2)?,
                    new_blob: r.get(3)?,
                    old_commit: r.get(4)?,
                    new_commit: r.get(5)?,
                    version: r.get(6)?,
                    written_at: r.get(7)?,
                    suspected: r.get::<_, i64>(8)? != 0,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// Removes the surveillance of a file.
    pub fn delete_watch(&self, project_id: &str, path: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "DELETE FROM guard_watches WHERE project_id = ?1 AND path = ?2",
                params![project_id, path],
            )?;
            Ok(())
        })
    }

    // ---- file states --------------------------------------------------------------------

    /// Inserts or replaces the state of a file.
    pub fn save_file_state(&self, s: &FileStateRecord) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT OR REPLACE INTO file_states (project_id, path, size, mtime_ms, stable, valid, invalid_reason,
                    first_invalid_at, checked_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    s.project_id,
                    s.path,
                    s.size,
                    s.mtime_ms,
                    s.stable as i64,
                    s.valid.map(|v| v as i64),
                    s.invalid_reason,
                    s.first_invalid_at,
                    s.checked_at
                ],
            )?;
            Ok(())
        })
    }

    /// Known file states of a project.
    pub fn list_file_states(&self, project_id: &str) -> Result<Vec<FileStateRecord>> {
        self.with(|c| {
            let mut st = c.prepare(
                "SELECT project_id, path, size, mtime_ms, stable, valid, invalid_reason, first_invalid_at, checked_at
                 FROM file_states WHERE project_id = ?1 ORDER BY path",
            )?;
            let rows = st.query_map(params![project_id], |r| {
                Ok(FileStateRecord {
                    project_id: r.get(0)?,
                    path: r.get(1)?,
                    size: r.get(2)?,
                    mtime_ms: r.get(3)?,
                    stable: r.get::<_, i64>(4)? != 0,
                    valid: r.get::<_, Option<i64>>(5)?.map(|v| v != 0),
                    invalid_reason: r.get(6)?,
                    first_invalid_at: r.get(7)?,
                    checked_at: r.get(8)?,
                })
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
    }

    /// Removes the states of files that are no longer in `keep` (call with the current changed paths).
    pub fn retain_file_states(&self, project_id: &str, keep: &[String]) -> Result<()> {
        self.with(|c| {
            let tx = c.transaction()?;
            let existing: Vec<String> = {
                let mut st = tx.prepare("SELECT path FROM file_states WHERE project_id = ?1")?;
                let rows = st.query_map(params![project_id], |r| r.get(0))?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for p in existing {
                if !keep.contains(&p) {
                    tx.execute(
                        "DELETE FROM file_states WHERE project_id = ?1 AND path = ?2",
                        params![project_id, p],
                    )?;
                }
            }
            tx.commit()?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn project(id: &str) -> ProjectRecord {
        ProjectRecord {
            project_id: id.into(),
            repo_full_name: "o/r".into(),
            remote_url: "file:///tmp/r.git".into(),
            folder: "/tmp/p".into(),
            linked_at: 1,
        }
    }

    #[test]
    fn migrates_and_reopens_from_disk() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("sub/rocketsync.db");
        {
            let s = Store::open(&path).unwrap();
            assert_eq!(s.schema_version().unwrap(), MIGRATIONS.len() as i64);
            s.upsert_project(&project("p1")).unwrap();
        }
        let s = Store::open(&path).unwrap();
        assert_eq!(s.list_projects().unwrap().len(), 1);
        assert_eq!(s.get_project("p1").unwrap().unwrap().folder, "/tmp/p");
    }

    #[test]
    fn refuses_newer_schema() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("db.sqlite");
        {
            let c = Connection::open(&path).unwrap();
            c.pragma_update(None, "user_version", 999i64).unwrap();
        }
        match Store::open(&path) {
            Err(StoreError::SchemaTooNew { found: 999, .. }) => {}
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn publish_policy_roundtrip_and_contract_shape() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(
            s.get_publish_policy("p").unwrap(),
            PublishPolicy::Assisted { idle_minutes: 10 }
        );
        let pol = PublishPolicy::OnSave {
            min_interval_minutes: 5,
        };
        s.set_publish_policy("p", &pol).unwrap();
        assert_eq!(s.get_publish_policy("p").unwrap(), pol);
        assert_eq!(
            serde_json::to_value(&pol).unwrap(),
            json!({"mode": "onSave", "minIntervalMinutes": 5})
        );
        assert_eq!(
            serde_json::to_value(PublishPolicy::default()).unwrap(),
            json!({"mode": "assisted", "idleMinutes": 10})
        );
        assert_eq!(
            serde_json::to_value(PublishPolicy::Manual).unwrap(),
            json!({"mode": "manual"})
        );
    }

    #[test]
    fn journal_lifecycle() {
        let s = Store::open_in_memory().unwrap();
        s.journal_begin("op1", "p", "publish", "start", &json!({"a": 1}))
            .unwrap();
        s.journal_begin("op2", "p", "update", "start", &json!({}))
            .unwrap();
        s.journal_step("op1", "pushed", Some(&json!({"a": 2})))
            .unwrap();
        s.journal_finish("op2", "ok", None).unwrap();
        let open = s.journal_unfinished("p").unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].op_id, "op1");
        assert_eq!(open[0].step, "pushed");
        assert_eq!(open[0].payload["a"], 2);
        s.journal_finish("op1", "recovered", Some("completato"))
            .unwrap();
        assert!(s.journal_unfinished("p").unwrap().is_empty());
        let e = s.journal_get("op1").unwrap().unwrap();
        assert_eq!(e.outcome.as_deref(), Some("recovered"));
        assert_eq!(e.note.as_deref(), Some("completato"));
        assert_eq!(s.journal_recent("p", 10).unwrap().len(), 2);
    }

    #[test]
    fn conflicts_watches_and_file_states() {
        let s = Store::open_in_memory().unwrap();
        let mut c = ConflictRecord {
            id: "20260101-abc123".into(),
            project_id: "p".into(),
            status: ConflictStatus::Open,
            created_at: 5,
            base_sha: "b".into(),
            ours_sha: "o".into(),
            theirs_sha: "t".into(),
            theirs_version: Some(3),
            theirs_author: Some("Luca".into()),
            remote_branch_pushed: false,
            origin: "sync".into(),
            files: vec![ConflictFileRecord {
                path: "a.ork".into(),
                kind: "bothModified".into(),
            }],
            resolution: None,
            resolution_sha: None,
            resolved_at: None,
            resolved_version: None,
        };
        s.save_conflict(&c).unwrap();
        assert_eq!(s.list_conflicts("p", false).unwrap().len(), 1);
        c.status = ConflictStatus::Resolved;
        c.remote_branch_pushed = true;
        c.resolution = Some(json!([{"path": "a.ork", "choice": "mine"}]));
        s.save_conflict(&c).unwrap();
        assert!(s.list_conflicts("p", false).unwrap().is_empty());
        let got = s.get_conflict("p", &c.id).unwrap().unwrap();
        assert_eq!(got, c);

        let w = GuardWatch {
            project_id: "p".into(),
            path: "a.ork".into(),
            old_blob: Some("o".into()),
            new_blob: Some("n".into()),
            old_commit: "c1".into(),
            new_commit: "c2".into(),
            version: Some(4),
            written_at: 9,
            suspected: false,
        };
        s.save_watch(&w).unwrap();
        assert_eq!(s.list_watches("p").unwrap(), vec![w.clone()]);
        s.delete_watch("p", "a.ork").unwrap();
        assert!(s.list_watches("p").unwrap().is_empty());

        let f = FileStateRecord {
            project_id: "p".into(),
            path: "a.ork".into(),
            size: 10,
            mtime_ms: 20,
            stable: true,
            valid: Some(false),
            invalid_reason: Some("troncato".into()),
            first_invalid_at: Some(30),
            checked_at: 40,
        };
        s.save_file_state(&f).unwrap();
        assert_eq!(s.list_file_states("p").unwrap(), vec![f]);
        s.retain_file_states("p", &[]).unwrap();
        assert!(s.list_file_states("p").unwrap().is_empty());
    }

    #[test]
    fn projects_are_isolated_and_deleted_completely() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_project(&project("a")).unwrap();
        s.upsert_project(&project("b")).unwrap();
        s.set_publish_policy("a", &PublishPolicy::Manual).unwrap();
        s.journal_begin("o1", "a", "x", "s", &json!({})).unwrap();
        s.journal_begin("o2", "b", "x", "s", &json!({})).unwrap();
        s.delete_project("a").unwrap();
        assert!(s.get_project("a").unwrap().is_none());
        assert!(s.journal_unfinished("a").unwrap().is_empty());
        assert_eq!(s.journal_unfinished("b").unwrap().len(), 1);
        assert_eq!(s.get_publish_policy("a").unwrap(), PublishPolicy::default());
        assert_eq!(s.list_projects().unwrap().len(), 1);
    }
}

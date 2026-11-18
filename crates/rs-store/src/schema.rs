//! Schema migrations. Each entry is applied once, in order; the index+1 is the `user_version`.

pub(crate) const MIGRATIONS: &[&str] = &[
    // 1: initial schema
    r#"
    CREATE TABLE projects (
        project_id     TEXT PRIMARY KEY,
        repo_full_name TEXT NOT NULL,
        remote_url     TEXT NOT NULL,
        folder         TEXT NOT NULL,
        linked_at      INTEGER NOT NULL
    );

    CREATE TABLE settings (
        scope TEXT NOT NULL,
        key   TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (scope, key)
    );

    CREATE TABLE journal (
        op_id       TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        kind        TEXT NOT NULL,
        step        TEXT NOT NULL,
        payload     TEXT NOT NULL DEFAULT '{}',
        started_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        finished_at INTEGER,
        outcome     TEXT,
        note        TEXT
    );
    CREATE INDEX journal_project ON journal (project_id, finished_at);

    CREATE TABLE conflicts (
        id                   TEXT NOT NULL,
        project_id           TEXT NOT NULL,
        status               TEXT NOT NULL,
        created_at           INTEGER NOT NULL,
        base_sha             TEXT NOT NULL,
        ours_sha             TEXT NOT NULL,
        theirs_sha           TEXT NOT NULL,
        theirs_version       INTEGER,
        theirs_author        TEXT,
        remote_branch_pushed INTEGER NOT NULL DEFAULT 0,
        origin               TEXT NOT NULL DEFAULT 'sync',
        files                TEXT NOT NULL,
        resolution           TEXT,
        resolution_sha       TEXT,
        resolved_at          INTEGER,
        resolved_version     INTEGER,
        PRIMARY KEY (project_id, id)
    );

    CREATE TABLE guard_watches (
        project_id TEXT NOT NULL,
        path       TEXT NOT NULL,
        old_blob   TEXT,
        new_blob   TEXT,
        old_commit TEXT NOT NULL,
        new_commit TEXT NOT NULL,
        version    INTEGER,
        written_at INTEGER NOT NULL,
        suspected  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_id, path)
    );

    CREATE TABLE file_states (
        project_id       TEXT NOT NULL,
        path             TEXT NOT NULL,
        size             INTEGER NOT NULL,
        mtime_ms         INTEGER NOT NULL,
        stable           INTEGER NOT NULL,
        valid            INTEGER,
        invalid_reason   TEXT,
        first_invalid_at INTEGER,
        checked_at       INTEGER NOT NULL,
        PRIMARY KEY (project_id, path)
    );
    "#,
];

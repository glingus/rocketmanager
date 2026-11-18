//! Typed helpers on top of [`Git`] for one repository.

use crate::error::GitError;
use crate::exec::{Cmd, Git, Output};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The well-known id of the empty tree (valid in every repository).
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Author or committer of a commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signature {
    pub name: String,
    pub email: String,
    /// Strict ISO 8601 date (`%aI`); `None` means "now" when used to create a commit.
    pub when_iso: Option<String>,
    /// Unix seconds (`%at`), `0` when unknown.
    pub when_unix: i64,
}

impl Signature {
    /// Signature that will be stamped with the current time.
    pub fn now(name: impl Into<String>, email: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            email: email.into(),
            when_iso: None,
            when_unix: 0,
        }
    }
}

/// A commit as read from `git log`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitInfo {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: Signature,
    pub committer: Signature,
    /// Raw message (`%B`).
    pub message: String,
}

/// Parameters of [`Repo::commit_tree`].
#[derive(Debug, Clone)]
pub struct CommitSpec<'a> {
    pub tree: &'a str,
    pub parents: &'a [String],
    pub message: &'a str,
    pub author: &'a Signature,
    pub committer: &'a Signature,
}

/// An entry of a tree (always a leaf: directories are flattened with `-r`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeEntry {
    pub mode: String,
    pub oid: String,
    pub size: Option<u64>,
    pub path: String,
}

/// One line of `git diff-tree --raw`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffEntry {
    /// `A`, `M`, `D`, `R`, `C` or `T`.
    pub status: char,
    pub old_mode: String,
    pub new_mode: String,
    pub old_oid: String,
    pub new_oid: String,
    /// Destination path (the only path for A/M/D).
    pub path: String,
    /// Source path for renames and copies.
    pub old_path: Option<String>,
}

impl DiffEntry {
    pub fn is_zero_oid(oid: &str) -> bool {
        oid.chars().all(|c| c == '0')
    }
}

/// Kind of an entry of `git status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusKind {
    Tracked,
    Untracked,
    Unmerged,
}

/// One entry of `git status --porcelain=v2`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    pub path: String,
    pub kind: StatusKind,
    /// Index state (`.` = unchanged).
    pub x: char,
    /// Working tree state (`.` = unchanged).
    pub y: char,
    pub head_oid: Option<String>,
    pub index_oid: Option<String>,
    pub orig_path: Option<String>,
}

/// Result of `git merge-tree --write-tree`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeTreeResult {
    /// Tree with the merge result (conflicting paths hold conflict markers or one side).
    pub tree: String,
    pub clean: bool,
    /// Paths with conflicts (deduplicated, sorted).
    pub conflicted: Vec<String>,
    /// Informational messages printed by git.
    pub messages: String,
}

/// A reference with the object it points to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefInfo {
    pub name: String,
    pub sha: String,
    /// Creation/commit date in unix seconds.
    pub date_unix: i64,
}

/// One entry written with `update-index --index-info`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexInfoEntry {
    pub path: String,
    /// `None` removes the path from the index.
    pub mode_oid: Option<(String, String)>,
}

/// Handle to a repository working directory.
#[derive(Debug, Clone)]
pub struct Repo {
    git: Git,
    workdir: PathBuf,
}

fn utf8(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

impl Git {
    /// Handle to the repository whose working directory is `workdir` (no check is made).
    pub fn repo(&self, workdir: impl Into<PathBuf>) -> Repo {
        Repo {
            git: self.clone(),
            workdir: workdir.into(),
        }
    }

    /// Opens `workdir` and verifies that it is a git repository.
    pub fn open(&self, workdir: impl Into<PathBuf>) -> Result<Repo, GitError> {
        let r = self.repo(workdir);
        r.run(Cmd::new(["rev-parse", "--git-dir"]).no_retry())?;
        Ok(r)
    }

    /// Runs a command outside of any repository.
    pub fn run_in(&self, cwd: &Path, cmd: Cmd) -> Result<Output, GitError> {
        self.run(Some(cwd), cmd)
    }

    /// Clones `url` into `dest` (which must not exist or be empty), checking out `branch`.
    pub fn clone_repo(&self, url: &str, dest: &Path, branch: &str) -> Result<Repo, GitError> {
        let parent = dest.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent).map_err(GitError::io)?;
        let cmd = Cmd::new(["clone", "--quiet", "--branch", branch, "--", url])
            .arg(dest)
            .network();
        self.run(Some(parent), cmd)?;
        Ok(self.repo(dest))
    }

    /// `git init` (used by tests and by tooling that prepares remotes).
    pub fn init(&self, dir: &Path, bare: bool, initial_branch: &str) -> Result<Repo, GitError> {
        std::fs::create_dir_all(dir).map_err(GitError::io)?;
        let mut args = vec!["init", "--quiet", "--initial-branch", initial_branch];
        if bare {
            args.push("--bare");
        }
        self.run(Some(dir), Cmd::new(args))?;
        Ok(self.repo(dir))
    }
}

impl Repo {
    /// Working directory of the repository.
    pub fn workdir(&self) -> &Path {
        &self.workdir
    }

    /// The underlying [`Git`] handle.
    pub fn git(&self) -> &Git {
        &self.git
    }

    /// Path of the `.git` directory (assumes a standard layout).
    pub fn git_dir(&self) -> PathBuf {
        self.workdir.join(".git")
    }

    /// Runs a command in the working directory.
    pub fn run(&self, cmd: Cmd) -> Result<Output, GitError> {
        self.git.run(Some(&self.workdir), cmd)
    }

    fn with_index(cmd: Cmd, index: Option<&Path>) -> Cmd {
        match index {
            Some(p) => cmd.env("GIT_INDEX_FILE", p),
            None => cmd,
        }
    }

    // ---- refs and revisions -------------------------------------------------------------

    /// Resolves a revision to an object id, or `None` when it does not exist.
    pub fn resolve(&self, spec: &str) -> Result<Option<String>, GitError> {
        let o = self.run(Cmd::new(["rev-parse", "--verify", "--quiet", spec]).ok_codes(&[1]))?;
        let s = o.stdout_trimmed();
        Ok(if o.code == 0 && !s.is_empty() {
            Some(s)
        } else {
            None
        })
    }

    /// Tree id of a commit.
    pub fn tree_of(&self, commit: &str) -> Result<String, GitError> {
        let spec = format!("{commit}^{{tree}}");
        self.resolve(&spec)?
            .ok_or_else(|| GitError::Parse(format!("oggetto non trovato: {commit}")))
    }

    /// Creates or moves a ref; with `old` the update only succeeds if the ref currently has that value
    /// (use the all-zero id to require that the ref does not exist).
    pub fn update_ref(&self, name: &str, new: &str, old: Option<&str>) -> Result<(), GitError> {
        let mut c = Cmd::new(["update-ref", name, new]);
        if let Some(o) = old {
            c = c.arg(o);
        }
        self.run(c)?;
        Ok(())
    }

    /// Deletes a ref (no error if it does not exist).
    pub fn delete_ref(&self, name: &str) -> Result<(), GitError> {
        if self.resolve(name)?.is_some() {
            self.run(Cmd::new(["update-ref", "-d", name]))?;
        }
        Ok(())
    }

    /// Whether `a` is an ancestor of (or equal to) `b`.
    pub fn is_ancestor(&self, a: &str, b: &str) -> Result<bool, GitError> {
        let o = self.run(Cmd::new(["merge-base", "--is-ancestor", a, b]).ok_codes(&[1]))?;
        Ok(o.code == 0)
    }

    /// Best common ancestor of two commits.
    pub fn merge_base(&self, a: &str, b: &str) -> Result<Option<String>, GitError> {
        let o = self.run(Cmd::new(["merge-base", a, b]).ok_codes(&[1]))?;
        let s = o.stdout_trimmed();
        Ok(if o.code == 0 && !s.is_empty() {
            Some(s)
        } else {
            None
        })
    }

    /// `git rev-list` with arbitrary arguments; returns the object ids.
    pub fn rev_list(&self, args: &[&str]) -> Result<Vec<String>, GitError> {
        let o = self.run(Cmd::new(["rev-list"]).args(args))?;
        Ok(o.stdout_string()
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect())
    }

    /// Lists refs under a prefix (e.g. `refs/rocketsync/safety/`).
    pub fn for_each_ref(&self, prefix: &str) -> Result<Vec<RefInfo>, GitError> {
        let o = self.run(Cmd::new([
            "for-each-ref",
            "--format=%(refname)%09%(objectname)%09%(creatordate:unix)",
            prefix,
        ]))?;
        let mut v = Vec::new();
        for line in o.stdout_string().lines() {
            let mut it = line.split('\t');
            if let (Some(n), Some(s)) = (it.next(), it.next()) {
                let d = it.next().and_then(|d| d.trim().parse().ok()).unwrap_or(0);
                v.push(RefInfo {
                    name: n.to_string(),
                    sha: s.to_string(),
                    date_unix: d,
                });
            }
        }
        Ok(v)
    }

    // ---- commits ------------------------------------------------------------------------

    /// Reads commits with `git log -z`. `args` are extra `git log` arguments (revisions, `--first-parent`,
    /// `-n`, `--no-walk`, ...).
    pub fn log(&self, args: &[&str]) -> Result<Vec<CommitInfo>, GitError> {
        const FMT: &str =
            "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%at%x1f%cn%x1f%ce%x1f%cI%x1f%ct%x1f%B";
        let o = self.run(Cmd::new(["log", "-z", FMT]).args(args))?;
        let mut out = Vec::new();
        for rec in o.stdout.split(|b| *b == 0) {
            if rec.is_empty() {
                continue;
            }
            let s = utf8(rec);
            let s = s.trim_start_matches('\n');
            let f: Vec<&str> = s.splitn(11, '\x1f').collect();
            if f.len() < 11 {
                return Err(GitError::Parse(format!("record di log non valido: {s:?}")));
            }
            out.push(CommitInfo {
                sha: f[0].to_string(),
                parents: f[1].split_whitespace().map(str::to_string).collect(),
                author: Signature {
                    name: f[2].to_string(),
                    email: f[3].to_string(),
                    when_iso: Some(f[4].to_string()),
                    when_unix: f[5].parse().unwrap_or(0),
                },
                committer: Signature {
                    name: f[6].to_string(),
                    email: f[7].to_string(),
                    when_iso: Some(f[8].to_string()),
                    when_unix: f[9].parse().unwrap_or(0),
                },
                message: f[10].to_string(),
            });
        }
        Ok(out)
    }

    /// One commit by revision.
    pub fn commit_info(&self, rev: &str) -> Result<CommitInfo, GitError> {
        self.log(&["--no-walk", "-n", "1", rev, "--"])?
            .into_iter()
            .next()
            .ok_or_else(|| GitError::Parse(format!("commit non trovato: {rev}")))
    }

    /// Creates a commit object (does not move any ref).
    pub fn commit_tree(&self, spec: &CommitSpec<'_>) -> Result<String, GitError> {
        let mut c = Cmd::new(["commit-tree", spec.tree]);
        for p in spec.parents {
            c = c.arg("-p").arg(p);
        }
        c = c.arg("-F").arg("-").stdin(spec.message.as_bytes().to_vec());
        c = c
            .env("GIT_AUTHOR_NAME", &spec.author.name)
            .env("GIT_AUTHOR_EMAIL", &spec.author.email)
            .env("GIT_COMMITTER_NAME", &spec.committer.name)
            .env("GIT_COMMITTER_EMAIL", &spec.committer.email);
        if let Some(d) = &spec.author.when_iso {
            c = c.env("GIT_AUTHOR_DATE", d);
        }
        if let Some(d) = &spec.committer.when_iso {
            c = c.env("GIT_COMMITTER_DATE", d);
        }
        Ok(self.run(c)?.stdout_trimmed())
    }

    // ---- trees and blobs ----------------------------------------------------------------

    /// All files of a tree-ish, recursively.
    pub fn ls_tree(&self, rev: &str) -> Result<Vec<TreeEntry>, GitError> {
        let o = self.run(Cmd::new(["ls-tree", "-r", "-z", "--long", rev]))?;
        parse_ls_tree(&o.stdout)
    }

    /// Same as [`Repo::ls_tree`] keyed by path.
    pub fn tree_map(&self, rev: &str) -> Result<HashMap<String, TreeEntry>, GitError> {
        Ok(self
            .ls_tree(rev)?
            .into_iter()
            .map(|e| (e.path.clone(), e))
            .collect())
    }

    /// Content of a blob.
    pub fn cat_blob(&self, oid: &str) -> Result<Vec<u8>, GitError> {
        Ok(self.run(Cmd::new(["cat-file", "blob", oid]))?.stdout)
    }

    /// Size and type of several objects at once (`None` for missing ones). Specs can be `oid` or `rev:path`.
    pub fn batch_check(&self, specs: &[String]) -> Result<Vec<Option<(String, u64)>>, GitError> {
        if specs.is_empty() {
            return Ok(Vec::new());
        }
        let mut input = String::new();
        for s in specs {
            input.push_str(s);
            input.push('\n');
        }
        let o = self.run(Cmd::new(["cat-file", "--batch-check"]).stdin(input.into_bytes()))?;
        let text = o.stdout_string();
        let mut v = Vec::new();
        for line in text.lines() {
            let f: Vec<&str> = line.split(' ').collect();
            if f.len() == 3 && f[1] != "missing" {
                v.push(f[2].parse::<u64>().ok().map(|n| (f[1].to_string(), n)));
            } else {
                v.push(None);
            }
        }
        Ok(v)
    }

    /// Writes a blob into the object database and returns its id.
    pub fn write_blob(&self, data: &[u8]) -> Result<String, GitError> {
        Ok(self
            .run(Cmd::new(["hash-object", "-w", "--no-filters", "--stdin"]).stdin(data.to_vec()))?
            .stdout_trimmed())
    }

    /// Blob ids of files on disk (relative to the working directory), without writing them and without
    /// any filter. Missing files give `None`.
    pub fn hash_files(&self, rel_paths: &[String]) -> Result<Vec<Option<String>>, GitError> {
        let mut result: Vec<Option<String>> = vec![None; rel_paths.len()];
        let mut batch: Vec<usize> = Vec::new();
        for (i, p) in rel_paths.iter().enumerate() {
            let abs = self.workdir.join(p);
            if !abs.is_file() {
                continue;
            }
            if p.contains('\n') {
                let o = self
                    .run(Cmd::new(["hash-object", "--no-filters", "--"]).arg(OsString::from(p)))?;
                result[i] = Some(o.stdout_trimmed());
            } else {
                batch.push(i);
            }
        }
        if !batch.is_empty() {
            let mut input = String::new();
            for &i in &batch {
                input.push_str(&rel_paths[i]);
                input.push('\n');
            }
            let o = self.run(
                Cmd::new(["hash-object", "--no-filters", "--stdin-paths"])
                    .stdin(input.into_bytes()),
            )?;
            let text = o.stdout_string();
            let lines: Vec<&str> = text.lines().collect();
            if lines.len() != batch.len() {
                return Err(GitError::Parse(
                    "hash-object: numero di risultati inatteso".into(),
                ));
            }
            for (k, &i) in batch.iter().enumerate() {
                result[i] = Some(lines[k].trim().to_string());
            }
        }
        Ok(result)
    }

    // ---- diffs --------------------------------------------------------------------------

    /// Differences between two tree-ish objects (`-r --raw`), optionally with rename detection.
    pub fn diff_tree(&self, a: &str, b: &str, renames: bool) -> Result<Vec<DiffEntry>, GitError> {
        let o = self.run(
            Cmd::new(["diff-tree", "-r", "-z", "--raw", "--no-commit-id"])
                .arg(if renames { "-M" } else { "--no-renames" })
                .arg(a)
                .arg(b),
        )?;
        parse_diff_raw(&o.stdout)
    }

    /// Paths reported as binary by `git diff-tree --numstat` between two tree-ish objects.
    pub fn binary_paths(&self, a: &str, b: &str) -> Result<Vec<String>, GitError> {
        let o = self.run(Cmd::new([
            "diff-tree",
            "-r",
            "-z",
            "--numstat",
            "-M",
            "--no-commit-id",
            a,
            b,
        ]))?;
        let mut bins = Vec::new();
        let recs: Vec<String> = o.stdout.split(|x| *x == 0).map(utf8).collect();
        let mut i = 0;
        while i < recs.len() {
            let r = &recs[i];
            if r.is_empty() {
                i += 1;
                continue;
            }
            let mut f = r.splitn(3, '\t');
            let (add, del, rest) = (f.next(), f.next(), f.next());
            if let (Some(add), Some(del), Some(rest)) = (add, del, rest) {
                if rest.is_empty() {
                    // rename: next two records are old and new path
                    if let Some(new) = recs.get(i + 2) {
                        if add == "-" && del == "-" {
                            bins.push(new.clone());
                        }
                    }
                    i += 3;
                    continue;
                }
                if add == "-" && del == "-" {
                    bins.push(rest.to_string());
                }
            }
            i += 1;
        }
        Ok(bins)
    }

    /// Unified text diff of one path between two commits (empty for binary files).
    pub fn diff_text(&self, a: &str, b: &str, path: &str) -> Result<String, GitError> {
        let o = self.run(
            Cmd::new([
                "diff",
                "--no-color",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "-U3",
                a,
                b,
                "--",
            ])
            .arg(path),
        )?;
        Ok(o.stdout_string())
    }

    // ---- index and trees ----------------------------------------------------------------

    /// `read-tree <tree>` into `index` (a private index file when given).
    pub fn read_tree(&self, index: Option<&Path>, tree: &str) -> Result<(), GitError> {
        self.run(Self::with_index(Cmd::new(["read-tree", tree]), index))?;
        Ok(())
    }

    /// `git add -A` into `index`.
    pub fn add_all(&self, index: Option<&Path>) -> Result<(), GitError> {
        self.run(Self::with_index(Cmd::new(["add", "-A", "--", "."]), index))?;
        Ok(())
    }

    /// Records the on-disk state of `paths` in `index`: existing files are added, missing ones removed.
    pub fn update_index_paths(
        &self,
        index: Option<&Path>,
        paths: &[String],
    ) -> Result<(), GitError> {
        if paths.is_empty() {
            return Ok(());
        }
        let mut input = Vec::new();
        for p in paths {
            input.extend_from_slice(p.as_bytes());
            input.push(0);
        }
        self.run(Self::with_index(
            Cmd::new(["update-index", "--add", "--remove", "-z", "--stdin"]).stdin(input),
            index,
        ))?;
        Ok(())
    }

    /// Sets index entries directly from object ids (no file access).
    pub fn update_index_info(
        &self,
        index: Option<&Path>,
        entries: &[IndexInfoEntry],
    ) -> Result<(), GitError> {
        if entries.is_empty() {
            return Ok(());
        }
        let zero = "0".repeat(40);
        let mut input = Vec::new();
        for e in entries {
            match &e.mode_oid {
                Some((mode, oid)) => {
                    input.extend_from_slice(format!("{mode} {oid}\t{}", e.path).as_bytes())
                }
                None => input.extend_from_slice(format!("0 {zero}\t{}", e.path).as_bytes()),
            }
            input.push(0);
        }
        self.run(Self::with_index(
            Cmd::new(["update-index", "-z", "--index-info"]).stdin(input),
            index,
        ))?;
        Ok(())
    }

    /// Writes the tree object of `index`.
    pub fn write_tree(&self, index: Option<&Path>) -> Result<String, GitError> {
        Ok(self
            .run(Self::with_index(Cmd::new(["write-tree"]), index))?
            .stdout_trimmed())
    }

    // ---- status -------------------------------------------------------------------------

    /// `git status --porcelain=v2 -z --untracked-files=all`.
    pub fn status(&self) -> Result<Vec<StatusEntry>, GitError> {
        let o = self.run(Cmd::new([
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--no-renames",
        ]))?;
        parse_status(&o.stdout)
    }

    // ---- merge-tree ---------------------------------------------------------------------

    /// Three-way merge of two commits without touching any working directory (`git merge-tree --write-tree`).
    pub fn merge_tree(
        &self,
        base: &str,
        side1: &str,
        side2: &str,
    ) -> Result<MergeTreeResult, GitError> {
        let mb = format!("--merge-base={base}");
        let o = self.run(
            Cmd::new([
                "merge-tree",
                "--write-tree",
                "-z",
                "--name-only",
                &mb,
                side1,
                side2,
            ])
            .ok_codes(&[1]),
        )?;
        parse_merge_tree(&o.stdout, o.code == 0)
    }

    // ---- remotes ------------------------------------------------------------------------

    /// `git fetch <remote> <refspecs…>` (never forced: refspecs without `+`).
    pub fn fetch(&self, remote: &str, refspecs: &[&str]) -> Result<(), GitError> {
        self.run(
            Cmd::new(["fetch", "--quiet", "--no-tags", remote])
                .args(refspecs)
                .network(),
        )?;
        Ok(())
    }

    /// `git push --atomic <remote> <refspecs…>` (no force option is ever passed).
    pub fn push_atomic(&self, remote: &str, refspecs: &[String]) -> Result<(), GitError> {
        self.run(
            Cmd::new(["push", "--atomic", "--quiet", "--no-verify", remote])
                .args(refspecs)
                .network(),
        )?;
        Ok(())
    }

    /// Deletes a branch on the remote (`push <remote> :refs/heads/<branch>`).
    pub fn push_delete(&self, remote: &str, refname: &str) -> Result<(), GitError> {
        let spec = format!(":{refname}");
        self.run(Cmd::new(["push", "--quiet", "--no-verify", remote, &spec]).network())?;
        Ok(())
    }

    /// Refreshes the stat information of the index (no content change); safe when files differ.
    pub fn refresh_index(&self) -> Result<(), GitError> {
        self.run(Cmd::new(["update-index", "-q", "--refresh"]).ok_codes(&[1]))?;
        Ok(())
    }

    /// Disk space used by the object database in KiB (`count-objects -v`: loose + packed).
    pub fn object_store_kib(&self) -> Result<u64, GitError> {
        let o = self.run(Cmd::new(["count-objects", "-v"]))?;
        let mut total = 0u64;
        for line in o.stdout_string().lines() {
            if let Some((k, v)) = line.split_once(':') {
                if k == "size" || k == "size-pack" {
                    total += v.trim().parse::<u64>().unwrap_or(0);
                }
            }
        }
        Ok(total)
    }

    /// Reads a repository config value.
    pub fn config_get(&self, key: &str) -> Result<Option<String>, GitError> {
        let o = self.run(Cmd::new(["config", "--get", key]).ok_codes(&[1]))?;
        Ok(if o.code == 0 {
            Some(o.stdout_trimmed())
        } else {
            None
        })
    }

    /// Writes a repository config value.
    pub fn config_set(&self, key: &str, value: &str) -> Result<(), GitError> {
        self.run(Cmd::new(["config", key, value]))?;
        Ok(())
    }
}

// ---- parsers (pure functions, unit tested) ---------------------------------------------

pub(crate) fn parse_ls_tree(bytes: &[u8]) -> Result<Vec<TreeEntry>, GitError> {
    let mut v = Vec::new();
    for rec in bytes.split(|b| *b == 0) {
        if rec.is_empty() {
            continue;
        }
        let s = utf8(rec);
        let (meta, path) = s
            .split_once('\t')
            .ok_or_else(|| GitError::Parse(format!("ls-tree: {s:?}")))?;
        let f: Vec<&str> = meta.split_whitespace().collect();
        if f.len() < 4 {
            return Err(GitError::Parse(format!("ls-tree: {s:?}")));
        }
        if f[1] != "blob" {
            continue; // submodules are not supported
        }
        v.push(TreeEntry {
            mode: f[0].to_string(),
            oid: f[2].to_string(),
            size: f[3].parse().ok(),
            path: path.to_string(),
        });
    }
    Ok(v)
}

pub(crate) fn parse_diff_raw(bytes: &[u8]) -> Result<Vec<DiffEntry>, GitError> {
    let toks: Vec<String> = bytes.split(|b| *b == 0).map(utf8).collect();
    let mut v = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let t = &toks[i];
        if t.is_empty() {
            i += 1;
            continue;
        }
        let meta = t
            .strip_prefix(':')
            .ok_or_else(|| GitError::Parse(format!("diff-tree: {t:?}")))?;
        let f: Vec<&str> = meta.split(' ').collect();
        if f.len() < 5 {
            return Err(GitError::Parse(format!("diff-tree: {t:?}")));
        }
        let status = f[4].chars().next().unwrap_or('M');
        let (path, old_path, adv) = if status == 'R' || status == 'C' {
            let old = toks.get(i + 1).cloned().unwrap_or_default();
            let new = toks.get(i + 2).cloned().unwrap_or_default();
            (new, Some(old), 3)
        } else {
            (toks.get(i + 1).cloned().unwrap_or_default(), None, 2)
        };
        v.push(DiffEntry {
            status,
            old_mode: f[0].to_string(),
            new_mode: f[1].to_string(),
            old_oid: f[2].to_string(),
            new_oid: f[3].to_string(),
            path,
            old_path,
        });
        i += adv;
    }
    Ok(v)
}

pub(crate) fn parse_status(bytes: &[u8]) -> Result<Vec<StatusEntry>, GitError> {
    let toks: Vec<String> = bytes.split(|b| *b == 0).map(utf8).collect();
    let mut v = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        let t = &toks[i];
        i += 1;
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let kind = t.chars().next().unwrap_or(' ');
        match kind {
            '1' => {
                let f: Vec<&str> = t.splitn(9, ' ').collect();
                if f.len() < 9 {
                    return Err(GitError::Parse(format!("status: {t:?}")));
                }
                let xy: Vec<char> = f[1].chars().collect();
                v.push(StatusEntry {
                    path: f[8].to_string(),
                    kind: StatusKind::Tracked,
                    x: xy.first().copied().unwrap_or('.'),
                    y: xy.get(1).copied().unwrap_or('.'),
                    head_oid: Some(f[6].to_string()),
                    index_oid: Some(f[7].to_string()),
                    orig_path: None,
                });
            }
            '2' => {
                let f: Vec<&str> = t.splitn(10, ' ').collect();
                if f.len() < 10 {
                    return Err(GitError::Parse(format!("status: {t:?}")));
                }
                let xy: Vec<char> = f[1].chars().collect();
                let orig = toks.get(i).cloned();
                i += 1;
                v.push(StatusEntry {
                    path: f[9].to_string(),
                    kind: StatusKind::Tracked,
                    x: xy.first().copied().unwrap_or('.'),
                    y: xy.get(1).copied().unwrap_or('.'),
                    head_oid: Some(f[6].to_string()),
                    index_oid: Some(f[7].to_string()),
                    orig_path: orig,
                });
            }
            'u' => {
                let f: Vec<&str> = t.splitn(11, ' ').collect();
                if f.len() < 11 {
                    return Err(GitError::Parse(format!("status: {t:?}")));
                }
                let xy: Vec<char> = f[1].chars().collect();
                v.push(StatusEntry {
                    path: f[10].to_string(),
                    kind: StatusKind::Unmerged,
                    x: xy.first().copied().unwrap_or('U'),
                    y: xy.get(1).copied().unwrap_or('U'),
                    head_oid: None,
                    index_oid: None,
                    orig_path: None,
                });
            }
            '?' => {
                v.push(StatusEntry {
                    path: t[2..].to_string(),
                    kind: StatusKind::Untracked,
                    x: '?',
                    y: '?',
                    head_oid: None,
                    index_oid: None,
                    orig_path: None,
                });
            }
            _ => {}
        }
    }
    Ok(v)
}

pub(crate) fn parse_merge_tree(bytes: &[u8], clean: bool) -> Result<MergeTreeResult, GitError> {
    // Layout with `-z --name-only`: <tree> NUL (<path> NUL)* NUL <messages…>
    let mut parts = bytes.split(|b| *b == 0);
    let tree = parts
        .next()
        .map(|p| utf8(p).trim().to_string())
        .filter(|t| t.len() >= 40)
        .ok_or_else(|| GitError::Parse("merge-tree: albero mancante".into()))?;
    let mut conflicted: Vec<String> = Vec::new();
    for p in parts.by_ref() {
        if p.is_empty() {
            break;
        }
        conflicted.push(utf8(p));
    }
    let messages: Vec<String> = parts.map(utf8).collect();
    conflicted.sort();
    conflicted.dedup();
    Ok(MergeTreeResult {
        tree,
        clean,
        conflicted,
        messages: messages.join("\n"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_v2() {
        let raw = b"1 .M N... 100644 100644 100644 aaa bbb dir/a.ork\x001 .D N... 100644 100644 000000 aaa aaa b.ork\x00? new file.txt\x00";
        let v = parse_status(raw).unwrap();
        assert_eq!(v.len(), 3);
        assert_eq!(v[0].path, "dir/a.ork");
        assert_eq!((v[0].x, v[0].y), ('.', 'M'));
        assert_eq!(v[1].y, 'D');
        assert_eq!(v[2].kind, StatusKind::Untracked);
        assert_eq!(v[2].path, "new file.txt");
    }

    #[test]
    fn parses_diff_raw_with_rename() {
        let raw = b":100644 100644 aaa bbb M\0a.txt\0:100644 100644 ccc ccc R100\0old.txt\0new.txt\0:000000 100644 000 ddd A\0z.ork\0";
        let v = parse_diff_raw(raw).unwrap();
        assert_eq!(v.len(), 3);
        assert_eq!(v[0].status, 'M');
        assert_eq!(v[1].status, 'R');
        assert_eq!(v[1].old_path.as_deref(), Some("old.txt"));
        assert_eq!(v[1].path, "new.txt");
        assert_eq!(v[2].path, "z.ork");
        assert!(DiffEntry::is_zero_oid(&v[2].old_oid));
    }

    #[test]
    fn parses_merge_tree_output() {
        let tree = "a".repeat(40);
        let raw = format!("{tree}\0a.ork\0b.ork\0\01\0a.ork\0CONFLICT (binary)\0msg\0");
        let r = parse_merge_tree(raw.as_bytes(), false).unwrap();
        assert_eq!(r.tree, tree);
        assert_eq!(r.conflicted, vec!["a.ork", "b.ork"]);
        assert!(!r.clean);
        let clean = parse_merge_tree(format!("{tree}\0\0").as_bytes(), true).unwrap();
        assert!(clean.conflicted.is_empty());
    }

    #[test]
    fn parses_ls_tree_long() {
        let raw =
            b"100644 blob 3b18e512dba79e4c8300dd08aeb37f8e728b8dad    1234\tdir/file name.ork\0";
        let v = parse_ls_tree(raw).unwrap();
        assert_eq!(v[0].size, Some(1234));
        assert_eq!(v[0].path, "dir/file name.ork");
    }
}

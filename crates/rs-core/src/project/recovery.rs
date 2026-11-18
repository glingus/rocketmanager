//! Recovery after a crash (`docs/protocollo-sync.md` §9).

use super::*;
use crate::types::RecoveryReport;
use rs_store::{ConflictStatus, JournalEntry};
use std::collections::HashSet;
use std::time::SystemTime;

const LEFTOVER_LOCKS: &[&str] = &[
    "index.lock",
    "HEAD.lock",
    "config.lock",
    "shallow.lock",
    "refs/heads/main.lock",
    "refs/remotes/origin/main.lock",
];

const MERGE_STATE_FILES: &[&str] = &[
    "MERGE_HEAD",
    "MERGE_MSG",
    "MERGE_MODE",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "AUTO_MERGE",
];
const MERGE_STATE_DIRS: &[&str] = &["rebase-merge", "rebase-apply", "sequencer"];

impl ProjectInner {
    fn report(&self, op_id: &str, summary: String, out: &mut Vec<RecoveryReport>) {
        self.emit(EngineEvent::RecoveryPerformed {
            project_id: self.id.clone(),
            op_id: op_id.to_string(),
            summary: summary.clone(),
        });
        out.push(RecoveryReport {
            project_id: self.id.clone(),
            op_id: op_id.to_string(),
            summary,
        });
    }

    /// Records a recovery action that has no journal entry of its own.
    fn record_recovery(
        &self,
        kind: &str,
        summary: &str,
        out: &mut Vec<RecoveryReport>,
    ) -> Result<()> {
        let op_id = format!("rec-{}-{}", rs_store::now_ms(), crate::util::random_id(5));
        self.shared.store.journal_begin(
            &op_id,
            &self.id,
            kind,
            "recovery",
            &serde_json::json!({}),
        )?;
        self.shared
            .store
            .journal_finish(&op_id, "recovered", Some(summary))?;
        self.report(&op_id, summary.to_string(), out);
        Ok(())
    }

    /// Runs the startup recovery of the project. Never touches the user's files except to
    /// *complete* an interrupted materialisation.
    pub(crate) fn recover(&self) -> Result<Vec<RecoveryReport>> {
        let mut reports = Vec::new();
        let git_dir = self.repo.git_dir();

        // 1. stale locks and private indexes of ours
        let max_age = self.shared.config.timing.stale_lock_age;
        let mut removed: Vec<String> = Vec::new();
        for name in LEFTOVER_LOCKS {
            let p = git_dir.join(name);
            if let Ok(meta) = std::fs::metadata(&p) {
                let age = meta
                    .modified()
                    .ok()
                    .and_then(|m| SystemTime::now().duration_since(m).ok())
                    .unwrap_or_default();
                if age >= max_age && std::fs::remove_file(&p).is_ok() {
                    removed.push((*name).to_string());
                }
            }
        }
        if let Ok(rd) = std::fs::read_dir(&git_dir) {
            for e in rd.flatten() {
                if e.file_name()
                    .to_string_lossy()
                    .starts_with("rocketsync-index-")
                {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
        if !removed.is_empty() {
            self.record_recovery(
                "recovery-lock",
                &format!(
                    "Rimossi blocchi di Git rimasti da un arresto precedente ({}).",
                    removed.join(", ")
                ),
                &mut reports,
            )?;
        }

        // 2. half-done merge/rebase states: Rocket Sync never creates them, so they are leftovers.
        let mut leftovers: Vec<String> = Vec::new();
        for f in MERGE_STATE_FILES {
            if git_dir.join(f).exists() {
                leftovers.push((*f).to_string());
            }
        }
        for d in MERGE_STATE_DIRS {
            if git_dir.join(d).is_dir() {
                leftovers.push((*d).to_string());
            }
        }
        if !leftovers.is_empty() {
            self.safety_snapshot("recupero")?;
            for f in MERGE_STATE_FILES {
                let _ = std::fs::remove_file(git_dir.join(f));
            }
            for d in MERGE_STATE_DIRS {
                let p = git_dir.join(d);
                if p.is_dir() {
                    let _ = std::fs::remove_dir_all(p);
                }
            }
            // Re-align the index with HEAD; working files are not touched.
            self.repo.read_tree(None, "HEAD")?;
            self.repo.refresh_index()?;
            self.record_recovery(
                "recovery-merge-state",
                &format!(
                    "Annullato uno stato di unione rimasto a metà ({}). I file non sono stati modificati.",
                    leftovers.join(", ")
                ),
                &mut reports,
            )?;
        }

        // 3. unfinished operations of the journal
        for entry in self.shared.store.journal_unfinished(&self.id)? {
            let summary = self.recover_entry(&entry)?;
            self.shared
                .store
                .journal_finish(&entry.op_id, "recovered", Some(&summary))?;
            self.report(&entry.op_id, summary, &mut reports);
        }
        self.mark_dirty();
        Ok(reports)
    }

    fn recover_entry(&self, e: &JournalEntry) -> Result<String> {
        match e.step.as_str() {
            "materializing" => self.recover_materializing(e),
            "send_prepared" | "pushed" | "sent" => Ok(
                "Invio interrotto: le versioni in attesa verranno inviate al prossimo controllo, senza duplicati."
                    .into(),
            ),
            "conflict_created" => {
                if let Some(id) = e.payload.get("conflictId").and_then(|v| v.as_str()) {
                    let _ = self.push_conflict_branch(id);
                }
                Ok("Conflitto registrato ma interrotto: la copia di sicurezza sul server verrà inviata appena possibile.".into())
            }
            "committed" => Ok(
                "Pubblicazione interrotta dopo la creazione della versione: verrà inviata al prossimo controllo.".into(),
            ),
            _ => Ok("Operazione interrotta prima di modificare i file: nessuna perdita di dati.".into()),
        }
    }

    fn recover_materializing(&self, e: &JournalEntry) -> Result<String> {
        let get = |k: &str| {
            e.payload
                .get(k)
                .and_then(|v| v.as_str())
                .map(str::to_string)
        };
        let (Some(old_head), Some(new_head), Some(from_tree), Some(to_tree)) = (
            get("oldHead"),
            get("newHead"),
            get("fromTree"),
            get("toTree"),
        ) else {
            return Ok("Aggiornamento interrotto: dati del journal incompleti, nessun file modificato dal recupero.".into());
        };
        let allow: HashSet<String> = e
            .payload
            .get("allowDirty")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let head = self.head()?;
        let outcome = if head == new_head {
            "completato".to_string()
        } else if head == old_head {
            match self.materialize(&from_tree, &to_tree, &allow) {
                Ok(report) => {
                    self.repo.update_ref(MAIN_REF, &new_head, Some(&old_head))?;
                    self.arm_guards(&report, &old_head, &new_head)?;
                    "completato".to_string()
                }
                Err(CoreError::LocalChangesPresent(paths)) => {
                    return Ok(format!(
                        "Aggiornamento interrotto e non completabile: i file {} sono stati modificati nel frattempo. \
                         È rimasta attiva la versione precedente e c'è una copia di sicurezza.",
                        paths.join(", ")
                    ));
                }
                Err(err) => return Err(err),
            }
        } else {
            return Ok("Aggiornamento interrotto: lo stato del progetto è cambiato, nessun file modificato dal recupero.".into());
        };
        // A resolution whose commit now exists but whose bookkeeping was lost.
        if let Some(cid) = e.payload.get("conflictId").and_then(|v| v.as_str()) {
            if let Some(mut rec) = self.shared.store.get_conflict(&self.id, cid)? {
                if rec.status == ConflictStatus::Open {
                    rec.status = ConflictStatus::Resolving;
                    rec.resolution_sha = Some(new_head.clone());
                    rec.resolution = e.payload.get("resolutions").cloned();
                    self.shared.store.save_conflict(&rec)?;
                }
            }
        }
        Ok(format!(
            "Aggiornamento dei file interrotto a metà: {outcome}. Nessun dato perso."
        ))
    }
}

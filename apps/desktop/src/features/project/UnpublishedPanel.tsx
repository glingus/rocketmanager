import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { backend } from '../../lib/backend';
import type { ProjectStatus, PublishPolicy } from '../../lib/types/ipc';
import { Button, ConfirmDialog, Field, Input, Panel, Pencil, Textarea, Trash2, Upload, Clock } from '../../ui';
import { FileTable } from './FileTable';
import { Countdown } from './Countdown';
import { it } from '../../i18n/it';
import { qk } from '../../app/queryClient';
import { useApiMutation } from '../../app/useApiMutation';
import { toast } from '../../ui';
import { hasBlockingFileIssues } from '../../lib/utils/status';
import { useUi } from '../../app/uiStore';
import { ProgressBar } from '../shared/ProgressBar';
import styles from './UnpublishedPanel.module.css';

export function UnpublishedPanel({ status, policy }: { status: ProjectStatus; policy: PublishPolicy | undefined }) {
  const projectId = status.projectId;
  const qc = useQueryClient();
  const progress = useUi((s) => s.progress[projectId]);
  const files = status.changedFiles;
  const [selected, setSelected] = useState<Set<string>>(() => new Set(files.map((f) => f.path)));
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // New files that appear while the panel is open are selected by default.
  const knownKey = files.map((f) => f.path).join('|');
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((p) => files.some((f) => f.path === p)));
      for (const f of files) if (!prev.has(f.path) && !next.has(f.path)) next.add(f.path);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownKey]);

  const chosen = useMemo(() => files.filter((f) => selected.has(f.path)), [files, selected]);
  const allChosen = chosen.length === files.length;
  const conflict = status.openConflictIds.length > 0;
  const staleBlocked = chosen.some((f) => status.staleSaveSuspected.includes(f.path));
  const blocked = hasBlockingFileIssues({ changedFiles: chosen });
  const busy = status.state === 'publishing' || status.state === 'updating';
  const canPublish = chosen.length > 0 && !blocked && !conflict && !staleBlocked && !busy;

  const publish = useApiMutation(
    () =>
      backend.publish({
        projectId,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(allChosen ? {} : { paths: chosen.map((f) => f.path) }),
      }),
    {
      errorTitle: it.overview.unpublished.publish,
      onSuccess: (s) => {
        qc.setQueryData(qk.status(projectId), s);
        setTitle('');
        setDescription('');
        void qc.invalidateQueries({ queryKey: qk.versions(projectId) });
        void qc.invalidateQueries({ queryKey: qk.snapshots(projectId) });
      },
    },
  );

  const discard = useApiMutation(() => backend.discardChanges({ projectId, paths: chosen.map((f) => f.path) }), {
    errorTitle: it.overview.unpublished.discard,
    onSuccess: (s) => {
      qc.setQueryData(qk.status(projectId), s);
      toast.info(it.toasts.discarded);
      setConfirmDiscard(false);
    },
  });

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const open = (path: string) => void backend.openInOpenRocket({ projectId, path }).then(() => toast.info(it.toasts.openedCopy)).catch(() => toast.error(it.errors.title));

  const reason = conflict ? it.overview.unpublished.conflictBlocked : staleBlocked ? it.overview.unpublished.staleBlocked : blocked ? it.overview.unpublished.blocked : null;

  return (
    <Panel
      className={styles.panel}
      aria-label={it.overview.unpublished.title}
      selected
      data-testid="unpublished-banner"
    >
      <div className={styles.banner}>
        <div className={styles.bannerIcon} aria-hidden="true">
          <Pencil size={20} />
        </div>
        <div className={styles.bannerText}>
          <h2 className={styles.title}>{it.overview.unpublished.title}</h2>
          <p className={styles.subtitle}>{it.overview.unpublished.subtitle(files.length)}</p>
        </div>
        <div className={styles.auto}>
          {policy?.mode === 'assisted' && status.autoPublishAt && !conflict ? (
            <>
              <span className={styles.autoLabel}>
                <Clock size={14} /> {it.overview.unpublished.autoLabel}
              </span>
              <span className={styles.autoTime}>
                <Countdown until={status.autoPublishAt} />
              </span>
            </>
          ) : policy?.mode === 'manual' ? (
            <span className={styles.autoHint}>{it.overview.unpublished.manualHint}</span>
          ) : policy?.mode === 'onSave' ? (
            <span className={styles.autoHint}>{it.overview.unpublished.onSaveHint}</span>
          ) : null}
        </div>
      </div>

      <div className={styles.body}>
        <FileTable files={files} selected={selected} onToggle={toggle} onToggleAll={(all) => setSelected(all ? new Set(files.map((f) => f.path)) : new Set())} onOpen={open} stale={status.staleSaveSuspected} />

        <div className={styles.form}>
          <Field label={it.overview.unpublished.titleField} hint={it.overview.unpublished.titleHint} optional>
            {(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={it.overview.unpublished.titlePlaceholder} maxLength={120} />}
          </Field>
          <Field label={it.overview.unpublished.description} optional>
            {(p) => <Textarea {...p} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={it.overview.unpublished.descriptionPlaceholder} rows={2} />}
          </Field>
        </div>

        {publish.isPending && progress && <ProgressBar percent={progress.percent} label={progress.message} />}
        {reason && <p className={styles.reason}>{reason}</p>}

        <div className={styles.actions}>
          <Button variant="ghost" icon={<Trash2 />} onClick={() => setConfirmDiscard(true)} disabled={chosen.length === 0 || busy}>
            {it.overview.unpublished.discard}
          </Button>
          <Button variant="primary" size="lg" icon={<Upload />} disabled={!canPublish} loading={publish.isPending} onClick={() => publish.mutate(undefined)} data-testid="publish-button">
            {publish.isPending ? it.overview.unpublished.publishing : allChosen ? it.overview.unpublished.publish : it.overview.unpublished.publishSelected(chosen.length)}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        tone="danger"
        title={it.overview.unpublished.discardTitle}
        description={it.overview.unpublished.discardText(chosen.length)}
        confirmLabel={it.overview.unpublished.discardConfirm}
        onConfirm={() => discard.mutate(undefined)}
        loading={discard.isPending}
        icon={<Trash2 />}
      />
    </Panel>
  );
}

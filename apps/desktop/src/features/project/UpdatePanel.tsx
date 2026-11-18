import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { backend } from '../../lib/backend';
import type { ProjectStatus } from '../../lib/types/ipc';
import { ArrowDownToLine, Badge, Button, ConfirmDialog, File, Panel, TriangleAlert } from '../../ui';
import { it } from '../../i18n/it';
import { useApiMutation } from '../../app/useApiMutation';
import { qk } from '../../app/queryClient';
import styles from './UpdatePanel.module.css';

export function UpdatePanel({ status }: { status: ProjectStatus }) {
  const qc = useQueryClient();
  const [confirmForce, setConfirmForce] = useState(false);
  const blocked = status.blockedByEditor.length > 0;
  const update = useApiMutation((force: boolean) => backend.updateNow({ projectId: status.projectId, force }), {
    errorTitle: it.overview.update.updateNow,
    onSuccess: (s) => {
      qc.setQueryData(qk.status(status.projectId), s);
      void qc.invalidateQueries({ queryKey: qk.versions(status.projectId) });
      setConfirmForce(false);
    },
  });

  return (
    <Panel selected={false} className={[styles.panel, blocked ? styles.blocked : ''].join(' ')} data-testid="update-panel">
      <div className={styles.row}>
        <span className={styles.icon} aria-hidden="true">
          {blocked ? <TriangleAlert size={22} /> : <ArrowDownToLine size={22} />}
        </span>
        <div className={styles.text}>
          <h2 className={styles.title}>{blocked ? it.overview.update.blockedTitle : it.overview.update.availableTitle(status.behindBy)}</h2>
          <p>{blocked ? it.overview.update.blockedText : it.overview.update.availableText(status.remoteVersion)}</p>
          {blocked && (
            <div className={styles.files}>
              <span className={styles.filesLabel}>{it.overview.update.blockedFiles}</span>
              {status.blockedByEditor.map((f) => (
                <Badge key={f} tone="amber" icon={<File />}>
                  {f}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div className={styles.actions}>
          {blocked ? (
            <Button variant="secondary" onClick={() => setConfirmForce(true)} loading={update.isPending}>
              {it.overview.update.force}
            </Button>
          ) : (
            <Button variant="primary" icon={<ArrowDownToLine />} onClick={() => update.mutate(false)} loading={update.isPending}>
              {update.isPending ? it.overview.update.updating : it.overview.update.updateNow}
            </Button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmForce}
        onClose={() => setConfirmForce(false)}
        title={it.overview.update.forceTitle}
        description={it.overview.update.forceText}
        confirmLabel={it.overview.update.forceConfirm}
        onConfirm={() => update.mutate(true)}
        loading={update.isPending}
        icon={<TriangleAlert />}
        tone="danger"
      />
    </Panel>
  );
}

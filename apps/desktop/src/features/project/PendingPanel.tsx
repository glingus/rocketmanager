import { useQueryClient } from '@tanstack/react-query';
import { backend } from '../../lib/backend';
import type { ProjectStatus } from '../../lib/types/ipc';
import { Badge, Button, Clock, Panel, RefreshCw } from '../../ui';
import { it } from '../../i18n/it';
import { formatRelative } from '../../lib/utils/format';
import { useApiMutation } from '../../app/useApiMutation';
import { qk } from '../../app/queryClient';
import styles from './PendingPanel.module.css';

export function PendingPanel({ status }: { status: ProjectStatus }) {
  const qc = useQueryClient();
  const retry = useApiMutation(() => backend.syncNow(status.projectId), {
    errorTitle: it.overview.pending.sendNow,
    onSuccess: (s) => qc.setQueryData(qk.status(status.projectId), s),
  });
  return (
    <Panel
      title={it.overview.pending.title}
      subtitle={it.overview.pending.subtitle}
      actions={
        <Button size="sm" icon={<RefreshCw />} onClick={() => retry.mutate(undefined)} loading={retry.isPending}>
          {it.overview.pending.sendNow}
        </Button>
      }
      data-testid="pending-panel"
    >
      <ul className={styles.list}>
        {status.pendingVersions.map((v) => (
          <li key={v.sha} className={styles.item}>
            <span className={styles.num}>{it.overview.pending.number}</span>
            <div className={styles.text}>
              <strong>{v.title}</strong>
              <span className={styles.meta}>{formatRelative(v.createdAt)}</span>
            </div>
            <Badge tone={v.waitingReason === 'conflict' ? 'red' : 'blue'} icon={<Clock />}>
              {it.overview.pending.reason[v.waitingReason ?? 'waiting']}
            </Badge>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

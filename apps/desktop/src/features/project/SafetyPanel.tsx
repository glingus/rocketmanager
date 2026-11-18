import { useQuery } from '@tanstack/react-query';
import { backend } from '../../lib/backend';
import { Button, Download, Panel, ShieldCheck, toast } from '../../ui';
import { it } from '../../i18n/it';
import { qk } from '../../app/queryClient';
import { formatRelative } from '../../lib/utils/format';
import { QueryState } from '../../app/QueryState';
import styles from './SafetyPanel.module.css';

export function SafetyPanel({ projectId, folder }: { projectId: string; folder: string | null }) {
  const query = useQuery({ queryKey: qk.snapshots(projectId), queryFn: () => backend.listSnapshots(projectId) });
  const exportSnap = async (snapshotId: string) => {
    try {
      const dest = await backend.pickFolder(folder ?? undefined);
      if (!dest) return;
      const written = await backend.exportSnapshot({ projectId, snapshotId, destDir: dest });
      toast.success(it.toasts.exported(written.length));
    } catch {
      toast.error(it.errors.title);
    }
  };
  return (
    <Panel title={it.overview.safety.title} subtitle={it.overview.safety.text}>
      <QueryState query={query} lines={2}>
        {(snaps) =>
          snaps.length === 0 ? (
            <p className={styles.empty}>{it.overview.safety.empty}</p>
          ) : (
            <ul className={styles.list}>
              {snaps.slice(0, 5).map((s) => (
                <li key={s.id} className={styles.item}>
                  <ShieldCheck size={16} />
                  <span className={styles.what}>{it.overview.safety.operation[s.operation] ?? s.operation}</span>
                  <span className={styles.when}>{formatRelative(s.createdAt)}</span>
                  <span className={styles.count}>{it.common.files(s.fileCount)}</span>
                  <Button size="sm" variant="ghost" icon={<Download />} onClick={() => void exportSnap(s.id)}>
                    {it.overview.safety.export}
                  </Button>
                </li>
              ))}
            </ul>
          )
        }
      </QueryState>
    </Panel>
  );
}

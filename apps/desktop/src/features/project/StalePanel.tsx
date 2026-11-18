import { useQueryClient } from '@tanstack/react-query';
import { backend } from '../../lib/backend';
import { Button, CircleAlert, Panel, toast } from '../../ui';
import { it } from '../../i18n/it';
import { useApiMutation } from '../../app/useApiMutation';
import { qk } from '../../app/queryClient';
import styles from './StalePanel.module.css';

/** The "editor not updated" guard: did you reopen the file after the update? */
export function StalePanel({ projectId, path }: { projectId: string; path: string }) {
  const qc = useQueryClient();
  const answer = useApiMutation((reopened: boolean) => backend.answerStaleSave({ projectId, path, reopened }), {
    errorTitle: it.overview.stale.title,
    onSuccess: (s, reopened) => {
      qc.setQueryData(qk.status(projectId), s);
      if (!reopened) toast.info(it.overview.stale.noResult);
    },
  });
  return (
    <Panel className={styles.panel} data-testid="stale-panel" role="alertdialog" aria-label={it.overview.stale.title}>
      <div className={styles.row}>
        <span className={styles.icon} aria-hidden="true">
          <CircleAlert size={22} />
        </span>
        <div className={styles.text}>
          <h2 className={styles.title}>{it.overview.stale.title}</h2>
          <p>{it.overview.stale.text(path)}</p>
        </div>
      </div>
      <div className={styles.choices}>
        <div>
          <Button variant="secondary" onClick={() => answer.mutate(true)} loading={answer.isPending && answer.variables === true} disabled={answer.isPending}>
            {it.overview.stale.yes}
          </Button>
          <p className={styles.hint}>{it.overview.stale.yesHint}</p>
        </div>
        <div>
          <Button variant="primary" onClick={() => answer.mutate(false)} loading={answer.isPending && answer.variables === false} disabled={answer.isPending}>
            {it.overview.stale.no}
          </Button>
          <p className={styles.hint}>{it.overview.stale.noHint}</p>
        </div>
      </div>
    </Panel>
  );
}

import type { ProjectStatus } from '../../lib/types/ipc';
import { Panel, SyncStateLamp } from '../../ui';
import { formatBytes, formatRelative } from '../../lib/utils/format';
import { it } from '../../i18n/it';
import { stateMeta } from '../../lib/utils/status';
import { useUi } from '../../app/uiStore';
import { ProgressBar } from '../shared/ProgressBar';
import { errorMessage } from '../../app/errors';
import styles from './StatusHero.module.css';

export function StatusHero({ status, projectId }: { status: ProjectStatus; projectId: string }) {
  const progress = useUi((s) => s.progress[projectId]);
  const meta = stateMeta(status.state);
  const pending = status.pendingVersions.length;
  return (
    <Panel selected={status.state === 'conflict'} aria-label={it.overview.stateTitle}>
      <div className={styles.hero} data-tone={meta.tone}>
        <div className={styles.main}>
          <SyncStateLamp state={status.state} size="lg" detail={status.state === 'offline' && pending > 0 ? `(${it.offlinePending(pending)})` : undefined} />
          <p className={styles.hint}>{it.syncStateHint[status.state]}</p>
          {status.error && <p className={styles.error}>{errorMessage(status.error)}</p>}
          {(status.state === 'publishing' || status.state === 'updating') && progress && <ProgressBar percent={progress.percent} label={progress.message} />}
        </div>
        <dl className={styles.facts}>
          <div>
            <dt>{it.overview.headVersion}</dt>
            <dd className="mono">{status.headVersion != null ? `v${status.headVersion}` : '—'}</dd>
          </div>
          <div>
            <dt>{it.overview.remoteVersion}</dt>
            <dd className="mono">{status.remoteVersion != null ? `v${status.remoteVersion}` : '—'}</dd>
          </div>
          <div>
            <dt>{it.overview.lastFetchLabel}</dt>
            <dd>{status.lastFetchAt ? formatRelative(status.lastFetchAt) : it.overview.never}</dd>
          </div>
          <div>
            <dt>{it.overview.lastPublishLabel}</dt>
            <dd>{status.lastPublishAt ? formatRelative(status.lastPublishAt) : it.overview.never}</dd>
          </div>
          <div>
            <dt>{it.overview.repoSize}</dt>
            <dd>{formatBytes(status.repoSizeBytes)}</dd>
          </div>
        </dl>
      </div>
    </Panel>
  );
}

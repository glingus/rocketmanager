import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { backend } from '../../lib/backend';
import type { ConflictFile, ResolutionChoice } from '../../lib/types/ipc';
import { qk } from '../../app/queryClient';
import { useProjectContext } from '../project/ProjectLayout';
import { Badge, Button, Check, ChevronLeft, CircleAlert, ConfirmDialog, EmptyState, GitMerge, Info, Panel, ShieldCheck, Switch, SkeletonLines, CircleCheck } from '../../ui';
import { ThreeWayTable } from './ThreeWayTable';
import { ChoicePanel } from './ChoicePanel';
import { buildConflictRows, summarizeRows } from '../../lib/utils/conflictRows';
import { useApiMutation } from '../../app/useApiMutation';
import { QueryErrorBox } from '../shared/QueryErrorBox';
import { formatRelative } from '../../lib/utils/format';
import { it } from '../../i18n/it';
import styles from './ConflictResolverPage.module.css';

export function ConflictResolverPage() {
  const { conflictId = '' } = useParams();
  const { project, linked } = useProjectContext();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: qk.conflict(project.id, conflictId), queryFn: () => backend.getConflict({ projectId: project.id, conflictId }), enabled: linked });
  const [active, setActive] = useState(0);
  const [choices, setChoices] = useState<Record<string, ResolutionChoice | undefined>>({});
  const [manualDone, setManualDone] = useState<Record<string, boolean>>({});
  const [onlyOverlaps, setOnlyOverlaps] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const resolve = useApiMutation(
    () =>
      backend.resolveConflict({
        projectId: project.id,
        conflictId,
        resolutions: (query.data?.files ?? []).map((f) => ({ path: f.path, choice: choices[f.path]! })),
      }),
    {
      errorTitle: it.conflicts.confirm,
      onSuccess: (s) => {
        qc.setQueryData(qk.status(project.id), s);
        void qc.invalidateQueries({ queryKey: qk.conflicts(project.id) });
        void qc.invalidateQueries({ queryKey: qk.versions(project.id) });
        setConfirming(false);
        navigate(`/p/${project.id}/history`);
      },
    },
  );

  const conflict = query.data;
  const files = conflict?.files ?? [];
  const file: ConflictFile | undefined = files[Math.min(active, files.length - 1)];
  const chosenCount = files.filter((f) => choices[f.path] && (choices[f.path] !== 'manual' || manualDone[f.path])).length;
  const allChosen = files.length > 0 && chosenCount === files.length;
  const rows = useMemo(() => (file?.threeWay ? buildConflictRows(file.threeWay) : []), [file]);
  const counts = summarizeRows(rows);

  if (!linked) return <EmptyState icon={<GitMerge />} title={it.project.onlyOnPcTitle} description={it.conflicts.cannotResolveHere} />;
  if (query.isLoading) return <SkeletonLines lines={8} />;
  if (query.isError || !conflict || !file) return <QueryErrorBox error={query.error} onRetry={() => void query.refetch()} />;
  const resolved = conflict.status === 'resolved';

  return (
    <div className={styles.page}>
      <div className={styles.top}>
        <Link to={`/p/${project.id}/conflicts`} className={styles.back}>
          <ChevronLeft size={16} /> {it.conflicts.backToList}
        </Link>
        <h2 className={styles.title}>
          <GitMerge size={26} />
          <span className={styles.titleFiles}>{files.map((f) => f.path).join(', ')}</span>
        </h2>
        <p className={styles.meta}>
          {it.conflicts.theirsBy(conflict.theirsAuthor ?? it.common.unknown, conflict.theirsVersion)} · {it.conflicts.detectedAt(formatRelative(conflict.createdAt))}
        </p>
      </div>

      <div className={styles.safe} role="note">
        <ShieldCheck size={22} />
        <div>
          <strong>{it.conflicts.safe}</strong>
          <p>{it.conflicts.safeText(conflict.remoteBranchPushed)}</p>
        </div>
      </div>

      {resolved && (
        <div className={styles.resolved}>
          <CircleCheck size={18} /> {it.conflicts.alreadyResolved}
        </div>
      )}

      {files.length > 1 && (
        <div role="tablist" aria-label={it.conflicts.title} className={styles.fileTabs}>
          {files.map((f, i) => {
            const done = !!choices[f.path] && (choices[f.path] !== 'manual' || manualDone[f.path]);
            return (
              <button key={f.path} type="button" role="tab" aria-selected={i === active} className={[styles.fileTab, i === active ? styles.fileTabActive : ''].join(' ')} onClick={() => setActive(i)}>
                {done ? <Check size={14} strokeWidth={3} /> : <CircleAlert size={14} />}
                {f.path}
              </button>
            );
          })}
        </div>
      )}

      <div className={styles.fileHead}>
        <div>
          <h3 className={styles.fileName}>{file.path}</h3>
          <Badge tone="red">{it.conflicts.kind[file.kind]}</Badge>
          {files.length > 1 && <span className={styles.fileOf}> {it.conflicts.fileOf(Math.min(active, files.length - 1) + 1, files.length)}</span>}
        </div>
        {file.threeWay && (
          <div className={styles.counts}>
            <Badge tone="blue">{it.conflicts.summary.mine(counts.mine)}</Badge>
            <Badge tone="brass">{it.conflicts.summary.theirs(counts.theirs)}</Badge>
            <Badge tone={counts.overlap > 0 ? 'red' : 'green'}>{it.conflicts.summary.overlap(counts.overlap)}</Badge>
          </div>
        )}
      </div>

      <div className={styles.grid}>
        <div className={styles.left}>
          {file.threeWay ? (
            <>
              {file.threeWay.independent ? (
                <div className={styles.independent}>
                  <Info size={18} />
                  <div>
                    <strong>{it.conflicts.independentTitle}</strong>
                    <p>{it.conflicts.independentText}</p>
                    <p>{it.conflicts.independentBoth}</p>
                  </div>
                </div>
              ) : (
                <div className={styles.overlapInfo}>
                  <CircleAlert size={18} />
                  <div>
                    <strong>{it.conflicts.overlapTitle}</strong>
                    <p>{it.conflicts.overlapText}</p>
                  </div>
                  <Switch checked={onlyOverlaps} onChange={setOnlyOverlaps} label={it.conflicts.onlyOverlaps} />
                </div>
              )}
              <ThreeWayTable threeWay={file.threeWay} onlyOverlaps={onlyOverlaps && !file.threeWay.independent} />
            </>
          ) : (
            <Panel title={it.conflicts.noSemantic}>
              <p className={styles.plain}>{it.conflicts.notReadable}</p>
            </Panel>
          )}
        </div>
        <div className={styles.right}>
          <ChoicePanel
            projectId={project.id}
            conflictId={conflict.id}
            file={file}
            choice={choices[file.path]}
            onChoice={(c) => setChoices((prev) => ({ ...prev, [file.path]: c }))}
            manualDone={!!manualDone[file.path]}
            onManualDone={(v) => setManualDone((prev) => ({ ...prev, [file.path]: v }))}
            disabled={resolved}
          />
        </div>
      </div>

      {!resolved && (
        <div className={styles.footer}>
          <p className={styles.status}>{allChosen ? it.conflicts.allChosen : it.conflicts.missingChoice(files.length - chosenCount)}</p>
          <p className={styles.snapshot}>{it.conflicts.snapshotNote}</p>
          <Button variant="primary" size="lg" icon={<GitMerge />} disabled={!allChosen} onClick={() => setConfirming(true)} data-testid="resolve-button">
            {it.conflicts.resolveAction}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={it.conflicts.confirmTitle}
        description={it.conflicts.confirmText}
        confirmLabel={it.conflicts.confirm}
        onConfirm={() => resolve.mutate(undefined)}
        loading={resolve.isPending}
        icon={<GitMerge />}
      >
        <div>
          <p className={styles.listLabel}>{it.conflicts.confirmList}</p>
          <ul className={styles.choiceList}>
            {files.map((f) => (
              <li key={f.path}>
                <span className="mono">{f.path}</span>
                <Badge tone="brass">{choices[f.path] ? it.conflicts.choice[choices[f.path]!] : '—'}</Badge>
              </li>
            ))}
          </ul>
        </div>
      </ConfirmDialog>
    </div>
  );
}


import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { backend } from '../../lib/backend';
import type { ProjectStatus, VersionInfo } from '../../lib/types/ipc';
import { Button, ConfirmDialog, Dialog, Field, Input, RotateCcw, Select, SegmentedControl, FolderOpen, toast, Check } from '../../ui';
import { it } from '../../i18n/it';
import { useApiMutation } from '../../app/useApiMutation';
import { qk } from '../../app/queryClient';
import styles from './ActionDialogs.module.css';

export function DownloadDialog({ projectId, version, defaultDir, open, onClose }: { projectId: string; version: VersionInfo; defaultDir: string | null; open: boolean; onClose: () => void }) {
  const [dest, setDest] = useState(defaultDir ?? '');
  const download = useApiMutation(() => backend.exportVersion({ projectId, sha: version.sha, destDir: dest }), {
    errorTitle: it.history.actions.downloadTitle,
    onSuccess: (written) => {
      toast.success(it.toasts.exported(written.length), { message: dest });
      onClose();
    },
  });
  const browse = async () => {
    const picked = await backend.pickFolder(dest || undefined);
    if (picked) setDest(picked);
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={it.history.actions.downloadTitle}
      description={it.history.actions.downloadText}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {it.common.cancel}
          </Button>
          <Button variant="primary" disabled={!dest.trim()} loading={download.isPending} onClick={() => download.mutate(undefined)}>
            {it.history.actions.download}
          </Button>
        </>
      }
    >
      <Field label={it.history.actions.destination}>
        {(p) => (
          <div className={styles.row}>
            <Input {...p} value={dest} onChange={(e) => setDest(e.target.value)} spellCheck={false} />
            <Button icon={<FolderOpen />} onClick={() => void browse()}>
              {it.onboarding.folders.browse}
            </Button>
          </div>
        )}
      </Field>
      <ul className={styles.files}>
        {version.files.map((f) => (
          <li key={f.path}>{f.path}</li>
        ))}
      </ul>
    </Dialog>
  );
}

export function RestoreDialog({
  projectId,
  version,
  nextNumber,
  status,
  open,
  onClose,
}: {
  projectId: string;
  version: VersionInfo;
  nextNumber: number;
  status: ProjectStatus | undefined;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [scope, setScope] = useState<'all' | 'file'>('all');
  const [path, setPath] = useState('');
  const files = version.files.map((f) => f.path);
  const allPaths = useAllPaths(projectId, version);
  const chosenPath = path || allPaths[0] || '';
  const conflict = (status?.openConflictIds.length ?? 0) > 0;
  const dirty = (status?.changedFiles.length ?? 0) > 0;
  const blockReason = conflict ? it.history.restore.blockedConflict : dirty ? it.history.restore.blockedUnpublished : null;
  void files;

  const restore = useApiMutation(
    () => backend.restoreVersion({ projectId, sha: version.sha, ...(scope === 'file' ? { paths: [chosenPath] } : {}) }),
    {
      errorTitle: it.history.actions.restore,
      onSuccess: (s) => {
        qc.setQueryData(qk.status(projectId), s);
        void qc.invalidateQueries({ queryKey: qk.versions(projectId) });
        void qc.invalidateQueries({ queryKey: qk.snapshots(projectId) });
        toast.success(it.toasts.restored(version.number ?? 0));
        onClose();
      },
    },
  );

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      icon={<RotateCcw />}
      title={it.history.restore.title(version.number ?? 0)}
      description={it.history.restore.text(version.number ?? 0)}
      confirmLabel={it.history.restore.confirm}
      onConfirm={() => restore.mutate(undefined)}
      loading={restore.isPending}
      confirmDisabled={!!blockReason}
      width={560}
    >
      <div className={styles.stack}>
        <div>
          <span className={styles.label}>{it.history.restore.scopeLabel}</span>
          <SegmentedControl
            label={it.history.restore.scopeLabel}
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: it.history.restore.scopeAll },
              { value: 'file', label: it.history.restore.scopeFile },
            ]}
          />
        </div>
        {scope === 'file' && (
          <Field label={it.history.actions.pickFile}>
            {(p) => (
              <Select {...p} value={chosenPath} onChange={(e) => setPath(e.target.value)}>
                {allPaths.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <div className={styles.callout}>
          <Check size={16} />
          <div>
            <span className={styles.calloutLabel}>{it.history.restore.willCreate}</span>
            <strong>
              v{nextNumber} · {it.history.restore.newTitle(version.number ?? 0)}
            </strong>
          </div>
        </div>
        {blockReason && <p className={styles.block}>{blockReason}</p>}
      </div>
    </ConfirmDialog>
  );
}


/** File paths available in a version, via a comparison with the empty initial version. */
function useAllPaths(projectId: string, version: VersionInfo): string[] {
  const q = useQuery({
    queryKey: ['version-paths', projectId, version.sha],
    queryFn: async () => {
      const versions = await backend.listVersions({ projectId });
      const init = versions.find((v) => v.kind === 'init');
      if (!init) return version.files.map((f) => f.path);
      const cmp = await backend.compareVersions({ projectId, fromSha: init.sha, toSha: version.sha });
      return cmp.files.map((f) => f.path);
    },
  });
  return q.data ?? version.files.map((f) => f.path);
}

export function OpenCopyDialog({ projectId, version, paths, open, onClose }: { projectId: string; version: VersionInfo; paths: string[]; open: boolean; onClose: () => void }) {
  const [path, setPath] = useState(paths[0] ?? '');
  const openCopy = useApiMutation((p: string) => backend.openVersionCopy({ projectId, sha: version.sha, path: p }), {
    errorTitle: it.history.actions.openCopy,
    onSuccess: () => {
      toast.success(it.toasts.openedCopy);
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={it.history.actions.openCopy}
      description={it.history.actions.openCopyHint}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {it.common.cancel}
          </Button>
          <Button variant="primary" loading={openCopy.isPending} onClick={() => openCopy.mutate(path)}>
            {it.common.open}
          </Button>
        </>
      }
    >
      <Field label={it.history.actions.pickFile}>
        {(p) => (
          <Select {...p} value={path} onChange={(e) => setPath(e.target.value)}>
            {paths.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </Dialog>
  );
}

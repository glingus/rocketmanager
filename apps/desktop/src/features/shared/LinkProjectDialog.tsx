import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { backend } from '../../lib/backend';
import type { Project } from '../../lib/types/data';
import { Dialog, Button, toast } from '../../ui';
import { LinkFolderForm, type FolderChoice } from './LinkFolderForm';
import { useApiMutation } from '../../app/useApiMutation';
import { qk } from '../../app/queryClient';
import { useUi } from '../../app/uiStore';
import { it } from '../../i18n/it';
import { ProgressBar } from './ProgressBar';

export function LinkProjectDialog({ project, open, onClose }: { project: Project; open: boolean; onClose: () => void }) {
  const [choice, setChoice] = useState<FolderChoice>({ path: '', check: null, acceptedDrive: false, ok: false });
  const qc = useQueryClient();
  const progress = useUi((s) => s.progress[project.id]);
  const link = useApiMutation(
    () => backend.linkProject({ projectId: project.id, repoFullName: `${project.githubOwner}/${project.githubRepo}`, folder: choice.path.trim() }),
    {
      errorTitle: it.errors.title,
      onSuccess: (status) => {
        qc.setQueryData(qk.status(project.id), status);
        void qc.invalidateQueries({ queryKey: qk.localProjects });
        void qc.invalidateQueries({ queryKey: qk.versions(project.id) });
        toast.success(it.toasts.linked(project.name), { message: status.folder ?? undefined });
        onClose();
      },
    },
  );
  return (
    <Dialog
      open={open}
      onClose={() => !link.isPending && onClose()}
      title={it.dashboard.link.title(project.name)}
      width={600}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={link.isPending}>
            {it.common.cancel}
          </Button>
          <Button variant="primary" disabled={!choice.ok || !choice.path.trim()} loading={link.isPending} onClick={() => link.mutate(undefined)}>
            {it.dashboard.link.confirm}
          </Button>
        </>
      }
    >
      <LinkFolderForm projectName={project.name} value={choice} onChange={setChoice} idPrefix="link" />
      {link.isPending && progress && <ProgressBar percent={progress.percent} label={progress.message} />}
    </Dialog>
  );
}

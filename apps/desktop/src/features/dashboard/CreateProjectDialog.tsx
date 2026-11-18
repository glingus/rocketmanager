import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { data } from '../../lib/data';
import { Dialog, Button, Field, Input, Textarea } from '../../ui';
import { useApiMutation } from '../../app/useApiMutation';
import { qk } from '../../app/queryClient';
import { it } from '../../i18n/it';

export function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const navigate = useNavigate();
  const create = useApiMutation(() => data.createProject({ name, description }), {
    invalidate: [qk.projects],
    successToast: (p) => it.onboarding.projects.createdToast(p.name),
    errorTitle: it.errors.title,
    onSuccess: (p) => {
      setName('');
      setDescription('');
      onClose();
      navigate(`/p/${p.id}/overview`);
    },
  });
  return (
    <Dialog
      open={open}
      onClose={() => !create.isPending && onClose()}
      title={it.onboarding.projects.createTitle}
      description={create.isPending ? it.onboarding.projects.creating : undefined}
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            {it.common.cancel}
          </Button>
          <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate(undefined)}>
            {it.common.create}
          </Button>
        </>
      }
    >
      <Field label={it.onboarding.projects.name}>
        {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder={it.onboarding.projects.namePlaceholder} maxLength={80} data-autofocus />}
      </Field>
      <Field label={it.onboarding.projects.description} optional>
        {(p) => <Textarea {...p} value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />}
      </Field>
    </Dialog>
  );
}

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { backend } from '../../lib/backend';
import { data } from '../../lib/data';
import type { PublishPolicy } from '../../lib/types/ipc';
import { qk } from '../../app/queryClient';
import { useProjectContext } from '../project/ProjectLayout';
import { useApiMutation } from '../../app/useApiMutation';
import { Badge, Button, Checkbox, ConfirmDialog, Field, Input, Lock, Panel, Send, Textarea, Unlink, toast, Trash2, Check } from '../../ui';
import { it } from '../../i18n/it';
import { QueryState } from '../../app/QueryState';
import styles from './SettingsPage.module.css';

const POLICY_MODES = ['assisted', 'manual', 'onSave'] as const;

export function ProjectSettingsPage() {
  const { project, isAdmin, linked } = useProjectContext();
  return (
    <div className={styles.page}>
      <div>
        <h2 className={styles.title}>{it.projectSettings.title}</h2>
        <p className={styles.subtitle}>{it.projectSettings.subtitle}</p>
      </div>
      {!isAdmin && (
        <div className={styles.readOnly} role="note" data-testid="readonly-note">
          <Lock size={16} /> {it.projectSettings.readOnlyNote}
        </div>
      )}
      <GeneralPanel projectId={project.id} isAdmin={isAdmin} />
      <PolicyPanel projectId={project.id} isAdmin={isAdmin} linked={linked} />
      <RetentionPanel projectId={project.id} isAdmin={isAdmin} />
      <DiscordPanel projectId={project.id} isAdmin={isAdmin} />
      {linked && <LocalPanel projectId={project.id} />}
    </div>
  );
}

function GeneralPanel({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const { project } = useProjectContext();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const save = useApiMutation(() => data.updateProject(projectId, { name, description }), {
    invalidate: [qk.projects],
    successToast: it.projectSettings.saved,
    errorTitle: it.projectSettings.general,
  });
  const dirty = name !== project.name || description !== project.description;
  return (
    <Panel title={it.projectSettings.general} actions={isAdmin ? <Button variant="primary" size="sm" disabled={!dirty || !name.trim()} loading={save.isPending} onClick={() => save.mutate(undefined)}>{it.common.save}</Button> : undefined}>
      <div className={styles.grid2}>
        <Field label={it.projectSettings.name}>{(p) => <Input {...p} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} disabled={!isAdmin} />}</Field>
        <Field label={it.projectSettings.repo}>
          {(p) => <Input {...p} value={`${project.githubOwner}/${project.githubRepo}`} readOnly className={styles.mono} />}
        </Field>
      </div>
      <Field label={it.projectSettings.description}>{(p) => <Textarea {...p} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!isAdmin} />}</Field>
    </Panel>
  );
}

function PolicyPanel({ projectId, isAdmin, linked }: { projectId: string; isAdmin: boolean; linked: boolean }) {
  const { project } = useProjectContext();
  const qc = useQueryClient();
  const current = project.settings.publishPolicy as PublishPolicy;
  const [policy, setPolicy] = useState<PublishPolicy>(current);
  useEffect(() => setPolicy(current), [JSON.stringify(current)]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useApiMutation(
    async () => {
      await data.updateProject(projectId, { settings: { publishPolicy: policy } });
      if (linked) await backend.setPublishPolicy({ projectId, policy });
    },
    {
      invalidate: [qk.projects, ['policy', projectId]],
      successToast: it.projectSettings.policy.saved,
      errorTitle: it.projectSettings.policy.title,
      onSuccess: () => void qc.invalidateQueries({ queryKey: qk.status(projectId) }),
    },
  );
  const dirty = JSON.stringify(policy) !== JSON.stringify(current);
  const setMode = (mode: PublishPolicy['mode']) => {
    if (mode === 'assisted') setPolicy({ mode, idleMinutes: 10 });
    else if (mode === 'onSave') setPolicy({ mode, minIntervalMinutes: 5 });
    else setPolicy({ mode: 'manual' });
  };
  const labels = {
    assisted: [it.projectSettings.policy.assisted, it.projectSettings.policy.assistedText],
    manual: [it.projectSettings.policy.manual, it.projectSettings.policy.manualText],
    onSave: [it.projectSettings.policy.onSave, it.projectSettings.policy.onSaveText],
  } as const;

  return (
    <Panel
      title={it.projectSettings.policy.title}
      subtitle={it.projectSettings.policy.text}
      actions={isAdmin ? <Button variant="primary" size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(undefined)}>{it.common.save}</Button> : undefined}
    >
      <div role="radiogroup" aria-label={it.projectSettings.policy.title} className={styles.policyGrid}>
        {POLICY_MODES.map((mode) => (
          <label key={mode} className={[styles.policy, policy.mode === mode ? styles.policyOn : ''].join(' ')}>
            <input type="radio" name="policy" checked={policy.mode === mode} onChange={() => setMode(mode)} disabled={!isAdmin} />
            <span className={styles.policyHead}>
              <span className={styles.radio} aria-hidden="true">{policy.mode === mode && <Check size={12} strokeWidth={3.4} />}</span>
              <strong>{labels[mode][0]}</strong>
              {mode === 'assisted' && <Badge tone="brass">consigliata</Badge>}
            </span>
            <span className={styles.policyText}>{labels[mode][1]}</span>
          </label>
        ))}
      </div>
      {policy.mode === 'assisted' && (
        <Field label={it.projectSettings.policy.idleMinutes} className={styles.inline}>
          {(p) => <Input {...p} type="number" min={1} max={240} value={policy.mode === 'assisted' ? policy.idleMinutes : 10} disabled={!isAdmin} onChange={(e) => setPolicy({ mode: 'assisted', idleMinutes: Math.max(1, Number(e.target.value) || 1) })} />}
        </Field>
      )}
      {policy.mode === 'onSave' && (
        <Field label={it.projectSettings.policy.minInterval} className={styles.inline}>
          {(p) => <Input {...p} type="number" min={1} max={240} value={policy.mode === 'onSave' ? policy.minIntervalMinutes : 5} disabled={!isAdmin} onChange={(e) => setPolicy({ mode: 'onSave', minIntervalMinutes: Math.max(1, Number(e.target.value) || 1) })} />}
        </Field>
      )}
    </Panel>
  );
}

function RetentionPanel({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const { project } = useProjectContext();
  const [value, setValue] = useState(project.settings.activityRetention);
  const save = useApiMutation(() => data.updateProject(projectId, { settings: { activityRetention: value } }), {
    invalidate: [qk.projects, ['activity', projectId]],
    successToast: it.projectSettings.retention.saved,
    errorTitle: it.projectSettings.retention.title,
  });
  return (
    <Panel
      title={it.projectSettings.retention.title}
      subtitle={it.projectSettings.retention.text}
      actions={isAdmin ? <Button variant="primary" size="sm" disabled={value === project.settings.activityRetention || value < 10} loading={save.isPending} onClick={() => save.mutate(undefined)}>{it.common.save}</Button> : undefined}
    >
      <Field label={it.projectSettings.retention.label} className={styles.inline}>
        {(p) => <Input {...p} type="number" min={10} max={2000} step={10} value={value} disabled={!isAdmin} onChange={(e) => setValue(Number(e.target.value) || 0)} />}
      </Field>
    </Panel>
  );
}

function DiscordPanel({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const [url, setUrl] = useState('');
  const [removing, setRemoving] = useState(false);
  const settings = useQuery({ queryKey: qk.discord(projectId), queryFn: () => data.getDiscordSettings(projectId) });
  const eventTypes = useQuery({ queryKey: qk.eventTypes, queryFn: () => data.listEventTypes(), staleTime: Infinity });
  const [enabled, setEnabled] = useState<string[] | null>(null);
  useEffect(() => {
    if (settings.data) setEnabled(settings.data.enabledEventTypes);
  }, [settings.data]);

  const saveTypes = useApiMutation(() => data.setDiscordEventTypes(projectId, enabled ?? []), { invalidate: [qk.discord(projectId)], successToast: it.projectSettings.discord.eventsSaved, errorTitle: it.projectSettings.discord.events });
  const saveHook = useApiMutation(() => data.setDiscordWebhook(projectId, url.trim()), {
    invalidate: [qk.discord(projectId)],
    successToast: it.projectSettings.discord.saved,
    errorTitle: it.projectSettings.discord.webhook,
    onSuccess: () => setUrl(''),
  });
  const removeHook = useApiMutation(() => data.setDiscordWebhook(projectId, null), {
    invalidate: [qk.discord(projectId)],
    successToast: it.projectSettings.discord.removed,
    errorTitle: it.projectSettings.discord.webhook,
    onSuccess: () => setRemoving(false),
  });
  const test = useApiMutation(() => data.sendDiscordTest(projectId), { successToast: it.projectSettings.discord.testSent, errorTitle: it.projectSettings.discord.test });

  const projectTypes = (eventTypes.data ?? []).filter((t) => t.audience === 'project' && t.notify);
  const dirty = settings.data && enabled && [...enabled].sort().join() !== [...settings.data.enabledEventTypes].sort().join();

  return (
    <Panel title={it.projectSettings.discord.title} subtitle={it.projectSettings.discord.text}>
      <QueryState query={settings} lines={3}>
        {(s) => (
          <div className={styles.discord}>
            <div className={styles.webhookRow}>
              <Badge tone={s.webhookConfigured ? 'green' : 'neutral'} icon={s.webhookConfigured ? <Check /> : undefined}>
                {s.webhookConfigured ? it.projectSettings.discord.configured : it.projectSettings.discord.notConfigured}
              </Badge>
              {s.webhookConfigured && <span className={styles.hint}>{it.projectSettings.discord.configuredHint}</span>}
            </div>
            {isAdmin ? (
              <div className={styles.webhookForm}>
                <Field label={it.projectSettings.discord.urlLabel} hint={it.projectSettings.discord.urlHint}>
                  {(p) => <Input {...p} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={it.projectSettings.discord.urlPlaceholder} spellCheck={false} data-testid="webhook-url" />}
                </Field>
                <div className={styles.btnRow}>
                  <Button variant="primary" disabled={!url.trim()} loading={saveHook.isPending} onClick={() => saveHook.mutate(undefined)}>
                    {s.webhookConfigured ? it.projectSettings.discord.replace : it.projectSettings.discord.save}
                  </Button>
                  <Button icon={<Send />} disabled={!s.webhookConfigured} title={s.webhookConfigured ? undefined : it.projectSettings.discord.testNeedsWebhook} loading={test.isPending} onClick={() => test.mutate(undefined)} data-testid="discord-test">
                    {it.projectSettings.discord.test}
                  </Button>
                  {s.webhookConfigured && (
                    <Button variant="ghost" icon={<Trash2 />} onClick={() => setRemoving(true)}>
                      {it.projectSettings.discord.remove}
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <p className={styles.hint}>
                <Lock size={13} /> {it.projectSettings.discord.onlyAdmin}
              </p>
            )}

            <div>
              <h3 className={styles.subTitle}>{it.projectSettings.discord.events}</h3>
              <div className={styles.eventGrid}>
                {projectTypes.map((t) => (
                  <Checkbox
                    key={t.type}
                    label={t.labelIt}
                    disabled={!isAdmin}
                    checked={enabled?.includes(t.type) ?? false}
                    onChange={(e) => setEnabled((cur) => (e.target.checked ? [...(cur ?? []), t.type] : (cur ?? []).filter((x) => x !== t.type)))}
                  />
                ))}
              </div>
              {isAdmin && (
                <div className={styles.btnRow}>
                  <Button size="sm" variant="primary" disabled={!dirty} loading={saveTypes.isPending} onClick={() => saveTypes.mutate(undefined)}>
                    {it.common.save}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </QueryState>
      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        tone="danger"
        title={it.projectSettings.discord.removeTitle}
        description={it.projectSettings.discord.removeText}
        confirmLabel={it.projectSettings.discord.remove}
        onConfirm={() => removeHook.mutate(undefined)}
        loading={removeHook.isPending}
      />
    </Panel>
  );
}

function LocalPanel({ projectId }: { projectId: string }) {
  const [confirm, setConfirm] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const unlink = useApiMutation(() => backend.unlinkProject(projectId), {
    errorTitle: it.projectSettings.danger.unlink,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.localProjects });
      void qc.invalidateQueries({ queryKey: qk.status(projectId) });
      toast.success(it.projectSettings.danger.unlinked);
      setConfirm(false);
      navigate('/');
    },
  });
  return (
    <Panel title={it.projectSettings.danger.title}>
      <Button icon={<Unlink />} onClick={() => setConfirm(true)}>
        {it.projectSettings.danger.unlink}
      </Button>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        tone="danger"
        title={it.projectSettings.danger.unlinkTitle}
        description={it.projectSettings.danger.unlinkText}
        confirmLabel={it.projectSettings.danger.unlinkConfirm}
        onConfirm={() => unlink.mutate(undefined)}
        loading={unlink.isPending}
      />
    </Panel>
  );
}


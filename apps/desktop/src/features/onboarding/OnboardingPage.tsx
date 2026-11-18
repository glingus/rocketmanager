import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { backend } from '../../lib/backend';
import { data } from '../../lib/data';
import type { Project } from '../../lib/types/data';
import type { AppSettings, PublishPolicy } from '../../lib/types/ipc';
import { useSession } from '../../app/session';
import { useUi } from '../../app/uiStore';
import { qk } from '../../app/queryClient';
import { errorMessage } from '../../app/errors';
import { LogoMark } from '../../app/Logo';
import { Avatar, Badge, Button, Check, CircleAlert, Checkbox, Field, GithubMark, Input, Plus, Rocket, Select, Spinner, Switch, Textarea, TriangleAlert, toast, ChevronLeft } from '../../ui';
import { LinkFolderForm, type FolderChoice } from '../shared/LinkFolderForm';
import { ProgressBar } from '../shared/ProgressBar';
import { it } from '../../i18n/it';
import styles from './OnboardingPage.module.css';

const AVATAR_COLORS = ['#a8503a', '#4d6f8a', '#6b7f3a', '#7a4a78', '#b07a1a', '#2f7d74', '#8a3b3b', '#56606e'];
const STEP_COUNT = 8;

type LinkState = 'waiting' | 'working' | 'done' | 'failed';

export function OnboardingPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { auth, setAuth, setOnboarded } = useSession();
  const [step, setStep] = useState(() => (auth?.signedIn ? 2 : 0));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [folders, setFolders] = useState<Record<string, FolderChoice>>({});
  const [linkState, setLinkState] = useState<Record<string, LinkState>>({});
  const [linkErrors, setLinkErrors] = useState<Record<string, string>>({});
  const [projectsCache, setProjectsCache] = useState<Project[]>([]);

  const signedIn = !!auth?.signedIn;

  const next = () => setStep((s) => Math.min(STEP_COUNT - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  const finish = () => {
    setOnboarded(true);
    void qc.invalidateQueries();
    navigate('/', { replace: true });
  };

  return (
    <div className={styles.root}>
      <aside className={[styles.rail, 'on-wood'].join(' ')}>
        <div className={styles.brand}>
          <LogoMark size={40} />
          <span>
            Rocket <b>Sync</b>
          </span>
        </div>
        <p className={styles.tagline}>{it.tagline}</p>
        <ol className={styles.steps} aria-label={it.onboarding.stepsLabel}>
          {it.onboarding.steps.map((label, i) => (
            <li key={label} className={[styles.stepItem, i === step ? styles.current : '', i < step ? styles.past : ''].join(' ')} aria-current={i === step ? 'step' : undefined}>
              <span className={styles.stepNum}>{i < step ? <Check size={14} strokeWidth={3.4} /> : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      </aside>
      <main className={styles.main}>
        <div className={styles.card} data-testid={`onboarding-step-${step}`}>
          {step === 0 && <EnvStep onNext={next} />}
          {step === 1 && (
            <AuthStep
              signedIn={signedIn}
              onSignedIn={(a) => setAuth(a)}
              onNext={next}
            />
          )}
          {step === 2 && <ProfileStep onBack={back} onNext={next} />}
          {step === 3 && (
            <ProjectsStep
              selected={selected}
              setSelected={setSelected}
              onProjects={setProjectsCache}
              onBack={back}
              onNext={next}
            />
          )}
          {step === 4 && <FoldersStep projects={projectsCache.filter((p) => selected.has(p.id))} folders={folders} setFolders={setFolders} onBack={back} onNext={next} />}
          {step === 5 && (
            <SyncStep
              projects={projectsCache.filter((p) => selected.has(p.id))}
              folders={folders}
              state={linkState}
              setState={setLinkState}
              errors={linkErrors}
              setErrors={setLinkErrors}
              onNext={next}
              onBack={() => setStep(4)}
            />
          )}
          {step === 6 && <PrefsStep linked={projectsCache.filter((p) => linkState[p.id] === 'done')} onBack={back} onNext={next} />}
          {step === 7 && <DoneStep onFinish={finish} />}
        </div>
      </main>
    </div>
  );
}

function StepHead({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className={styles.head}>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </header>
  );
}

function Nav({ onBack, onNext, nextLabel = it.common.continue, nextDisabled, loading, hideBack }: { onBack?: () => void; onNext: () => void; nextLabel?: string; nextDisabled?: boolean; loading?: boolean; hideBack?: boolean }) {
  return (
    <footer className={styles.nav}>
      {!hideBack && onBack ? (
        <Button variant="ghost" icon={<ChevronLeft />} onClick={onBack}>
          {it.common.back}
        </Button>
      ) : (
        <span />
      )}
      <Button variant="primary" size="lg" onClick={onNext} disabled={nextDisabled} loading={loading} data-testid="step-next">
        {nextLabel}
      </Button>
    </footer>
  );
}

function CheckRow({ ok, warn, title, text }: { ok: boolean | null; warn?: boolean; title: string; text: string }) {
  return (
    <li className={styles.checkRow} data-state={ok == null ? 'wait' : ok ? 'ok' : warn ? 'warn' : 'bad'}>
      <span className={styles.checkIcon}>{ok == null ? <Spinner size={16} /> : ok ? <Check size={16} strokeWidth={3} /> : <TriangleAlert size={16} />}</span>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </li>
  );
}

function EnvStep({ onNext }: { onNext: () => void }) {
  const info = useQuery({ queryKey: qk.appInfo, queryFn: () => backend.getAppInfo(), staleTime: 0 });
  const online = typeof navigator === 'undefined' ? true : navigator.onLine;
  const git = info.data ? info.data.gitVersion.length > 0 : null;
  return (
    <>
      <StepHead title={it.onboarding.welcomeTitle} subtitle={it.onboarding.welcomeText} />
      <h2 className={styles.sub}>{it.onboarding.env.title}</h2>
      <ul className={styles.checks}>
        <CheckRow ok={info.isLoading ? null : git} title={it.onboarding.env.git} text={info.data ? (git ? it.onboarding.env.gitOk(info.data.gitVersion) : it.onboarding.env.gitMissing) : it.onboarding.env.checking} />
        <CheckRow
          ok={info.isLoading ? null : !!info.data?.openRocket.found}
          warn
          title={it.onboarding.env.openRocket}
          text={info.data ? (info.data.openRocket.found ? it.onboarding.env.openRocketOk(info.data.openRocket.version) : it.onboarding.env.openRocketMissing) : it.onboarding.env.checking}
        />
        <CheckRow ok={online} warn title={it.onboarding.env.network} text={online ? it.onboarding.env.networkOk : it.onboarding.env.networkOffline} />
      </ul>
      <div className={styles.inlineActions}>
        <Button size="sm" onClick={() => void info.refetch()} loading={info.isFetching}>
          {it.onboarding.env.recheck}
        </Button>
      </div>
      <Nav hideBack onNext={onNext} nextDisabled={info.isLoading || git === false} />
    </>
  );
}

function AuthStep({ signedIn, onSignedIn, onNext }: { signedIn: boolean; onSignedIn: (a: Awaited<ReturnType<typeof backend.authSignIn>>) => void; onNext: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const auth = useSession((s) => s.auth);
  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const status = await backend.authSignIn();
      if (status.supabaseSession) await data.setSession(status.supabaseSession);
      await data.acceptInvitations().catch(() => 0);
      onSignedIn(status);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <StepHead title={it.onboarding.auth.title} subtitle={it.onboarding.auth.subtitle} />
      <div className={styles.authBox}>
        {signedIn ? (
          <p className={styles.success}>
            <Check size={18} strokeWidth={3} /> {it.onboarding.auth.success(auth?.user?.name ?? '')}
          </p>
        ) : (
          <Button variant="primary" size="lg" icon={busy ? undefined : <GithubMark />} loading={busy} onClick={() => void signIn()} data-testid="github-signin">
            {busy ? it.onboarding.auth.waiting : it.onboarding.auth.button}
          </Button>
        )}
        {busy && <p className={styles.muted}>{it.onboarding.auth.waitingText}</p>}
        {error && (
          <p className={styles.errorLine} role="alert">
            <CircleAlert size={16} /> {it.onboarding.auth.failed}: {error}
          </p>
        )}
        <p className={styles.privacy}>{it.onboarding.auth.privacy}</p>
      </div>
      <Nav hideBack onNext={onNext} nextDisabled={!signedIn} />
    </>
  );
}

function ProfileStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const profile = useQuery({ queryKey: qk.me, queryFn: () => data.getMyProfile() });
  const [name, setName] = useState('');
  const [color, setColor] = useState(AVATAR_COLORS[0]!);
  const [saving, setSaving] = useState(false);
  const loaded = useRef(false);
  useEffect(() => {
    if (profile.data && !loaded.current) {
      loaded.current = true;
      setName(profile.data.displayName);
      setColor(profile.data.avatarColor ?? AVATAR_COLORS[0]!);
    }
  }, [profile.data]);
  const save = async () => {
    setSaving(true);
    try {
      await data.updateMyProfile({ displayName: name.trim(), avatarColor: color });
      onNext();
    } catch (e) {
      toast.error(it.errors.title, { message: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <StepHead title={it.onboarding.profile.title} subtitle={it.onboarding.profile.subtitle} />
      <div className={styles.profile}>
        <div className={styles.profileForm}>
          <Field label={it.onboarding.profile.displayName} hint={it.onboarding.profile.displayNameHint}>
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />}
          </Field>
          <div>
            <span className={styles.label}>{it.onboarding.profile.color}</span>
            <div className={styles.colors} role="radiogroup" aria-label={it.onboarding.profile.color}>
              {AVATAR_COLORS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} onClick={() => setColor(c)} className={[styles.colorDot, color === c ? styles.colorOn : ''].join(' ')} style={{ background: c }} />
              ))}
            </div>
          </div>
          <p className={styles.muted}>
            {it.onboarding.profile.githubLogin}: <code>@{profile.data?.githubLogin}</code>
          </p>
        </div>
        <div className={styles.preview}>
          <span className={styles.label}>{it.onboarding.profile.preview}</span>
          <Avatar name={name || '?'} color={color} size={72} />
          <strong>{name}</strong>
        </div>
      </div>
      <Nav onBack={onBack} onNext={() => void save()} nextDisabled={!name.trim() || profile.isLoading} loading={saving} />
    </>
  );
}

function ProjectsStep({ selected, setSelected, onProjects, onBack, onNext }: { selected: Set<string>; setSelected: (s: Set<string>) => void; onProjects: (p: Project[]) => void; onBack: () => void; onNext: () => void }) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: qk.projects, queryFn: () => data.listProjects() });
  const versions = useQuery({
    queryKey: ['onboarding-versions', (query.data ?? []).map((p) => p.id).join(',')],
    enabled: !!query.data,
    queryFn: async () => {
      const out: Record<string, number | null> = {};
      for (const p of query.data ?? []) out[p.id] = (await data.listIndexedVersions(p.id, 1))[0]?.number ?? null;
      return out;
    },
  });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const seeded = useRef(false);

  useEffect(() => {
    if (!query.data) return;
    onProjects(query.data);
    if (!seeded.current && query.data.length > 0) {
      seeded.current = true;
      setSelected(new Set(query.data.map((p) => p.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data]);

  const toggle = (id: string) => {
    const nextSet = new Set(selected);
    if (nextSet.has(id)) nextSet.delete(id);
    else nextSet.add(id);
    setSelected(nextSet);
  };

  const create = async () => {
    setBusy(true);
    try {
      const p = await data.createProject({ name, description });
      await qc.invalidateQueries({ queryKey: qk.projects });
      setSelected(new Set([...selected, p.id]));
      toast.success(it.onboarding.projects.createdToast(p.name));
      setCreating(false);
      setName('');
      setDescription('');
      setImporting(false);
    } catch (e) {
      toast.error(it.errors.title, { message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  const list = query.data ?? [];
  return (
    <>
      <StepHead title={it.onboarding.projects.title} subtitle={it.onboarding.projects.subtitle} />
      {query.isLoading ? (
        <p className={styles.muted}>{it.common.loading}</p>
      ) : list.length === 0 && !creating ? (
        <div className={styles.emptyBox}>
          <Rocket size={28} />
          <strong>{it.onboarding.projects.empty}</strong>
          <p>{it.onboarding.projects.emptyText}</p>
        </div>
      ) : (
        <ul className={styles.projectList} aria-label={it.onboarding.projects.yours}>
          {list.map((p) => (
            <li key={p.id}>
              <label className={[styles.projectRow, selected.has(p.id) ? styles.projectOn : ''].join(' ')}>
                <Checkbox label={<span className="visually-hidden">{p.name}</span>} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                <span className={styles.projectText}>
                  <strong>{p.name}</strong>
                  <span>{p.description}</span>
                </span>
                <Badge tone="neutral">{it.onboarding.projects.lastVersion(versions.data?.[p.id] ?? null)}</Badge>
                <Badge tone={p.myRole === 'admin' ? 'brass' : 'neutral'}>{it.onboarding.projects.role[p.myRole]}</Badge>
              </label>
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <div className={styles.createBox}>
          <h2 className={styles.sub}>{it.onboarding.projects.createTitle}</h2>
          <Field label={it.onboarding.projects.name}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder={it.onboarding.projects.namePlaceholder} maxLength={80} data-testid="new-project-name" />}</Field>
          <Field label={it.onboarding.projects.description} optional>
            {(p) => <Textarea {...p} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <Checkbox label={it.onboarding.projects.importExisting} checked={importing} onChange={(e) => setImporting(e.target.checked)} />
          {importing && <p className={styles.muted}>{it.onboarding.projects.importHint}</p>}
          <div className={styles.inlineActions}>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={busy}>
              {it.common.cancel}
            </Button>
            <Button variant="primary" disabled={!name.trim()} loading={busy} onClick={() => void create()} data-testid="create-project">
              {busy ? it.onboarding.projects.creating : it.common.create}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.inlineActions}>
          <Button icon={<Plus />} onClick={() => setCreating(true)} data-testid="new-project">
            {it.onboarding.projects.createToggle}
          </Button>
          <span className={styles.muted}>{it.onboarding.projects.selectedCount(selected.size)}</span>
        </div>
      )}
      {selected.size === 0 && !creating && <p className={styles.muted}>{it.onboarding.projects.needOne}</p>}
      <Nav onBack={onBack} onNext={onNext} nextDisabled={selected.size === 0 || creating} />
    </>
  );
}

function FoldersStep({ projects, folders, setFolders, onBack, onNext }: { projects: Project[]; folders: Record<string, FolderChoice>; setFolders: (f: Record<string, FolderChoice>) => void; onBack: () => void; onNext: () => void }) {
  const [local, setLocal] = useState(folders);
  const set = (id: string) => (c: FolderChoice) =>
    setLocal((prev) => {
      const nextState = { ...prev, [id]: c };
      return nextState;
    });
  useEffect(() => setFolders(local), [local]); // eslint-disable-line react-hooks/exhaustive-deps
  const allOk = projects.every((p) => local[p.id]?.ok && local[p.id]?.path.trim());
  return (
    <>
      <StepHead title={it.onboarding.folders.title} subtitle={it.onboarding.folders.subtitle} />
      <div className={styles.folderList}>
        {projects.map((p) => (
          <section key={p.id} className={styles.folderCard}>
            <h2 className={styles.sub}>{p.name}</h2>
            <LinkFolderForm projectName={p.name} idPrefix={`f-${p.id}`} value={local[p.id] ?? { path: '', check: null, acceptedDrive: false, ok: false }} onChange={set(p.id)} />
          </section>
        ))}
      </div>
      <Nav onBack={onBack} onNext={onNext} nextDisabled={!allOk} />
    </>
  );
}

function SyncStep({
  projects,
  folders,
  state,
  setState,
  errors,
  setErrors,
  onNext,
  onBack,
}: {
  projects: Project[];
  folders: Record<string, FolderChoice>;
  state: Record<string, LinkState>;
  setState: (s: Record<string, LinkState> | ((p: Record<string, LinkState>) => Record<string, LinkState>)) => void;
  errors: Record<string, string>;
  setErrors: (e: Record<string, string>) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const progress = useUi((s) => s.progress);
  const started = useRef(false);
  const [running, setRunning] = useState(false);

  // The app shell (with its EventBridge) is not mounted yet: listen to the progress events here.
  useEffect(() => backend.on('operation-progress', (p) => useUi.getState().setProgress(p)), []);

  const run = async () => {
    setRunning(true);
    const nextErrors: Record<string, string> = {};
    for (const p of projects) {
      if (state[p.id] === 'done') continue;
      setState((s) => ({ ...s, [p.id]: 'working' }));
      try {
        await backend.linkProject({ projectId: p.id, repoFullName: `${p.githubOwner}/${p.githubRepo}`, folder: folders[p.id]!.path.trim() });
        setState((s) => ({ ...s, [p.id]: 'done' }));
      } catch (e) {
        nextErrors[p.id] = errorMessage(e);
        setState((s) => ({ ...s, [p.id]: 'failed' }));
      }
    }
    setErrors(nextErrors);
    setRunning(false);
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (projects.some((p) => state[p.id] !== 'done')) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const states = projects.map((p) => state[p.id] ?? 'waiting');
  const allDone = states.length > 0 && states.every((s) => s === 'done');
  const anyFailed = states.some((s) => s === 'failed');
  const label: Record<LinkState, string> = { waiting: it.onboarding.sync.waiting, working: it.onboarding.sync.working, done: it.onboarding.sync.done, failed: it.onboarding.sync.failed };

  return (
    <>
      <StepHead title={it.onboarding.sync.title} subtitle={it.onboarding.sync.subtitle} />
      <ul className={styles.syncList}>
        {projects.map((p) => {
          const st = state[p.id] ?? 'waiting';
          const pr = progress[p.id];
          return (
            <li key={p.id} className={styles.syncRow} data-state={st}>
              <div className={styles.syncHead}>
                <strong>{p.name}</strong>
                <Badge tone={st === 'done' ? 'green' : st === 'failed' ? 'red' : st === 'working' ? 'amber' : 'neutral'} icon={st === 'done' ? <Check /> : st === 'failed' ? <CircleAlert /> : undefined}>
                  {label[st]}
                </Badge>
              </div>
              {st === 'working' && <ProgressBar percent={pr?.percent ?? null} label={pr?.message ?? it.onboarding.sync.working} />}
              {st === 'done' && <ProgressBar percent={100} />}
              {st === 'failed' && <p className={styles.errorLine}>{errors[p.id]}</p>}
            </li>
          );
        })}
      </ul>
      {allDone && <p className={styles.success}><Check size={18} strokeWidth={3} /> {it.onboarding.sync.allDone}</p>}
      {anyFailed && !running && (
        <div className={styles.inlineActions}>
          <p className={styles.muted}>{it.onboarding.sync.someFailed}</p>
          <Button onClick={() => void run()}>{it.common.retry}</Button>
        </div>
      )}
      <Nav onBack={onBack} hideBack={running} onNext={onNext} nextDisabled={running || (!allDone && !anyFailed)} />
    </>
  );
}

function PrefsStep({ linked, onBack, onNext }: { linked: Project[]; onBack: () => void; onNext: () => void }) {
  const [autostart, setAutostart] = useState(true);
  const [notifications, setNotifications] = useState(true);
  const [mode, setMode] = useState<PublishPolicy['mode']>('assisted');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const current = await backend.getAppSettings();
      const settings: AppSettings = { ...current, autostart, desktopNotifications: notifications };
      await backend.setAppSettings(settings);
      const policy: PublishPolicy = mode === 'assisted' ? { mode, idleMinutes: 10 } : mode === 'onSave' ? { mode, minIntervalMinutes: 5 } : { mode: 'manual' };
      const mine = (await data.listProjects()).filter((p) => linked.some((l) => l.id === p.id));
      for (const p of mine) {
        await backend.setPublishPolicy({ projectId: p.id, policy }).catch(() => undefined);
        if (p.myRole === 'admin') await data.updateProject(p.id, { settings: { publishPolicy: policy } }).catch(() => undefined);
      }
      onNext();
    } catch (e) {
      toast.error(it.errors.title, { message: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <StepHead title={it.onboarding.prefs.title} subtitle={it.onboarding.prefs.subtitle} />
      <div className={styles.prefs}>
        <Switch checked={autostart} onChange={setAutostart} label={it.onboarding.prefs.autostart} description={it.onboarding.prefs.autostartHint} />
        <Switch checked={notifications} onChange={setNotifications} label={it.onboarding.prefs.notifications} description={it.onboarding.prefs.notificationsHint} />
        <Field label={it.onboarding.prefs.policy} hint={it.onboarding.prefs.policyHint}>
          {(p) => (
            <Select {...p} value={mode} onChange={(e) => setMode(e.target.value as PublishPolicy['mode'])}>
              <option value="assisted">{it.projectSettings.policy.assisted}</option>
              <option value="manual">{it.projectSettings.policy.manual}</option>
              <option value="onSave">{it.projectSettings.policy.onSave}</option>
            </Select>
          )}
        </Field>
      </div>
      <Nav onBack={onBack} onNext={() => void save()} loading={saving} />
    </>
  );
}

function DoneStep({ onFinish }: { onFinish: () => void }) {
  return (
    <>
      <StepHead title={it.onboarding.done.title} subtitle={it.onboarding.done.subtitle} />
      <ul className={styles.tips}>
        {it.onboarding.done.tips.map((t) => (
          <li key={t}>
            <Check size={16} strokeWidth={3} /> {t}
          </li>
        ))}
      </ul>
      <Nav hideBack onNext={onFinish} nextLabel={it.onboarding.done.openDashboard} />
    </>
  );
}


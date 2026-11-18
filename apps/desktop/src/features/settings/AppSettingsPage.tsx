import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { backend } from '../../lib/backend';
import { data } from '../../lib/data';
import type { AppSettings } from '../../lib/types/ipc';
import { qk } from '../../app/queryClient';
import { PageHeader } from '../../app/PageHeader';
import { useAppInfo, useMyProfile } from '../../app/hooks';
import { useSession } from '../../app/session';
import { useApiMutation } from '../../app/useApiMutation';
import { Avatar, Badge, Button, ConfirmDialog, Download, Field, Input, LogOut, Panel, RefreshCw, Select, Switch, GithubMark, toast, Info, SkeletonLines } from '../../ui';
import { it } from '../../i18n/it';
import { QueryState } from '../../app/QueryState';
import styles from './SettingsPage.module.css';

const AVATAR_COLORS = ['#a8503a', '#4d6f8a', '#6b7f3a', '#7a4a78', '#b07a1a', '#2f7d74', '#8a3b3b', '#56606e'];

export function AppSettingsPage() {
  return (
    <div className={styles.pageWrap}>
      <PageHeader eyebrow={it.appName} title={it.appSettings.title} subtitle={it.appSettings.subtitle} />
      <div className={styles.scroll}>
        <div className={styles.page}>
          <AppPanel />
          <NotificationPrefs />
          <AccountPanel />
          <UpdatesPanel />
          <DiagnosticsPanel />
          {backend.kind === 'mock' && (
            <div className={styles.notes} role="note">
              <strong>{it.appSettings.mock.title}</strong>
              <p>{it.appSettings.mock.text}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AppPanel() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: qk.appSettings, queryFn: () => backend.getAppSettings() });
  const save = useApiMutation((s: AppSettings) => backend.setAppSettings(s), {
    errorTitle: it.appSettings.app.title,
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.appSettings }),
  });
  const set = (patch: Partial<AppSettings>) => {
    if (!query.data) return;
    const next = { ...query.data, ...patch };
    qc.setQueryData(qk.appSettings, next);
    save.mutate(next);
  };
  return (
    <Panel title={it.appSettings.app.title}>
      <QueryState query={query} lines={4}>
        {(s) => (
          <div className={styles.switchList}>
            <Switch checked={s.autostart} onChange={(v) => set({ autostart: v })} label={it.appSettings.app.autostart} description={it.appSettings.app.autostartHint} />
            <Switch checked={s.desktopNotifications} onChange={(v) => set({ desktopNotifications: v })} label={it.appSettings.app.desktopNotifications} description={it.appSettings.app.desktopNotificationsHint} />
            <Switch checked={s.minimizeToTray} onChange={(v) => set({ minimizeToTray: v })} label={it.appSettings.app.minimizeToTray} description={it.appSettings.app.minimizeToTrayHint} />
            <Field label={it.appSettings.app.fetchInterval} hint={it.appSettings.app.fetchIntervalHint} className={styles.inline}>
              {(p) => (
                <Select {...p} value={s.fetchIntervalSeconds} onChange={(e) => set({ fetchIntervalSeconds: Number(e.target.value) })}>
                  {[30, 60, 120, 300].map((n) => (
                    <option key={n} value={n}>
                      {it.appSettings.app.seconds(n)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        )}
      </QueryState>
    </Panel>
  );
}

function NotificationPrefs() {
  const qc = useQueryClient();
  const types = useQuery({ queryKey: qk.eventTypes, queryFn: () => data.listEventTypes(), staleTime: Infinity });
  const prefs = useQuery({ queryKey: qk.preferences, queryFn: () => data.listPreferences() });
  const save = useApiMutation((p: { eventType: string; inApp: boolean; desktop: boolean }) => data.setPreference(p), {
    errorTitle: it.appSettings.notifications.title,
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.preferences }),
  });
  const notifying = (types.data ?? []).filter((t) => t.notify);
  const get = (type: string) => prefs.data?.find((p) => p.eventType === type) ?? { eventType: type, inApp: true, desktop: true };
  return (
    <Panel title={it.appSettings.notifications.title} subtitle={it.appSettings.notifications.text} flush>
      {types.isLoading || prefs.isLoading ? (
        <div style={{ padding: 16 }}>
          <SkeletonLines lines={5} />
        </div>
      ) : (
        <table className={styles.prefTable} data-testid="notification-prefs">
          <thead>
            <tr>
              <th>{it.appSettings.notifications.event}</th>
              <th>{it.appSettings.notifications.importance}</th>
              <th className={styles.center}>{it.appSettings.notifications.inApp}</th>
              <th className={styles.center}>{it.appSettings.notifications.desktop}</th>
            </tr>
          </thead>
          <tbody>
            {notifying.map((t) => {
              const pref = get(t.type);
              return (
                <tr key={t.type}>
                  <td>
                    {t.labelIt}
                    <br />
                    <small className={styles.hint}>{t.audience === 'private' ? it.appSettings.notifications.privateAudience : it.appSettings.notifications.projectAudience}</small>
                  </td>
                  <td>
                    <Badge tone={t.importance === 'critical' ? 'red' : t.importance === 'important' ? 'amber' : 'neutral'}>{it.notifications.importance[t.importance]}</Badge>
                  </td>
                  <td className={styles.center}>
                    <Switch checked={pref.inApp} onChange={(v) => save.mutate({ ...pref, inApp: v })} label={`${t.labelIt}: ${it.appSettings.notifications.inApp}`} hideLabel />
                  </td>
                  <td className={styles.center}>
                    <Switch checked={pref.desktop} onChange={(v) => save.mutate({ ...pref, desktop: v })} label={`${t.labelIt}: ${it.appSettings.notifications.desktop}`} hideLabel />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function AccountPanel() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const auth = useSession((s) => s.auth);
  const { setAuth, setOnboarded } = useSession();
  const { data: me } = useMyProfile();
  const [name, setName] = useState('');
  const [color, setColor] = useState('');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (me) {
      setName(me.displayName);
      setColor(me.avatarColor ?? AVATAR_COLORS[0]!);
    }
  }, [me]);

  const saveProfile = useApiMutation(() => data.updateMyProfile({ displayName: name, avatarColor: color }), {
    invalidate: [qk.me, qk.profiles],
    successToast: it.appSettings.account.profileSaved,
    errorTitle: it.appSettings.account.title,
  });
  const signOut = useApiMutation(async () => {
    await backend.authSignOut();
    await data.setSession(null).catch(() => undefined);
  }, {
    errorTitle: it.appSettings.account.signOut,
    onSuccess: () => {
      setAuth({ signedIn: false, user: null, supabaseSession: null });
      setOnboarded(false);
      qc.clear();
      setConfirm(false);
      navigate('/onboarding');
    },
  });

  return (
    <Panel title={it.appSettings.account.title}>
      <div className={styles.accountRow}>
        <Avatar name={me?.displayName ?? auth?.user?.name ?? '?'} color={color || me?.avatarColor} size={48} />
        <div>
          <span>{it.appSettings.account.signedInAs}</span>
          <strong>{auth?.user?.name}</strong>
          <span className={styles.login}>
            <GithubMark /> @{auth?.user?.githubLogin}
          </span>
        </div>
        <span style={{ flex: 1 }} />
        <Button icon={<LogOut />} onClick={() => setConfirm(true)}>
          {it.appSettings.account.signOut}
        </Button>
      </div>
      <div className={styles.profileForm}>
        <Field label={it.appSettings.account.displayName}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />}</Field>
        <div>
          <span style={{ display: 'block', marginBottom: 6, fontSize: 'var(--text-sm)', fontWeight: 600 }}>{it.appSettings.account.avatarColor}</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} role="radiogroup" aria-label={it.appSettings.account.avatarColor}>
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={c}
                onClick={() => setColor(c)}
                style={{ width: 28, height: 28, borderRadius: '50%', background: c, border: color === c ? '3px solid var(--ink-900)' : '2px solid var(--paper-0)', boxShadow: '0 0 0 1px var(--steel-500)', cursor: 'pointer' }}
              />
            ))}
          </div>
        </div>
        <div>
          <Button variant="primary" onClick={() => saveProfile.mutate(undefined)} loading={saveProfile.isPending} disabled={!name.trim() || (name === me?.displayName && color === me?.avatarColor)}>
            {it.appSettings.account.saveProfile}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={it.appSettings.account.signOutTitle}
        description={it.appSettings.account.signOutText}
        confirmLabel={it.appSettings.account.signOutConfirm}
        onConfirm={() => signOut.mutate(undefined)}
        loading={signOut.isPending}
        tone="danger"
        icon={<LogOut />}
      />
    </Panel>
  );
}

function UpdatesPanel() {
  const { data: info } = useAppInfo();
  const [checked, setChecked] = useState(false);
  const check = useQuery({ queryKey: qk.updateCheck, queryFn: () => backend.checkForUpdate(), enabled: checked, staleTime: 0 });
  const install = useApiMutation(() => backend.installUpdate(), { errorTitle: it.appSettings.updates.install, onSuccess: () => toast.success(it.appSettings.updates.upToDate) });
  return (
    <Panel title={it.appSettings.updates.title}>
      <div className={styles.versionList}>
        {info && (
          <>
            <Badge tone="brass">{it.appSettings.updates.version(info.version)}</Badge>
            <Badge tone="neutral">{it.appSettings.updates.git(info.gitVersion)}</Badge>
            <Badge tone={info.openRocket.found ? 'neutral' : 'amber'}>{it.appSettings.updates.openRocket(info.openRocket.version)}</Badge>
          </>
        )}
      </div>
      <Button icon={<RefreshCw />} onClick={() => (checked ? void check.refetch() : setChecked(true))} loading={check.isFetching} data-testid="check-update">
        {check.isFetching ? it.appSettings.updates.checking : it.appSettings.updates.check}
      </Button>
      {check.data && (
        <div className={styles.notes} role="status">
          {check.data.available ? (
            <>
              <strong>{it.appSettings.updates.available(check.data.version ?? '')}</strong>
              {check.data.notes && <p>{check.data.notes}</p>}
              <div style={{ marginTop: 8 }}>
                <Button variant="primary" icon={<Download />} loading={install.isPending} onClick={() => install.mutate(undefined)}>
                  {install.isPending ? it.appSettings.updates.installing : it.appSettings.updates.install}
                </Button>
              </div>
            </>
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Info size={16} /> {it.appSettings.updates.upToDate}
            </span>
          )}
        </div>
      )}
    </Panel>
  );
}

function DiagnosticsPanel() {
  const run = useApiMutation(() => backend.exportDiagnostics(), {
    errorTitle: it.appSettings.diagnostics.title,
    onSuccess: (path) => toast.success(it.appSettings.diagnostics.exported(path)),
  });
  return (
    <Panel title={it.appSettings.diagnostics.title} subtitle={it.appSettings.diagnostics.text}>
      <Button icon={<Download />} loading={run.isPending} onClick={() => run.mutate(undefined)}>
        {run.isPending ? it.appSettings.diagnostics.exporting : it.appSettings.diagnostics.export}
      </Button>
    </Panel>
  );
}

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { data } from '../../lib/data';
import { backend } from '../../lib/backend';
import type { FileClaim } from '../../lib/types/data';
import { Avatar, Badge, Button, Dialog, Field, Input, Lock, Panel, Pencil, Select, X, IconButton, toast } from '../../ui';
import { it } from '../../i18n/it';
import { qk } from '../../app/queryClient';
import { useProfiles } from '../../app/hooks';
import { useSession } from '../../app/session';
import { useApiMutation } from '../../app/useApiMutation';
import { formatRelative, formatTime, formatDateTime } from '../../lib/utils/format';
import { QueryState } from '../../app/QueryState';
import styles from './ClaimsPanel.module.css';

const STALE_MS = 10 * 60_000;

export function ClaimsPanel({ projectId }: { projectId: string }) {
  const versions = useQuery({ queryKey: [...qk.versions(projectId), 'all'], queryFn: () => backend.listVersions({ projectId }) });
  const files = [...new Set((versions.data ?? []).flatMap((v) => v.files.map((f) => f.path)))].sort();
  const query = useQuery({ queryKey: qk.claims(projectId), queryFn: () => data.listFileClaims(projectId), refetchInterval: 30_000 });
  const { byId } = useProfiles();
  const me = useSession((s) => s.auth?.user?.githubLogin);
  const [reserving, setReserving] = useState(false);
  const mine = (c: FileClaim) => byId.get(c.userId)?.githubLogin === me;

  const release = useApiMutation((c: FileClaim) => data.releaseFile({ projectId, path: c.path, kind: c.kind }), {
    invalidate: [qk.claims(projectId)],
    successToast: it.overview.claims.released,
  });

  return (
    <Panel
      title={it.overview.claims.title}
      subtitle={it.overview.claims.warningOpen}
      actions={
        <Button size="sm" icon={<Lock />} onClick={() => setReserving(true)}>
          {it.overview.claims.reserve}
        </Button>
      }
      data-testid="claims-panel"
    >
      <QueryState query={query} lines={2}>
        {(claims) => {
          const others = claims.filter((c) => !mine(c) || c.kind === 'reserved');
          if (others.length === 0) return <p className={styles.empty}>{it.overview.claims.empty}</p>;
          return (
            <ul className={styles.list}>
              {others.map((c) => {
                const person = byId.get(c.userId);
                const name = person?.displayName ?? '?';
                const stale = c.kind === 'editing' && Date.now() - Date.parse(c.heartbeatAt) > STALE_MS;
                return (
                  <li key={`${c.userId}-${c.path}-${c.kind}`} className={styles.item}>
                    <Avatar name={name} color={person?.avatarColor} size={30} />
                    <div className={styles.text}>
                      <span>
                        <strong>{c.kind === 'editing' ? it.overview.claims.editing(name) : it.overview.claims.reserved(name)}</strong>{' '}
                        <span className={styles.path}>{c.path}</span>
                      </span>
                      <span className={styles.meta}>
                        {c.kind === 'editing' ? <Pencil size={12} /> : <Lock size={12} />}
                        {it.overview.claims.sinceTime(formatTime(c.startedAt))}
                        {stale && <> · {it.overview.claims.lastSignal(formatRelative(c.heartbeatAt))}</>}
                        {c.expiresAt && <> · {it.overview.claims.expires(formatDateTime(c.expiresAt))}</>}
                      </span>
                      {c.note && <span className={styles.note}>“{c.note}”</span>}
                    </div>
                    {stale && <Badge tone="neutral">{it.overview.claims.lastSignal(formatRelative(c.heartbeatAt))}</Badge>}
                    {mine(c) && c.kind === 'reserved' && <IconButton label={it.overview.claims.release} size="sm" icon={<X />} onClick={() => release.mutate(c)} />}
                  </li>
                );
              })}
            </ul>
          );
        }}
      </QueryState>
      <ReserveDialog open={reserving} onClose={() => setReserving(false)} projectId={projectId} files={files} />
    </Panel>
  );
}

function ReserveDialog({ open, onClose, projectId, files }: { open: boolean; onClose: () => void; projectId: string; files: string[] }) {
  const [chosenPath, setPath] = useState('');
  const path = chosenPath || files[0] || '';
  const [note, setNote] = useState('');
  const [until, setUntil] = useState('');
  const reserve = useApiMutation(
    () =>
      data.claimFile({
        projectId,
        path,
        kind: 'reserved',
        note: note.trim() || null,
        machineId: 'this-pc',
        expiresAt: until ? new Date(`${until}T23:59:59`).toISOString() : null,
      }),
    {
      invalidate: [qk.claims(projectId)],
      errorTitle: it.overview.claims.reserveTitle,
      onSuccess: () => {
        toast.success(it.overview.claims.reserveDone);
        setNote('');
        setUntil('');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={it.overview.claims.reserveTitle}
      description={it.overview.claims.reserveHint}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {it.common.cancel}
          </Button>
          <Button variant="primary" disabled={!path} loading={reserve.isPending} onClick={() => reserve.mutate(undefined)}>
            {it.overview.claims.reserve}
          </Button>
        </>
      }
    >
      <Field label={it.overview.claims.reservePath}>
        {(p) => (
          <Select {...p} value={path} onChange={(e) => setPath(e.target.value)}>
            {files.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={it.overview.claims.reserveNote} optional>
        {(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} placeholder={it.overview.claims.reserveNotePlaceholder} maxLength={140} />}
      </Field>
      <Field label={it.overview.claims.reserveUntil} optional>
        {(p) => <Input {...p} type="date" value={until} onChange={(e) => setUntil(e.target.value)} />}
      </Field>
    </Dialog>
  );
}

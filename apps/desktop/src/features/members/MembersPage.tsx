import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { data } from '../../lib/data';
import type { Invitation, Member, MemberRole } from '../../lib/types/data';
import { qk } from '../../app/queryClient';
import { useProjectContext } from '../project/ProjectLayout';
import { useSession } from '../../app/session';
import { useApiMutation } from '../../app/useApiMutation';
import { Avatar, Badge, Button, ConfirmDialog, Crown, Field, Input, Lock, Panel, Select, SkeletonLines, Trash2, UserPlus, X, Info } from '../../ui';
import { formatDate, formatRelative } from '../../lib/utils/format';
import { it } from '../../i18n/it';
import { QueryErrorBox } from '../shared/QueryErrorBox';
import styles from './MembersPage.module.css';

export function MembersPage() {
  const { project, isAdmin } = useProjectContext();
  const me = useSession((s) => s.auth?.user?.githubLogin);
  const members = useQuery({ queryKey: qk.members(project.id), queryFn: () => data.listMembers(project.id) });
  const invitations = useQuery({ queryKey: qk.invitations(project.id), queryFn: () => data.listInvitations(project.id), enabled: isAdmin });
  const [login, setLogin] = useState('');
  const [role, setRole] = useState<MemberRole>('member');
  const [removing, setRemoving] = useState<Member | null>(null);

  const invalidate = [qk.members(project.id), qk.invitations(project.id), qk.projects, ['activity', project.id]];
  const invite = useApiMutation(() => data.addMember(project.id, login, role), {
    invalidate,
    errorTitle: it.members.invite.title,
    onSuccess: () => {
      setLogin('');
    },
    successToast: () => it.members.invite.sent(login.trim().replace(/^@/, '')),
  });
  const changeRole = useApiMutation((v: { m: Member; role: MemberRole }) => data.setMemberRole(project.id, v.m.userId, v.role), {
    invalidate,
    errorTitle: it.members.changeRole,
    successToast: (_r, v) => it.members.roleChanged(v.m.profile.displayName, it.members.role[v.role]),
  });
  const remove = useApiMutation((m: Member) => data.removeMember(project.id, m.userId), {
    invalidate,
    errorTitle: it.members.remove,
    successToast: (_r, m) => it.members.removed(m.profile.displayName),
    onSuccess: () => setRemoving(null),
  });
  const revoke = useApiMutation((inv: Invitation) => data.revokeInvitation(project.id, inv), { invalidate, errorTitle: it.members.pending.revoke });

  if (members.isLoading) return <SkeletonLines lines={6} />;
  if (members.isError) return <QueryErrorBox error={members.error} onRetry={() => void members.refetch()} />;
  const list = members.data ?? [];

  return (
    <div className={styles.page}>
      <div>
        <h2 className={styles.title}>{it.members.title}</h2>
        <p className={styles.subtitle}>{it.members.subtitle}</p>
      </div>

      {!isAdmin && (
        <div className={styles.info} role="note" data-testid="admin-note">
          <Lock size={16} />
          <span>{it.members.adminActionsInfo}</span>
        </div>
      )}

      <Panel flush data-testid="members-list">
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{it.members.membersTitle}</th>
              <th>{it.members.role.admin} / {it.members.role.member}</th>
              <th>{it.members.lastActivity}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((m) => {
              const isMe = m.profile.githubLogin === me;
              return (
                <tr key={m.userId} data-testid={`member-${m.profile.githubLogin}`}>
                  <td>
                    <div className={styles.person}>
                      <Avatar name={m.profile.displayName} color={m.profile.avatarColor} size={36} />
                      <div>
                        <strong>
                          {m.profile.displayName} {isMe && <span className={styles.you}>({it.members.you})</span>}
                        </strong>
                        <span className={styles.login}>@{m.profile.githubLogin}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    {isAdmin ? (
                      <Select
                        aria-label={`${it.members.changeRole}: ${m.profile.displayName}`}
                        value={m.role}
                        onChange={(e) => changeRole.mutate({ m, role: e.target.value as MemberRole })}
                      >
                        <option value="admin">{it.members.role.admin}</option>
                        <option value="member">{it.members.role.member}</option>
                      </Select>
                    ) : (
                      <Badge tone={m.role === 'admin' ? 'brass' : 'neutral'} icon={m.role === 'admin' ? <Crown /> : undefined}>
                        {it.members.role[m.role]}
                      </Badge>
                    )}
                    <p className={styles.roleHint}>{it.members.roleHint[m.role]}</p>
                  </td>
                  <td className={styles.when}>
                    {m.lastActivityAt ? formatRelative(m.lastActivityAt) : it.members.never}
                    <span className={styles.since}>{it.members.since(formatDate(m.addedAt))}</span>
                  </td>
                  <td className={styles.actions}>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={isAdmin ? <Trash2 /> : <Lock />}
                      disabled={!isAdmin}
                      title={isAdmin ? undefined : it.common.adminOnly}
                      onClick={() => setRemoving(m)}
                    >
                      {it.members.remove}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      <div className={styles.columns}>
        <Panel title={it.members.invite.title} subtitle={it.members.invite.text}>
          <form
            className={styles.inviteForm}
            onSubmit={(e) => {
              e.preventDefault();
              if (login.trim() && isAdmin) invite.mutate(undefined);
            }}
          >
            <Field label={it.members.invite.login}>
              {(p) => <Input {...p} value={login} onChange={(e) => setLogin(e.target.value)} placeholder={it.members.invite.placeholder} disabled={!isAdmin} spellCheck={false} data-testid="invite-login" />}
            </Field>
            <Field label={it.members.invite.role}>
              {(p) => (
                <Select {...p} value={role} onChange={(e) => setRole(e.target.value as MemberRole)} disabled={!isAdmin}>
                  <option value="member">{it.members.role.member}</option>
                  <option value="admin">{it.members.role.admin}</option>
                </Select>
              )}
            </Field>
            <Button type="submit" variant="primary" icon={<UserPlus />} disabled={!isAdmin || !login.trim()} loading={invite.isPending} title={isAdmin ? undefined : it.common.adminOnly} data-testid="invite-button">
              {invite.isPending ? it.members.invite.sending : it.members.invite.send}
            </Button>
          </form>
          {!isAdmin && (
            <p className={styles.adminOnly}>
              <Info size={14} /> {it.common.adminOnly}
            </p>
          )}
        </Panel>

        {isAdmin && (
          <Panel title={it.members.pending.title}>
            {invitations.isLoading ? (
              <SkeletonLines lines={2} />
            ) : (invitations.data ?? []).length === 0 ? (
              <p className={styles.empty}>{it.members.pending.empty}</p>
            ) : (
              <ul className={styles.invitations}>
                {(invitations.data ?? []).map((inv) => (
                  <li key={inv.id}>
                    <span className={styles.login}>@{inv.githubLogin}</span>
                    <Badge tone="neutral">{it.members.role[inv.role]}</Badge>
                    <span className={styles.since}>{it.members.pending.sentAt(formatRelative(inv.createdAt))}</span>
                    <Button size="sm" variant="ghost" icon={<X />} onClick={() => revoke.mutate(inv)}>
                      {it.members.pending.revoke}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        )}
      </div>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        tone="danger"
        title={it.members.removeTitle(removing?.profile.displayName ?? '')}
        description={it.members.removeText}
        confirmLabel={it.members.removeConfirm}
        onConfirm={() => removing && remove.mutate(removing)}
        loading={remove.isPending}
        icon={<Trash2 />}
      />
    </div>
  );
}

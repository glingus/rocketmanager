import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { data } from '../../lib/data';
import type { Card, CardCategory, CardInput, CardPriority, CardStatus, Member } from '../../lib/types/data';
import { Avatar, Button, ColorPicker, ConfirmDialog, Drawer, Field, IconButton, Input, Paperclip, Select, Send, Textarea, Trash2, Archive, ExternalLink, X, Badge, ListChecks, MessageSquare, Spinner, RotateCcw, toast } from '../../ui';
import { isTask, noteToTaskPatch, normalizeColor, PRIORITIES, STATUSES } from '../../lib/utils/cards';
import { formatBytes, formatRelative } from '../../lib/utils/format';
import { it } from '../../i18n/it';
import { qk } from '../../app/queryClient';
import { useApiMutation } from '../../app/useApiMutation';
import { useSession } from '../../app/session';
import { useProfiles } from '../../app/hooks';
import { QueryState } from '../../app/QueryState';
import styles from './CardDrawer.module.css';

export function CardDrawer({
  card,
  categories,
  members,
  versions,
  isAdmin,
  readOnly,
  onClose,
  onUpdate,
  onDelete,
}: {
  card: Card;
  categories: CardCategory[];
  members: Member[];
  versions: number[];
  isAdmin: boolean;
  readOnly: boolean;
  onClose: () => void;
  onUpdate: (card: Card, patch: CardInput) => void;
  onDelete: (card: Card) => Promise<void> | void;
}) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const me = useSession((s) => s.auth?.user?.githubLogin);
  const { byId, profiles } = useProfiles();
  const myId = profiles.find((p) => p.githubLogin === me)?.id;
  const canDelete = isAdmin || card.createdBy === myId;
  const task = isTask(card);

  // Keep local drafts in sync when the card changes remotely or another card is opened.
  useEffect(() => {
    setTitle(card.title);
    setDescription(card.description);
  }, [card.id, card.title, card.description]);

  const commitTitle = () => {
    const t = title.trim();
    if (!t) setTitle(card.title);
    else if (t !== card.title) onUpdate(card, { title: t });
  };
  const commitDescription = () => {
    if (description !== card.description) onUpdate(card, { description });
  };

  const creator = byId.get(card.createdBy);

  return (
    <Drawer
      open
      onClose={onClose}
      width={540}
      title={card.status === 'archived' ? `${it.notes.statusColumn.archived}: ${card.title}` : task ? it.notes.task : it.notes.note}
      subtitle={it.notes.createdBy(creator?.displayName ?? it.common.unknown, formatRelative(card.createdAt))}
    >
      <div className={styles.body} data-card-color={normalizeColor(card.color)} data-testid="card-drawer">
        <div className={styles.stripe} />
        <Field label={it.notes.titleLabel}>
          {(p) => (
            <Input
              {...p}
              value={title}
              maxLength={200}
              readOnly={readOnly}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              className={styles.titleInput}
            />
          )}
        </Field>
        <Field label={it.notes.description}>
          {(p) => <Textarea {...p} value={description} readOnly={readOnly} placeholder={it.notes.descriptionPlaceholder} rows={4} onChange={(e) => setDescription(e.target.value)} onBlur={commitDescription} />}
        </Field>

        <div className={styles.twoCols}>
          <Field label={it.notes.priorityLabel}>
            {(p) => (
              <Select {...p} value={card.priority ?? ''} disabled={readOnly} onChange={(e) => onUpdate(card, { priority: (e.target.value || null) as CardPriority | null })}>
                <option value="">{it.notes.priorityNone}</option>
                {PRIORITIES.map((pr) => (
                  <option key={pr} value={pr}>
                    {it.notes.priority[pr]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={it.notes.category}>
            {(p) => (
              <Select {...p} value={card.categoryId ?? ''} disabled={readOnly} onChange={(e) => onUpdate(card, { categoryId: e.target.value || null })}>
                <option value="">{it.notes.noCategory}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div>
          <span className={styles.fieldLabel}>{it.notes.color}</span>
          <ColorPicker value={card.color} onChange={(c) => !readOnly && onUpdate(card, { color: c })} />
          <p className={styles.hint}>{it.notes.colorHint}</p>
        </div>

        {task ? (
          <section className={styles.taskBox} aria-label={it.notes.task}>
            <h3 className={styles.sectionTitle}>
              <ListChecks size={16} /> {it.notes.task}
            </h3>
            <div className={styles.twoCols}>
              <Field label={it.notes.assignee}>
                {(p) => (
                  <Select {...p} value={card.assigneeId ?? ''} disabled={readOnly} onChange={(e) => onUpdate(card, { assigneeId: e.target.value || null })}>
                    <option value="">{it.notes.unassigned}</option>
                    {members.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.profile.displayName}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={it.notes.dueDate}>
                {(p) => <Input {...p} type="date" value={card.dueDate ?? ''} readOnly={readOnly} onChange={(e) => onUpdate(card, { dueDate: e.target.value || null })} />}
              </Field>
              <Field label={it.notes.filters.status}>
                {(p) => (
                  <Select {...p} value={card.status} disabled={readOnly} onChange={(e) => onUpdate(card, { status: e.target.value as CardStatus })}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {it.notes.status[s]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={it.notes.detail.linkVersion}>
                {(p) => (
                  <Select {...p} value={card.linkedVersion ?? ''} disabled={readOnly} onChange={(e) => onUpdate(card, { linkedVersion: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">{it.notes.detail.noLinkedVersion}</option>
                    {versions.map((n) => (
                      <option key={n} value={n}>
                        v{n}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          </section>
        ) : (
          !readOnly && (
            <div className={styles.convert}>
              <Button icon={<ListChecks />} onClick={() => onUpdate(card, noteToTaskPatch(card))} data-testid="to-task">
                {it.notes.toTask}
              </Button>
              <p className={styles.hint}>{it.notes.toTaskHint}</p>
            </div>
          )
        )}

        <Attachments card={card} readOnly={readOnly} />
        <Comments card={card} readOnly={readOnly} />

        <div className={styles.footer}>
          {!readOnly && (
            <Button variant="ghost" icon={card.status === 'archived' ? <RotateCcw /> : <Archive />} onClick={() => onUpdate(card, { status: card.status === 'archived' ? 'open' : 'archived' })}>
              {card.status === 'archived' ? it.notes.detail.unarchive : it.notes.detail.archive}
            </Button>
          )}
          <span className={styles.spacer} />
          <Button variant="danger" icon={<Trash2 />} disabled={!canDelete || readOnly} title={canDelete ? undefined : it.notes.detail.cannotDelete} onClick={() => setConfirmDelete(true)}>
            {it.notes.detail.delete}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        tone="danger"
        title={it.notes.detail.deleteTitle}
        description={it.notes.detail.deleteText}
        confirmLabel={it.notes.detail.delete}
        onConfirm={async () => {
          await onDelete(card);
          setConfirmDelete(false);
          onClose();
        }}
        icon={<Trash2 />}
      />
    </Drawer>
  );
}

function Comments({ card, readOnly }: { card: Card; readOnly: boolean }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const { byId } = useProfiles();
  const query = useQuery({ queryKey: qk.comments(card.id), queryFn: () => data.listComments(card.id) });
  const add = useApiMutation(() => data.addComment(card.id, card.projectId, text), {
    errorTitle: it.notes.detail.commentSend,
    onSuccess: () => {
      setText('');
      void qc.invalidateQueries({ queryKey: qk.comments(card.id) });
      void data.emitEvent(card.projectId, 'card.commented', { title: card.title, cardId: card.id }).catch(() => undefined);
    },
  });
  const del = useApiMutation((id: string) => data.deleteComment(id), { invalidate: [qk.comments(card.id)], errorTitle: it.notes.detail.commentDelete });

  return (
    <section aria-label={it.notes.detail.comments}>
      <h3 className={styles.sectionTitle}>
        <MessageSquare size={16} /> {it.notes.detail.comments}
        {query.data && <Badge tone="neutral">{query.data.length}</Badge>}
      </h3>
      <QueryState query={query} lines={2}>
        {(comments) =>
          comments.length === 0 ? (
            <p className={styles.empty}>{it.notes.detail.noComments}</p>
          ) : (
            <ul className={styles.comments}>
              {comments.map((c) => {
                const author = byId.get(c.authorId);
                return (
                  <li key={c.id} className={styles.comment}>
                    <Avatar name={author?.displayName ?? '?'} color={author?.avatarColor} size={28} />
                    <div className={styles.commentBody}>
                      <div className={styles.commentHead}>
                        <strong>{author?.displayName ?? it.common.unknown}</strong>
                        <span>{formatRelative(c.createdAt)}</span>
                        {c.editedAt && <span>({it.notes.detail.commentEdited})</span>}
                        {!readOnly && <IconButton label={it.notes.detail.commentDelete} size="sm" icon={<X />} onClick={() => del.mutate(c.id)} />}
                      </div>
                      <p>{c.body}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )
        }
      </QueryState>
      {!readOnly && (
        <form
          className={styles.commentForm}
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) add.mutate(undefined);
          }}
        >
          <Textarea aria-label={it.notes.detail.commentPlaceholder} placeholder={it.notes.detail.commentPlaceholder} value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={5000} />
          <Button type="submit" icon={<Send />} disabled={!text.trim()} loading={add.isPending}>
            {it.notes.detail.commentSend}
          </Button>
        </form>
      )}
    </section>
  );
}

function Attachments({ card, readOnly }: { card: Card; readOnly: boolean }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const query = useQuery({ queryKey: qk.attachments(card.id), queryFn: () => data.listAttachments(card.id) });
  const upload = useApiMutation((file: File) => data.uploadAttachment(card.id, card.projectId, file), {
    invalidate: [qk.attachments(card.id)],
    errorTitle: it.notes.detail.attach,
  });
  const remove = useApiMutation((id: string) => {
    const att = query.data?.find((a) => a.id === id);
    return att ? data.deleteAttachment(att) : Promise.resolve();
  }, { invalidate: [qk.attachments(card.id)], errorTitle: it.notes.detail.removeAttachment });
  void qc;

  const openAttachment = async (id: string) => {
    const att = query.data?.find((a) => a.id === id);
    if (!att) return;
    try {
      const url = await data.attachmentUrl(att);
      window.open(url, '_blank', 'noopener');
    } catch {
      toast.error(it.errors.title);
    }
  };

  return (
    <section aria-label={it.notes.detail.attachments}>
      <h3 className={styles.sectionTitle}>
        <Paperclip size={16} /> {it.notes.detail.attachments}
        {query.data && <Badge tone="neutral">{query.data.length}</Badge>}
      </h3>
      <QueryState query={query} lines={2}>
        {(list) =>
          list.length === 0 ? (
            <p className={styles.empty}>{it.notes.detail.noAttachments}</p>
          ) : (
            <ul className={styles.attachments}>
              {list.map((a) => (
                <li key={a.id}>
                  <Paperclip size={14} />
                  <span className={styles.attName}>{a.filename}</span>
                  <span className={styles.attSize}>{formatBytes(a.sizeBytes)}</span>
                  <IconButton label={`${it.notes.detail.download}: ${a.filename}`} size="sm" icon={<ExternalLink />} onClick={() => void openAttachment(a.id)} />
                  {!readOnly && <IconButton label={it.notes.detail.removeAttachment} size="sm" icon={<X />} onClick={() => remove.mutate(a.id)} />}
                </li>
              ))}
            </ul>
          )
        }
      </QueryState>
      {!readOnly && (
        <div className={styles.upload}>
          <input
            ref={input}
            type="file"
            className="visually-hidden"
            aria-label={it.notes.detail.attach}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload.mutate(file);
              e.target.value = '';
            }}
          />
          <Button icon={upload.isPending ? <Spinner size={14} /> : <Paperclip />} onClick={() => input.current?.click()} disabled={upload.isPending}>
            {upload.isPending ? it.notes.detail.uploading : it.notes.detail.attach}
          </Button>
          <span className={styles.hint}>{it.notes.detail.attachHint}</span>
        </div>
      )}
    </section>
  );
}

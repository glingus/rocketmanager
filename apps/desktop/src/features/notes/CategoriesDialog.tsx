import { useState } from 'react';
import { data } from '../../lib/data';
import type { CardCategory } from '../../lib/types/data';
import { Button, CATEGORY_ICON_NAMES, CategoryIcon, ConfirmDialog, Dialog, IconButton, Input, Pencil, Plus, Select, Trash2, Check, X, toast } from '../../ui';
import { it } from '../../i18n/it';
import { qk } from '../../app/queryClient';
import { useApiMutation } from '../../app/useApiMutation';
import styles from './CategoriesDialog.module.css';

export function CategoriesDialog({ open, onClose, projectId, categories, isAdmin }: { open: boolean; onClose: () => void; projectId: string; categories: CardCategory[]; isAdmin: boolean }) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('tag');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<CardCategory | null>(null);
  const inv = [qk.categories(projectId), qk.cards(projectId)];

  const create = useApiMutation(() => data.createCategory(projectId, { name, icon }), {
    invalidate: inv,
    errorTitle: it.notes.categories.add,
    onSuccess: () => {
      toast.success(it.notes.categories.created);
      setName('');
    },
  });
  const rename = useApiMutation((v: { id: string; name: string }) => data.updateCategory(v.id, { name: v.name }), {
    invalidate: inv,
    errorTitle: it.notes.categories.rename,
    onSuccess: () => setEditing(null),
  });
  const remove = useApiMutation((c: CardCategory) => data.deleteCategory(c.id), {
    invalidate: inv,
    successToast: it.notes.categories.deleted,
    errorTitle: it.notes.categories.deleteTitle(''),
    onSuccess: () => setDeleting(null),
  });

  return (
    <>
      <Dialog open={open} onClose={onClose} title={it.notes.categories.title} width={560} actions={<Button onClick={onClose}>{it.common.close}</Button>}>
        <ul className={styles.list}>
          {categories.map((c) => (
            <li key={c.id} className={styles.item}>
              <CategoryIcon name={c.icon} size={18} />
              {editing?.id === c.id ? (
                <>
                  <Input
                    aria-label={it.notes.categories.name}
                    value={editing.name}
                    onChange={(e) => setEditing({ id: c.id, name: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && rename.mutate(editing)}
                    data-autofocus
                  />
                  <IconButton label={it.common.save} size="sm" icon={<Check />} onClick={() => rename.mutate(editing)} />
                  <IconButton label={it.common.cancel} size="sm" icon={<X />} onClick={() => setEditing(null)} />
                </>
              ) : (
                <>
                  <span className={styles.name}>{c.name}</span>
                  {c.isDefault && <span className={styles.note}>{it.notes.categories.defaultNote}</span>}
                  <IconButton label={`${it.notes.categories.rename}: ${c.name}`} size="sm" icon={<Pencil />} onClick={() => setEditing({ id: c.id, name: c.name })} />
                  <IconButton
                    label={isAdmin ? `${it.common.delete}: ${c.name}` : it.notes.categories.onlyAdminDelete}
                    size="sm"
                    icon={<Trash2 />}
                    disabled={!isAdmin}
                    onClick={() => setDeleting(c)}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
        <form
          className={styles.add}
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate(undefined);
          }}
        >
          <Select aria-label={it.notes.categories.icon} value={icon} onChange={(e) => setIcon(e.target.value)} className={styles.iconSelect}>
            {CATEGORY_ICON_NAMES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          <Input aria-label={it.notes.categories.name} placeholder={it.notes.categories.add} value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" icon={<Plus />} disabled={!name.trim()} loading={create.isPending}>
            {it.common.add}
          </Button>
        </form>
        {!isAdmin && <p className={styles.note}>{it.notes.categories.onlyAdminDelete}</p>}
      </Dialog>
      {deleting && (
        <ConfirmDialog
          open
          onClose={() => setDeleting(null)}
          tone="danger"
          title={it.notes.categories.deleteTitle(deleting.name)}
          description={it.notes.categories.deleteText}
          confirmLabel={it.common.delete}
          onConfirm={() => remove.mutate(deleting)}
          loading={remove.isPending}
        />
      )}
    </>
  );
}

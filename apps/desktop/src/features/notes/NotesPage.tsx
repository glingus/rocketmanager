import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { backend } from '../../lib/backend';
import type { Card, CardInput } from '../../lib/types/data';
import { filterCards, type CardFilters } from '../../lib/utils/cards';
import { useProjectContext } from '../project/ProjectLayout';
import { Button, Input, LayoutGrid, SegmentedControl, SkeletonLines, Columns3, Settings, Plus, WifiOff } from '../../ui';
import { FilterBar } from './FilterBar';
import { BoardView, ColumnsView } from './CardViews';
import { CardDrawer } from './CardDrawer';
import { CategoriesDialog } from './CategoriesDialog';
import { useNotesData } from './useNotesData';
import { readPref, writePref, useUi } from '../../app/uiStore';
import { QueryErrorBox } from '../shared/QueryErrorBox';
import { qk } from '../../app/queryClient';
import { it } from '../../i18n/it';
import styles from './NotesPage.module.css';

type ViewMode = 'board' | 'columns';

export function NotesPage() {
  const { project, isAdmin, linked } = useProjectContext();
  const notes = useNotesData(project.id);
  const offline = useUi((s) => s.offlineSince != null);
  const [view, setViewState] = useState<ViewMode>(() => readPref<ViewMode>(`notes.view.${project.id}`, 'board'));
  const [filters, setFilters] = useState<CardFilters>({});
  const [title, setTitle] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const readOnly = offline || !!project.archivedAt;

  const versions = useQuery({ queryKey: qk.versions(project.id), queryFn: () => backend.listVersions({ projectId: project.id }), enabled: linked });
  const versionNumbers = (versions.data ?? []).map((v) => v.number).filter((n): n is number => n != null && n > 0);

  const all = notes.cards.data ?? [];
  const visible = useMemo(() => filterCards(all, filters), [all, filters]);
  const filtered = visible.length !== all.filter((c) => filters.showArchived || c.status !== 'archived').length || Object.values(filters).some(Boolean);
  const open = openId ? all.find((c) => c.id === openId) : undefined;

  const setView = (v: ViewMode) => {
    setViewState(v);
    writePref(`notes.view.${project.id}`, v);
  };

  const quickAdd = () => {
    const t = title.trim();
    if (!t || readOnly) return;
    notes.create.mutate({ title: t });
    setTitle('');
  };

  const patch = (card: Card, p: CardInput) => notes.update.mutate({ card, patch: p });

  if (notes.cards.isLoading || notes.categories.isLoading) return <SkeletonLines lines={8} />;
  if (notes.cards.isError) return <QueryErrorBox error={notes.cards.error} onRetry={() => void notes.cards.refetch()} />;

  const openCount = all.filter((c) => c.status === 'open' || c.status === 'in_progress').length;

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <h2 className={styles.title}>{it.notes.title}</h2>
          <p className={styles.subtitle}>
            {it.notes.subtitle} · {it.notes.summaryOpen(openCount)}
          </p>
        </div>
        <div className={styles.headActions}>
          <SegmentedControl
            label={it.notes.viewLabel}
            value={view}
            onChange={setView}
            options={[
              { value: 'board', label: it.notes.view.board, icon: <LayoutGrid /> },
              { value: 'columns', label: it.notes.view.columns, icon: <Columns3 /> },
            ]}
          />
          <Button icon={<Settings />} onClick={() => setCategoriesOpen(true)}>
            {it.notes.categories.manage}
          </Button>
        </div>
      </div>

      {readOnly && !project.archivedAt && (
        <div className={styles.offline} role="status">
          <WifiOff size={16} /> {it.notes.readOnlyOffline}
        </div>
      )}

      <form
        className={styles.quick}
        onSubmit={(e) => {
          e.preventDefault();
          quickAdd();
        }}
      >
        <Plus size={18} className={styles.plus} aria-hidden="true" />
        <Input
          aria-label={it.notes.quickAddLabel}
          placeholder={it.notes.quickAdd}
          value={title}
          maxLength={200}
          disabled={readOnly}
          onChange={(e) => setTitle(e.target.value)}
          className={styles.quickInput}
          data-testid="quick-add"
        />
        <span className={styles.quickHint}>{it.notes.quickAddHint}</span>
      </form>

      <FilterBar
        filters={filters}
        onChange={setFilters}
        categories={notes.cats}
        members={notes.memberList}
        total={all.filter((c) => filters.showArchived || c.status !== 'archived').length}
        shown={visible.length}
        myId={notes.myId}
      />

      {view === 'board' ? (
        <BoardView
          cards={visible}
          categories={notes.cats}
          members={notes.memberList}
          onOpen={(c) => setOpenId(c.id)}
          onPatch={(c, p) => patch(c, p)}
          readOnly={readOnly}
          filtered={filtered}
        />
      ) : (
        <ColumnsView
          cards={visible}
          categories={notes.cats}
          members={notes.memberList}
          onOpen={(c) => setOpenId(c.id)}
          onPatch={(c, p) => patch(c, p)}
          readOnly={readOnly}
          filtered={filtered}
          showArchived={!!filters.showArchived}
        />
      )}

      {open && (
        <CardDrawer
          card={open}
          categories={notes.cats}
          members={notes.memberList}
          versions={versionNumbers}
          isAdmin={isAdmin}
          readOnly={readOnly}
          onClose={() => setOpenId(null)}
          onUpdate={patch}
          onDelete={async (c) => {
            await notes.remove.mutateAsync(c).catch(() => undefined);
          }}
        />
      )}
      <CategoriesDialog open={categoriesOpen} onClose={() => setCategoriesOpen(false)} projectId={project.id} categories={notes.cats} isAdmin={isAdmin} />
    </div>
  );
}

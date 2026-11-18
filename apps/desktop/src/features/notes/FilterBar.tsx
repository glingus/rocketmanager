import { useState } from 'react';
import type { CardCategory, CardPriority, CardStatus, Member } from '../../lib/types/data';
import { CARD_COLORS, PRIORITIES, STATUSES, countActiveFilters, type CardFilters, type DueFilter } from '../../lib/utils/cards';
import { Button, CategoryIcon, Chip, Filter, Input, Search, Select, Switch, X } from '../../ui';
import { it } from '../../i18n/it';
import styles from './FilterBar.module.css';

function toggle<T>(list: T[] | undefined, value: T): T[] {
  const set = new Set(list ?? []);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  return [...set];
}

export function FilterBar({
  filters,
  onChange,
  categories,
  members,
  total,
  shown,
  myId,
}: {
  filters: CardFilters;
  onChange: (f: CardFilters) => void;
  categories: CardCategory[];
  members: Member[];
  total: number;
  shown: number;
  myId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const active = countActiveFilters(filters);
  const f = it.notes.filters;
  const mineActive = !!myId && filters.assigneeIds?.length === 1 && filters.assigneeIds[0] === myId;

  return (
    <div className={styles.bar} data-testid="filter-bar">
      <div className={styles.row}>
        <div className={styles.search}>
          <Search size={16} className={styles.searchIcon} aria-hidden="true" />
          <Input aria-label={f.search} placeholder={f.search} value={filters.search ?? ''} onChange={(e) => onChange({ ...filters, search: e.target.value })} className={styles.searchInput} />
        </div>
        <div className={styles.priorityChips} role="group" aria-label={f.priority}>
          {PRIORITIES.map((p: CardPriority) => (
            <Chip key={p} active={filters.priorities?.includes(p)} onClick={() => onChange({ ...filters, priorities: toggle(filters.priorities, p) })}>
              {it.notes.priority[p]}
            </Chip>
          ))}
        </div>
        {myId && (
          <Chip active={mineActive} onClick={() => onChange({ ...filters, assigneeIds: mineActive ? [] : [myId] })}>
            {f.mine}
          </Chip>
        )}
        <Button size="sm" variant={open ? 'secondary' : 'ghost'} icon={<Filter />} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {f.title}
          {active > 0 ? ` · ${active}` : ''}
        </Button>
        <span className={styles.count}>{f.count(shown, total)}</span>
        {active > 0 && (
          <Button size="sm" variant="ghost" icon={<X />} onClick={() => onChange({ showArchived: filters.showArchived })}>
            {f.clear}
          </Button>
        )}
      </div>

      {open && (
        <div className={styles.panel}>
          <div className={styles.group}>
            <span className={styles.groupLabel}>{f.color}</span>
            <div className={styles.swatches}>
              {CARD_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={filters.colors?.includes(c) ?? false}
                  aria-label={it.notes.colors[c]}
                  title={it.notes.colors[c]}
                  data-card-color={c}
                  className={[styles.swatch, filters.colors?.includes(c) ? styles.swatchOn : ''].join(' ')}
                  onClick={() => onChange({ ...filters, colors: toggle(filters.colors, c) })}
                />
              ))}
            </div>
          </div>
          <div className={styles.group}>
            <span className={styles.groupLabel}>{f.category}</span>
            <div className={styles.chips}>
              {categories.map((c) => (
                <Chip key={c.id} active={filters.categoryIds?.includes(c.id)} onClick={() => onChange({ ...filters, categoryIds: toggle(filters.categoryIds, c.id) })}>
                  <CategoryIcon name={c.icon} size={13} /> {c.name}
                </Chip>
              ))}
            </div>
          </div>
          <div className={styles.group}>
            <span className={styles.groupLabel}>{f.status}</span>
            <div className={styles.chips}>
              {STATUSES.map((s: CardStatus) => (
                <Chip key={s} active={filters.statuses?.includes(s)} onClick={() => onChange({ ...filters, statuses: toggle(filters.statuses, s) })}>
                  {it.notes.status[s]}
                </Chip>
              ))}
            </div>
          </div>
          <div className={styles.selects}>
            <label className={styles.selectLabel}>
              {f.assignee}
              <Select
                value={filters.assigneeIds?.length === 1 ? filters.assigneeIds[0] : ''}
                onChange={(e) => onChange({ ...filters, assigneeIds: e.target.value ? [e.target.value] : [] })}
              >
                <option value="">{it.common.all}</option>
                <option value="none">{it.notes.unassigned}</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.profile.displayName}
                  </option>
                ))}
              </Select>
            </label>
            <label className={styles.selectLabel}>
              {f.due}
              <Select value={filters.due ?? 'any'} onChange={(e) => onChange({ ...filters, due: e.target.value as DueFilter })}>
                {(Object.keys(f.dueOptions) as DueFilter[]).map((d) => (
                  <option key={d} value={d}>
                    {f.dueOptions[d]}
                  </option>
                ))}
              </Select>
            </label>
            <Switch checked={!!filters.showArchived} onChange={(v) => onChange({ ...filters, showArchived: v })} label={f.showArchived} />
          </div>
        </div>
      )}
    </div>
  );
}

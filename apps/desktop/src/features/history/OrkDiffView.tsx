import type { ComponentChange, ConfigChange, DisplayValue, OrkDiff, OrkSummary, ParamChange, SimulationChange } from '../../lib/types/ipc';
import { ArrowRight, Badge, CircleAlert, Cpu, Minus, Plus, Pencil, Move, Rocket, Zap } from '../../ui';
import { it } from '../../i18n/it';
import styles from './OrkDiffView.module.css';

export function Value({ v }: { v: DisplayValue | null }) {
  if (!v) return <span className={styles.none}>{it.history.ork.noValue}</span>;
  return <span className={styles.value}>{v.display}</span>;
}

export function ParamRow({ p }: { p: ParamChange }) {
  return (
    <li className={styles.param}>
      <span className={styles.paramLabel}>{p.label}</span>
      <span className={styles.change}>
        {p.before ? <Value v={p.before} /> : <span className={styles.none}>{it.history.ork.noValue}</span>}
        <ArrowRight size={13} aria-label="diventa" />
        {p.after ? <Value v={p.after} /> : <span className={styles.none}>{it.history.ork.noValue}</span>}
      </span>
    </li>
  );
}

function KindIcon({ kind }: { kind: ComponentChange['kind'] | ConfigChange['kind'] | SimulationChange['kind'] }) {
  if (kind === 'added') return <Plus size={14} strokeWidth={3} />;
  if (kind === 'removed') return <Minus size={14} strokeWidth={3} />;
  if (kind === 'moved') return <Move size={14} />;
  return <Pencil size={13} strokeWidth={2.6} />;
}

const KIND_LABEL = { added: it.history.ork.added, removed: it.history.ork.removed, modified: it.history.ork.modified, moved: it.history.ork.moved } as const;

function ChangeCard({ kind, title, subtitle, children }: { kind: 'added' | 'removed' | 'modified' | 'moved'; title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <li className={styles.card} data-kind={kind}>
      <div className={styles.cardHead}>
        <span className={styles.kind} title={KIND_LABEL[kind]}>
          <KindIcon kind={kind} />
          <span className="visually-hidden">{KIND_LABEL[kind]}</span>
        </span>
        <div className={styles.titles}>
          <strong>{title}</strong>
          {subtitle && <span className={styles.sub}>{subtitle}</span>}
        </div>
        <Badge tone={kind === 'added' ? 'green' : kind === 'removed' ? 'red' : kind === 'moved' ? 'blue' : 'amber'}>{KIND_LABEL[kind]}</Badge>
      </div>
      {children}
    </li>
  );
}

function Summary({ s, label }: { s: OrkSummary | null; label: string }) {
  if (!s) return null;
  return (
    <div className={styles.summaryCol}>
      <span className={styles.summaryLabel}>{label}</span>
      <span>
        {it.history.ork.stages_n(s.stageCount)} · {it.history.ork.components_n(s.componentCount)} · {it.history.ork.sims_n(s.simulationCount)}
      </span>
      <span className={styles.creator}>{it.history.ork.created(s.creator)}</span>
    </div>
  );
}

/** Semantic diff of a .ork file: components, motors, simulations and what could not be interpreted. */
export function OrkDiffView({ diff, showSummary = true }: { diff: OrkDiff; showSummary?: boolean }) {
  if (diff.parseError) return <p className={styles.parseError}>{it.history.changelog.parseError}</p>;
  const hasAny = diff.components.length + diff.motorConfigurations.length + diff.simulations.length + diff.uninterpreted.length > 0;
  return (
    <div className={styles.root}>
      {showSummary && (diff.before || diff.after) && (
        <div className={styles.summary}>
          <Summary s={diff.before} label={it.history.ork.summaryBefore} />
          <Summary s={diff.after} label={it.history.ork.summaryAfter} />
        </div>
      )}
      {!hasAny && <p className={styles.none}>{it.history.changelog.noChanges}</p>}

      {diff.components.length > 0 && (
        <section>
          <h4 className={styles.section}>
            <Rocket size={14} /> {it.history.ork.components}
          </h4>
          <ul className={styles.list}>
            {diff.components.map((c, i) => (
              <ChangeCard key={`${c.name}-${i}`} kind={c.kind} title={c.name} subtitle={[...c.path, c.typeLabel].join(' › ')}>
                {c.params.length > 0 && (
                  <ul className={styles.params}>
                    {c.params.map((p) => (
                      <ParamRow key={p.key} p={p} />
                    ))}
                  </ul>
                )}
              </ChangeCard>
            ))}
          </ul>
        </section>
      )}

      {diff.motorConfigurations.length > 0 && (
        <section>
          <h4 className={styles.section}>
            <Cpu size={14} /> {it.history.ork.motors}
          </h4>
          <ul className={styles.list}>
            {diff.motorConfigurations.map((c, i) => (
              <ChangeCard key={`${c.name}-${i}`} kind={c.kind} title={c.name}>
                {c.params.length > 0 && (
                  <ul className={styles.params}>
                    {c.params.map((p) => (
                      <ParamRow key={p.key} p={p} />
                    ))}
                  </ul>
                )}
              </ChangeCard>
            ))}
          </ul>
        </section>
      )}

      {diff.simulations.length > 0 && (
        <section>
          <h4 className={styles.section}>
            <Zap size={14} /> {it.history.ork.simulations}
          </h4>
          <ul className={styles.list}>
            {diff.simulations.map((s, i) => (
              <ChangeCard key={`${s.name}-${i}`} kind={s.kind} title={`“${s.name}”`}>
                {s.conditions.length > 0 && (
                  <>
                    <p className={styles.group}>{it.history.ork.conditions}</p>
                    <ul className={styles.params}>
                      {s.conditions.map((p) => (
                        <ParamRow key={p.key} p={p} />
                      ))}
                    </ul>
                  </>
                )}
                {s.results.length > 0 && (
                  <>
                    <p className={styles.group}>{it.history.ork.results}</p>
                    <ul className={styles.params}>
                      {s.results.map((p) => (
                        <ParamRow key={p.key} p={p} />
                      ))}
                    </ul>
                  </>
                )}
                {s.dataUpdated && s.kind === 'modified' && <p className={styles.dataUpdated}>{it.history.ork.dataUpdated}</p>}
              </ChangeCard>
            ))}
          </ul>
        </section>
      )}

      {diff.uninterpreted.length > 0 && (
        <section className={styles.uninterpreted}>
          <h4 className={styles.section}>
            <CircleAlert size={14} /> {it.history.changelog.uninterpretedTitle}
          </h4>
          <p className={styles.uninterpretedText}>{it.history.changelog.uninterpretedText}</p>
          <ul className={styles.uList}>
            {diff.uninterpreted.map((u) => (
              <li key={u.section}>
                <strong>{it.history.changelog.uninterpreted(u.count, u.section)}</strong>
                {u.sample && <code className={styles.sample}>{u.sample}</code>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

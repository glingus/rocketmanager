import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { backend } from '../../lib/backend';
import type { VersionInfo } from '../../lib/types/ipc';
import { ArrowLeftRight, Button, EmptyState, Field, Panel, Select, X, Diff } from '../../ui';
import { it } from '../../i18n/it';
import { FileComparisonView } from './FileComparisonView';
import { QueryState } from '../../app/QueryState';
import styles from './ComparePanel.module.css';

/** Compare any two published versions. */
export function ComparePanel({ projectId, versions, initialFrom, initialTo, onClose }: { projectId: string; versions: VersionInfo[]; initialFrom: string; initialTo: string; onClose: () => void }) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const published = versions.filter((v) => v.published && v.kind !== 'init');
  const withInit = versions.filter((v) => v.published);
  const same = from === to;
  const query = useQuery({
    queryKey: ['compare', projectId, from, to],
    queryFn: () => backend.compareVersions({ projectId, fromSha: from, toSha: to }),
    enabled: !same && !!from && !!to,
  });
  const label = (v: VersionInfo) => `${it.history.versionNumber(v.number)} · ${v.kind === 'init' ? it.history.initTitle : v.title}`;

  return (
    <Panel
      data-testid="compare-panel"
      title={it.history.compare.title}
      actions={
        <Button size="sm" variant="ghost" icon={<X />} onClick={onClose}>
          {it.history.compare.close}
        </Button>
      }
    >
      <div className={styles.picker}>
        <Field label={it.history.compare.from}>
          {(p) => (
            <Select {...p} value={from} onChange={(e) => setFrom(e.target.value)}>
              {withInit.map((v) => (
                <option key={v.sha} value={v.sha}>
                  {label(v)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button icon={<ArrowLeftRight />} aria-label={it.history.compare.swap} onClick={() => { setFrom(to); setTo(from); }}>
          {it.history.compare.swap}
        </Button>
        <Field label={it.history.compare.to}>
          {(p) => (
            <Select {...p} value={to} onChange={(e) => setTo(e.target.value)}>
              {published.map((v) => (
                <option key={v.sha} value={v.sha}>
                  {label(v)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <div className={styles.result}>
        {same ? (
          <EmptyState compact icon={<Diff />} title={it.history.compare.same} />
        ) : (
          <QueryState query={query} lines={6}>
            {(c) => (
              <>
                <h3 className={styles.heading}>{it.history.compare.result(c.from.number, c.to.number)}</h3>
                {c.files.length === 0 ? (
                  <p>{it.history.compare.empty}</p>
                ) : (
                  <div className={styles.files}>
                    {c.files.map((f) => (
                      <FileComparisonView key={f.path} file={f} />
                    ))}
                  </div>
                )}
              </>
            )}
          </QueryState>
        )}
      </div>
    </Panel>
  );
}

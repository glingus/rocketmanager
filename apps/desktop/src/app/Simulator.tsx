import { useState } from 'react';
import { useMatch } from 'react-router-dom';
import { backend } from '../lib/backend';
import { getMockWorld } from '../lib/mock';
import { controls, installGlobalControls } from '../lib/mock/controls';
import { Button, Wrench, X, toast } from '../ui';
import { it } from '../i18n/it';
import { useUi } from './uiStore';
import { useLocalProjects } from './hooks';
import { errorMessage } from './errors';
import styles from './Simulator.module.css';

/** Mock-mode only: reproduces what happens outside the app (OpenRocket saving, colleagues publishing...). */
export function Simulator() {
  const [open, setOpen] = useState(false);
  const match = useMatch('/p/:projectId/*');
  const projectId = match?.params.projectId;
  const { data: local = [] } = useLocalProjects();
  const offline = useUi((s) => s.offlineSince != null);
  const params = new URLSearchParams(window.location.search);
  if (backend.kind !== 'mock' || params.get('nodev') === '1') return null;

  const world = getMockWorld();
  installGlobalControls(world);
  const linked = projectId && local.some((l) => l.projectId === projectId) ? projectId : undefined;

  const run = (fn: () => void) => {
    try {
      fn();
      toast.info(it.simulator.done);
    } catch (e) {
      toast.error(it.errors.title, { message: errorMessage(e) });
    }
  };

  return (
    <div className={styles.root}>
      {open && (
        <div className={styles.panel} role="dialog" aria-label={it.simulator.title}>
          <div className={styles.head}>
            <strong>{it.simulator.title}</strong>
            <button type="button" className={styles.close} onClick={() => setOpen(false)} aria-label={it.common.close}>
              <X size={16} />
            </button>
          </div>
          <p className={styles.hint}>{it.simulator.hint}</p>
          {linked ? (
            <div className={styles.actions}>
              <Button size="sm" onClick={() => run(() => controls.save(world, linked))}>{it.simulator.save}</Button>
              <Button size="sm" onClick={() => run(() => controls.saveInvalid(world, linked))}>{it.simulator.saveInvalid}</Button>
              <Button size="sm" onClick={() => run(() => controls.colleaguePublish(world, linked))}>{it.simulator.colleague}</Button>
              <Button size="sm" onClick={() => run(() => controls.colleagueOverlap(world, linked))}>{it.simulator.colleagueOverlap}</Button>
              <Button size="sm" onClick={() => run(() => controls.editorOpen(world, linked, null))}>{it.simulator.editorOpen}</Button>
              <Button size="sm" onClick={() => run(() => controls.editorClose(world, linked))}>{it.simulator.editorClose}</Button>
            </div>
          ) : (
            <p className={styles.hint}>{it.simulator.noProject}</p>
          )}
          <div className={styles.actions}>
            <Button size="sm" onClick={() => run(() => controls.offline(world, !offline))}>{offline ? it.simulator.online : it.simulator.offline}</Button>
            <Button size="sm" onClick={() => run(() => controls.appUpdate(world))}>{it.simulator.appUpdate}</Button>
          </div>
        </div>
      )}
      <button type="button" className={styles.fab} onClick={() => setOpen((o) => !o)} aria-label={it.simulator.open} aria-expanded={open} title={it.simulator.open} data-testid="simulator-toggle">
        <Wrench size={16} />
        <span>{it.simulator.title}</span>
      </button>
    </div>
  );
}

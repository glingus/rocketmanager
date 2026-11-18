import { lampIcon } from './icons';
import { stateMeta, type LampIcon, type LampTone } from '../lib/utils/status';
import type { SyncState } from '../lib/types/ipc';
import { it } from '../i18n/it';
import styles from './StatusLamp.module.css';

export type StatusLampProps = {
  tone: LampTone;
  icon: LampIcon;
  label: string;
  busy?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** Show the text next to the lamp (default). Hide only when the label is exposed elsewhere. */
  showLabel?: boolean;
  /** Use light text, for cherry-wood backgrounds. */
  onWood?: boolean;
};

/**
 * Workshop bench indicator: a lamp with its icon inside and the status written next to it.
 * Colour is never the only signal.
 */
export function StatusLamp({ tone, icon, label, busy, size = 'md', showLabel = true, onWood }: StatusLampProps) {
  const Icon = lampIcon(icon);
  return (
    <span className={[styles.lamp, styles[size], onWood ? styles.onWood : ''].join(' ')} data-tone={tone}>
      <span className={[styles.bulb, busy ? styles.busy : ''].join(' ')} aria-hidden="true">
        <Icon strokeWidth={2.6} />
      </span>
      {showLabel ? <span className={styles.label}>{label}</span> : <span className="visually-hidden">{label}</span>}
    </span>
  );
}

/** Lamp for a project sync state, with the Italian label. */
export function SyncStateLamp({ state, size, onWood, detail }: { state: SyncState; size?: StatusLampProps['size']; onWood?: boolean; detail?: string }) {
  const meta = stateMeta(state);
  const label = detail ? `${it.syncState[state]} ${detail}` : it.syncState[state];
  return <StatusLamp tone={meta.tone} icon={meta.icon} busy={meta.busy} label={label} size={size} onWood={onWood} />;
}

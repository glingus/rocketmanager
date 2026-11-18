import { initials } from '../lib/utils/format';
import styles from './Avatar.module.css';

export function Avatar({ name, color, size = 28, src }: { name: string; color?: string | null; size?: number; src?: string | null }) {
  const bg = color ?? '#6b5a4a';
  return (
    <span className={styles.avatar} style={{ width: size, height: size, fontSize: Math.round(size * 0.4), background: src ? undefined : bg }} title={name} role="img" aria-label={name}>
      {src ? <img src={src} alt="" /> : initials(name)}
    </span>
  );
}

import { CARD_COLORS, type CardColor } from '../lib/utils/cards';
import { it } from '../i18n/it';
import { Check } from './icons';
import styles from './ColorPicker.module.css';

export function ColorPicker({ value, onChange, label = it.notes.color }: { value: string; onChange: (c: CardColor) => void; label?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={styles.group}>
      {CARD_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={it.notes.colors[c]}
          title={it.notes.colors[c]}
          className={[styles.swatch, value === c ? styles.selected : ''].join(' ')}
          data-card-color={c}
          onClick={() => onChange(c)}
        >
          {value === c && <Check size={14} strokeWidth={3.4} />}
        </button>
      ))}
    </div>
  );
}

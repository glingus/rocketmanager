import { backend } from '../../lib/backend';
import type { ConflictFile, ResolutionChoice } from '../../lib/types/ipc';
import { Button, Check, ExternalLink, Panel, toast } from '../../ui';
import { it } from '../../i18n/it';
import { copyFileName } from '../../lib/utils/files';
import { useMyProfile } from '../../app/hooks';
import styles from './ChoicePanel.module.css';

const OPTIONS: ResolutionChoice[] = ['mine', 'theirs', 'both', 'manual'];

export function ChoicePanel({
  projectId,
  conflictId,
  file,
  choice,
  onChoice,
  manualDone,
  onManualDone,
  disabled,
}: {
  projectId: string;
  conflictId: string;
  file: ConflictFile;
  choice: ResolutionChoice | undefined;
  onChoice: (c: ResolutionChoice) => void;
  manualDone: boolean;
  onManualDone: (v: boolean) => void;
  disabled: boolean;
}) {
  const { data: me } = useMyProfile();
  const copy = copyFileName(file.path, (me?.displayName ?? '').split(' ')[0] || 'tua', new Date().toISOString());

  const open = async (side: 'base' | 'theirs') => {
    try {
      await backend.openConflictCopy({ projectId, conflictId, path: file.path, side });
      toast.success(it.conflicts.openedCopy);
    } catch {
      toast.error(it.errors.title);
    }
  };
  const hints: Record<ResolutionChoice, string> = {
    mine: it.conflicts.choice.mineHint,
    theirs: it.conflicts.choice.theirsHint,
    both: it.conflicts.choice.bothHint(copy),
    manual: it.conflicts.choice.manualHint,
  };

  return (
    <Panel title={it.conflicts.choice.label} subtitle={file.path} className={styles.panel} data-testid="choice-panel">
      <div role="radiogroup" aria-label={it.conflicts.choice.label} className={styles.options}>
        {OPTIONS.map((o) => (
          <label key={o} className={[styles.option, choice === o ? styles.chosen : ''].join(' ')}>
            <input type="radio" name={`choice-${file.path}`} value={o} checked={choice === o} onChange={() => onChoice(o)} disabled={disabled} />
            <span className={styles.radio} aria-hidden="true">
              {choice === o && <Check size={12} strokeWidth={3.4} />}
            </span>
            <span className={styles.optionText}>
              <strong>{it.conflicts.choice[o]}</strong>
              <span>{hints[o]}</span>
            </span>
          </label>
        ))}
      </div>

      {choice === 'manual' && (
        <div className={styles.manual}>
          <Button size="sm" variant={manualDone ? 'secondary' : 'primary'} icon={manualDone ? <Check /> : undefined} onClick={() => onManualDone(!manualDone)} disabled={disabled}>
            {manualDone ? it.conflicts.choice.manualReady : it.conflicts.choice.manualDone}
          </Button>
          {!manualDone && <p>{it.conflicts.choice.manualWaiting}</p>}
        </div>
      )}

      <div className={styles.open}>
        <Button icon={<ExternalLink />} onClick={() => void open('theirs')} data-testid="open-theirs">
          {it.conflicts.openTheirs}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void open('base')}>
          {it.conflicts.openBase}
        </Button>
      </div>
    </Panel>
  );
}

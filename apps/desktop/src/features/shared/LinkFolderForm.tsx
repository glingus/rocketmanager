import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { backend } from '../../lib/backend';
import { Button, Checkbox, FolderOpen, Input, TriangleAlert, Info, Check } from '../../ui';
import { it } from '../../i18n/it';
import type { FolderCheck } from '../../lib/types/ipc';
import styles from './LinkFolderForm.module.css';

export type FolderChoice = { path: string; check: FolderCheck | null; acceptedDrive: boolean; ok: boolean };

/** Folder picker with the pre-flight warnings (non empty folder, OneDrive/Dropbox/Google Drive). */
export function LinkFolderForm({ projectName, value, onChange, idPrefix = 'folder' }: { projectName: string; value: FolderChoice; onChange: (v: FolderChoice) => void; idPrefix?: string }) {
  const [path, setPath] = useState(value.path);
  const [picking, setPicking] = useState(false);

  const suggested = useQuery({ queryKey: ['suggest-folder', projectName], queryFn: () => backend.suggestProjectFolder(projectName), staleTime: Infinity });

  useEffect(() => {
    if (!value.path && suggested.data) {
      setPath(suggested.data);
    }
  }, [suggested.data, value.path]);

  const check = useQuery({
    queryKey: ['check-folder', path],
    queryFn: () => backend.checkFolder(path),
    enabled: path.trim().length > 2,
    staleTime: 10_000,
  });

  const result = check.data ?? null;
  const drive = result?.inSyncedDrive ?? null;
  const ok = !!result && result.writable && (!drive || value.acceptedDrive);

  useEffect(() => {
    if (value.path !== path || value.check !== result || value.ok !== ok) onChange({ ...value, path, check: result, ok });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, result, ok]);

  const browse = async () => {
    setPicking(true);
    try {
      const picked = await backend.pickFolder(path || undefined);
      if (picked) {
        setPath(picked);
        onChange({ ...value, path: picked, acceptedDrive: false, check: null, ok: false });
      }
    } finally {
      setPicking(false);
    }
  };

  const inputId = `${idPrefix}-path`;
  return (
    <div className={styles.form}>
      <label htmlFor={inputId} className={styles.label}>
        {it.onboarding.folders.folder}
      </label>
      <div className={styles.row}>
        <Input id={inputId} value={path} spellCheck={false} onChange={(e) => { setPath(e.target.value); onChange({ ...value, path: e.target.value, acceptedDrive: false, check: null, ok: false }); }} className={styles.path} />
        <Button icon={<FolderOpen />} onClick={() => void browse()} loading={picking}>
          {it.onboarding.folders.browse}
        </Button>
      </div>
      {suggested.data && path !== suggested.data && (
        <button type="button" className={styles.suggest} onClick={() => { setPath(suggested.data!); onChange({ ...value, path: suggested.data!, acceptedDrive: false, check: null, ok: false }); }}>
          {it.onboarding.folders.useSuggested}
        </button>
      )}

      <div aria-live="polite" className={styles.messages}>
        {check.isFetching && !result && <p className={styles.muted}>{it.onboarding.folders.checking}</p>}
        {result && !result.writable && (
          <p className={[styles.note, styles.error].join(' ')}>
            <TriangleAlert size={16} /> {it.onboarding.folders.notWritable}
          </p>
        )}
        {result && drive && (
          <div className={[styles.note, styles.warn].join(' ')}>
            <TriangleAlert size={16} />
            <div>
              <strong>{it.onboarding.folders.driveTitle(it.onboarding.folders.drives[drive])}</strong>
              <p>{it.onboarding.folders.driveText}</p>
              <Checkbox
                label={it.onboarding.folders.confirmDrive}
                checked={value.acceptedDrive}
                onChange={(e) => onChange({ ...value, path, check: result, acceptedDrive: e.target.checked, ok: result.writable && e.target.checked })}
              />
            </div>
          </div>
        )}
        {result && result.exists && !result.empty && (
          <div className={[styles.note, styles.info].join(' ')}>
            <Info size={16} />
            <div>
              <strong>{it.onboarding.folders.notEmptyTitle}</strong>
              <p>{it.onboarding.folders.notEmpty(result.fileCount)}</p>
            </div>
          </div>
        )}
        {result && result.writable && !drive && result.empty && (
          <p className={[styles.note, styles.good].join(' ')}>
            <Check size={16} /> {result.exists ? it.onboarding.folders.okEmpty : it.onboarding.folders.okNew}
          </p>
        )}
      </div>
    </div>
  );
}

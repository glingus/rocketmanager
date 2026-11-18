import { describe, expect, it } from 'vitest';
import type { ProjectStatus, SyncState } from '../types/ipc';
import { autoPublishRemaining, hasBlockingFileIssues, publishableFiles, stateMeta } from './status';
import { it as strings } from '../../i18n/it';

const STATES: SyncState[] = ['synced', 'localChanges', 'publishing', 'updateAvailable', 'updating', 'conflict', 'offline', 'error', 'notLinked'];

describe('state to lamp mapping', () => {
  it('uses the workshop colours of the plan', () => {
    expect(stateMeta('synced').tone).toBe('green');
    expect(stateMeta('localChanges').tone).toBe('amber');
    expect(stateMeta('updateAvailable').tone).toBe('amber');
    expect(stateMeta('conflict').tone).toBe('red');
    expect(stateMeta('offline').tone).toBe('blue');
    expect(stateMeta('notLinked').tone).toBe('neutral');
  });

  it('gives every state an icon and an Italian label (colour is never the only signal)', () => {
    for (const s of STATES) {
      expect(stateMeta(s).icon).toBeTruthy();
      expect(strings.syncState[s].length).toBeGreaterThan(2);
      expect(strings.syncStateHint[s].length).toBeGreaterThan(10);
    }
  });

  it('pulses only while an operation runs', () => {
    expect(STATES.filter((s) => stateMeta(s).busy)).toEqual(['publishing', 'updating']);
  });
});

describe('file readiness', () => {
  const file = (over: Partial<ProjectStatus['changedFiles'][number]>) => ({
    path: 'a.ork', change: 'modified' as const, stable: true, valid: true, sizeBytes: 1, modifiedAt: null, ...over,
  });
  it('blocks publication of unstable or invalid files', () => {
    expect(hasBlockingFileIssues({ changedFiles: [file({})] })).toBe(false);
    expect(hasBlockingFileIssues({ changedFiles: [file({ stable: false, valid: null })] })).toBe(true);
    expect(hasBlockingFileIssues({ changedFiles: [file({ valid: false })] })).toBe(true);
    expect(publishableFiles({ changedFiles: [file({}), file({ path: 'b', valid: false })] })).toHaveLength(1);
  });

  it('computes the automatic publication countdown', () => {
    expect(autoPublishRemaining(null)).toBeNull();
    expect(autoPublishRemaining('2026-11-18T12:10:00Z', Date.parse('2026-11-18T12:00:00Z'))).toBe(600_000);
    expect(autoPublishRemaining('2026-11-18T12:10:00Z', Date.parse('2026-11-18T12:30:00Z'))).toBe(0);
  });
});

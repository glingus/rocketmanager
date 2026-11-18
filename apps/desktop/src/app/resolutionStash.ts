import type { FileResolution } from '../lib/types/ipc';

/**
 * The core's `conflict-resolved` event only carries the new version number, while the shared
 * `conflicts` record also stores the choices. They are remembered here between the two.
 */
const stash = new Map<string, FileResolution[]>();

export function stashResolution(conflictId: string, resolutions: FileResolution[]): void {
  stash.set(conflictId, resolutions);
}

export function takeResolution(conflictId: string): FileResolution[] {
  const value = stash.get(conflictId) ?? [];
  stash.delete(conflictId);
  return value;
}

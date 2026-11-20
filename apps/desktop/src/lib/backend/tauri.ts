import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Backend } from './types';
import { toAppError } from './types';

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw toAppError(e);
  }
}

/** Real implementation: every method is a 1:1 `invoke` of the command in the IPC contract. */
export const tauriBackend: Backend = {
  kind: 'tauri',

  authStatus: () => call('auth_status'),
  authSignIn: () => call('auth_sign_in'),
  authSignOut: () => call('auth_sign_out'),
  secureStoreGet: (key) => call('secure_store_get', { key }),
  secureStoreSet: (key, value) => call('secure_store_set', { key, value }),
  secureStoreDelete: (key) => call('secure_store_delete', { key }),

  listLocalProjects: () => call('list_local_projects'),
  suggestProjectFolder: (projectName) => call('suggest_project_folder', { projectName }),
  checkFolder: (path) => call('check_folder', { path }),
  pickFolder: (defaultPath) => call('pick_folder', { defaultPath }),
  linkProject: (args) => call('link_project', args),
  unlinkProject: (projectId) => call('unlink_project', { projectId }),
  getProjectStatus: (projectId) => call('get_project_status', { projectId }),

  publish: (args) => call('publish', args),
  syncNow: (projectId) => call('sync_now', { projectId }),
  updateNow: (args) => call('update_now', args),
  discardChanges: (args) => call('discard_changes', args),
  answerStaleSave: (args) => call('answer_stale_save', args),
  getPublishPolicy: (projectId) => call('get_publish_policy', { projectId }),
  setPublishPolicy: (args) => call('set_publish_policy', args),

  listVersions: (args) => call('list_versions', args),
  getVersion: (args) => call('get_version', args),
  compareVersions: (args) => call('compare_versions', args),
  exportVersion: (args) => call('export_version', args),
  openVersionCopy: (args) => call('open_version_copy', args),
  restoreVersion: (args) => call('restore_version', args),

  listConflicts: (args) => call('list_conflicts', args),
  getConflict: (args) => call('get_conflict', args),
  openConflictCopy: (args) => call('open_conflict_copy', args),
  resolveConflict: (args) => call('resolve_conflict', args),
  listSnapshots: (projectId) => call('list_snapshots', { projectId }),
  exportSnapshot: (args) => call('export_snapshot', args),

  getAppInfo: () => call('get_app_info'),
  getPublicConfig: () => call('get_public_config'),
  openInOpenRocket: (args) => call('open_in_openrocket', args),
  openFolder: (path) => call('open_folder', { path }),
  getAppSettings: () => call('get_app_settings'),
  setAppSettings: (settings) => call('set_app_settings', { settings }),
  exportDiagnostics: () => call('export_diagnostics'),
  checkForUpdate: () => call('check_for_update'),
  installUpdate: () => call('install_update'),
  notifyDesktop: (args) => call('notify_desktop', args),
  notifyRemoteChanged: (projectId) => call('notify_remote_changed', { projectId }),

  on(event, handler) {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<Parameters<typeof handler>[0]>(event, (e) => handler(e.payload)).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  },
};

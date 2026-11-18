import { beforeEach, describe, expect, it } from 'vitest';
import { createMockWorld, PROJECT_IDS } from './index';
import { MockBackend } from '../backend/mock';
import { MockData } from '../data/mock';
import { controls, mainFile } from './controls';
import type { MockWorld } from './world';
import type { BackendEvents } from '../types/ipc';

const EXP = PROJECT_IDS.experimental;
const VEGA = PROJECT_IDS.vega;
const AURORA = PROJECT_IDS.aurora;

async function setup() {
  const world = createMockWorld({ seed: 'ready', speed: 0, timers: false, persist: false });
  await world.ready;
  return { world, backend: new MockBackend(world), data: new MockData(world) };
}

function collect<E extends keyof BackendEvents>(world: MockWorld, name: E) {
  const items: BackendEvents[E][] = [];
  world.onBackend(name, (p) => items.push(p));
  return items;
}

describe('mock backend: seeded scenario', () => {
  it('starts with local changes on Experimental Rocket and a conflict on Vega Booster', async () => {
    const { backend } = await setup();
    const exp = await backend.getProjectStatus(EXP);
    expect(exp.state).toBe('localChanges');
    expect(exp.changedFiles.map((f) => f.path).sort()).toEqual(['Dati banco prova.csv', 'Experimental Rocket.ork']);
    expect(exp.headVersion).toBe(12);
    expect(exp.autoPublishAt).not.toBeNull();
    const vega = await backend.getProjectStatus(VEGA);
    expect(vega.state).toBe('conflict');
    expect(vega.openConflictIds).toHaveLength(1);
    const aurora = await backend.getProjectStatus(AURORA);
    expect(aurora.state).toBe('synced');
  });

  it('computes a semantic three-way diff with overlapping parameters', async () => {
    const { backend } = await setup();
    const [conflict] = await backend.listConflicts({ projectId: VEGA });
    expect(conflict).toBeDefined();
    const file = conflict!.files[0]!;
    expect(file.kind).toBe('bothModified');
    const tw = file.threeWay!;
    expect(tw.independent).toBe(false);
    const labels = tw.overlapping.map((o) => `${o.componentName}/${o.key}`);
    expect(labels).toContain('Pinne trapezoidali/rootchord');
    expect(labels).toContain('Ogiva/length');
    const root = tw.overlapping.find((o) => o.key === 'rootchord')!;
    expect(root.mine?.display).toBe('100 mm');
    expect(root.theirs?.display).toBe('105 mm');
    // tipchord was changed only by me: independent, not in the overlap list
    expect(labels).not.toContain('Pinne trapezoidali/tipchord');
    expect(tw.mine.components.some((c) => c.params.some((p) => p.key === 'tipchord'))).toBe(true);
  });
});

describe('mock backend: publish', () => {
  it('publishes local changes as the next version, with changelog and event', async () => {
    const { backend, world } = await setup();
    const published = collect(world, 'version-published');
    const status = await backend.publish({ projectId: EXP, title: 'Tubo più lungo', description: 'Prova' });
    expect(status.state).toBe('synced');
    expect(status.headVersion).toBe(13);
    expect(status.changedFiles).toHaveLength(0);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ number: 13, title: 'Tubo più lungo' });
    const [latest] = await backend.listVersions({ projectId: EXP, limit: 1 });
    expect(latest!.number).toBe(13);
    expect(latest!.author.githubLogin).toBe('sferri');
    const rocket = latest!.changelog.find((g) => g.path === 'Experimental Rocket.ork')!;
    expect(rocket.interpreted).toBe(true);
    expect(rocket.lines.join('\n')).toContain('Tubo del motore');
    // webhook side: indexed version + Activity Log
    const indexed = await world.indexedVersions.get(EXP)!;
    expect(indexed.some((v) => v.number === 13)).toBe(true);
    expect(world.activity.some((a) => a.type === 'version.published' && a.summary.includes('versione 13'))).toBe(true);
  });

  it('refuses to publish files that are not stable or valid', async () => {
    const { backend, world } = await setup();
    await backend.discardChanges({ projectId: AURORA, paths: [] });
    controls.saveInvalid(world, AURORA);
    await expect(backend.publish({ projectId: AURORA })).rejects.toMatchObject({ code: 'fileInvalid' });
  });

  it('creates a pending version offline and sends it with a recalculated number when back online', async () => {
    const { backend, world } = await setup();
    world.setOffline(true);
    const status = await backend.publish({ projectId: EXP, title: 'Lavoro in treno' });
    expect(status.state).toBe('offline');
    expect(status.pendingVersions).toHaveLength(1);
    expect(status.pendingVersions[0]).toMatchObject({ waitingReason: 'offline' });
    const [pending] = await backend.listVersions({ projectId: EXP, limit: 1 });
    expect(pending!.number).toBeNull();
    expect(pending!.published).toBe(false);
    // a colleague publishes while we are offline
    controls.colleaguePublish(world, EXP);
    world.setOffline(false);
    await world.sim(EXP).fetchTick();
    const after = await backend.getProjectStatus(EXP);
    expect(after.state).toBe('synced');
    expect(after.pendingVersions).toHaveLength(0);
    const versions = await backend.listVersions({ projectId: EXP, limit: 2 });
    expect(versions.map((v) => v.number)).toEqual([14, 13]);
    expect(versions[0]!.title).toBe('Lavoro in treno');
  });
});

describe('mock backend: updates from colleagues', () => {
  it('applies a colleague version automatically when files are not open in OpenRocket', async () => {
    const { backend, world } = await setup();
    const applied = collect(world, 'update-applied');
    controls.colleaguePublish(world, AURORA);
    await world.sim(AURORA).fetchTick();
    const st = await backend.getProjectStatus(AURORA);
    expect(st.state).toBe('synced');
    expect(st.headVersion).toBe(8);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ fromVersion: 7, toVersion: 8 });
  });

  it('blocks the update when OpenRocket has the file open, then forces it and guards a stale save', async () => {
    const { backend, world } = await setup();
    const aurora = world.sim(AURORA);
    controls.editorOpen(world, AURORA, ['Aurora.ork']);
    controls.colleaguePublish(world, AURORA);
    await aurora.fetchTick();
    const blocked = await backend.getProjectStatus(AURORA);
    expect(blocked.state).toBe('updateAvailable');
    expect(blocked.blockedByEditor).toEqual(['Aurora.ork']);
    expect(blocked.headVersion).toBe(7);
    await expect(backend.updateNow({ projectId: AURORA })).rejects.toMatchObject({ code: 'blockedByEditor' });

    const forced = await backend.updateNow({ projectId: AURORA, force: true });
    expect(forced.headVersion).toBe(8);
    expect(forced.state).toBe('synced');

    const stale = collect(world, 'stale-save-suspected');
    controls.save(world, AURORA);
    const afterSave = await backend.getProjectStatus(AURORA);
    expect(afterSave.staleSaveSuspected).toEqual(['Aurora.ork']);
    expect(stale).toHaveLength(1);
    await expect(backend.publish({ projectId: AURORA })).rejects.toMatchObject({ code: 'staleSavePending' });

    // "No / non so" -> conflict instead of silently overwriting the colleague's work
    const answered = await backend.answerStaleSave({ projectId: AURORA, path: 'Aurora.ork', reopened: false });
    expect(answered.state).toBe('conflict');
    expect(answered.staleSaveSuspected).toHaveLength(0);
  });

  it('closing OpenRocket lets a blocked update go through', async () => {
    const { backend, world } = await setup();
    controls.editorOpen(world, AURORA, null);
    controls.colleaguePublish(world, AURORA);
    await world.sim(AURORA).fetchTick();
    expect((await backend.getProjectStatus(AURORA)).state).toBe('updateAvailable');
    controls.editorClose(world, AURORA);
    await new Promise((r) => setTimeout(r, 0));
    expect((await backend.getProjectStatus(AURORA)).headVersion).toBe(8);
  });

  it('answering "yes, I reopened the file" just keeps the save as a normal change', async () => {
    const { backend, world } = await setup();
    controls.editorOpen(world, AURORA, ['Aurora.ork']);
    controls.colleaguePublish(world, AURORA);
    await world.sim(AURORA).fetchTick();
    await backend.updateNow({ projectId: AURORA, force: true });
    controls.save(world, AURORA);
    const st = await backend.answerStaleSave({ projectId: AURORA, path: 'Aurora.ork', reopened: true });
    expect(st.state).toBe('localChanges');
    expect(st.staleSaveSuspected).toHaveLength(0);
  });
});

describe('mock backend: conflicts', () => {
  it('detects a conflict when a colleague changes the same parameter, leaving local files untouched', async () => {
    const { backend, world } = await setup();
    const detected = collect(world, 'conflict-detected');
    const before = JSON.stringify(world.sim(EXP).working['Experimental Rocket.ork']!.content);
    controls.colleagueOverlap(world, EXP);
    await world.sim(EXP).fetchTick();
    const st = await backend.getProjectStatus(EXP);
    expect(st.state).toBe('conflict');
    expect(st.openConflictIds).toHaveLength(1);
    expect(detected).toHaveLength(1);
    expect(JSON.stringify(world.sim(EXP).working['Experimental Rocket.ork']!.content)).toBe(before);
    await expect(backend.publish({ projectId: EXP })).rejects.toMatchObject({ code: 'conflictOpen' });
    // local work was put in a pending version
    expect(st.pendingVersions[0]).toMatchObject({ title: 'Modifiche locali in conflitto', waitingReason: 'conflict' });
  });

  it('resolves with mine, theirs, both and creates a conflictResolution version', async () => {
    for (const choice of ['mine', 'theirs', 'both'] as const) {
      const { backend, world } = await setup();
      const resolved = collect(world, 'conflict-resolved');
      const [conflict] = await backend.listConflicts({ projectId: VEGA });
      const status = await backend.resolveConflict({
        projectId: VEGA,
        conflictId: conflict!.id,
        resolutions: [{ path: 'Vega.ork', choice }],
      });
      expect(status.state).toBe('synced');
      expect(status.headVersion).toBe(7);
      expect(resolved).toEqual([{ projectId: VEGA, conflictId: conflict!.id, number: 7 }]);
      const [latest] = await backend.listVersions({ projectId: VEGA, limit: 1 });
      expect(latest).toMatchObject({ number: 7, kind: 'conflictResolution', conflictId: conflict!.id });
      const paths = latest!.files.map((f) => f.path);
      if (choice === 'both') expect(paths.some((p) => p.startsWith('Vega - versione Simone'))).toBe(true);
      const root = world.sim(VEGA).working['Vega.ork']!.content;
      const fs = root.kind === 'ork' ? root.doc.stages[0]!.children.flatMap((c) => c.children).find((c) => c.id === 've-fs1')! : null;
      const rootchord = fs?.params.find((p) => p.key === 'rootchord')?.value;
      if (choice === 'mine') expect(rootchord).toBe('0.1');
      if (choice === 'theirs' || choice === 'both') expect(rootchord).toBe('0.105');
    }
  });

  it('requires a choice for every conflicting file', async () => {
    const { backend } = await setup();
    const [conflict] = await backend.listConflicts({ projectId: VEGA });
    await expect(backend.resolveConflict({ projectId: VEGA, conflictId: conflict!.id, resolutions: [] })).rejects.toBeDefined();
  });
});

describe('mock backend: history, compare, restore', () => {
  it('shows a semantic diff against the previous version and between any two versions', async () => {
    const { backend } = await setup();
    const versions = await backend.listVersions({ projectId: EXP });
    const v3 = versions.find((v) => v.number === 3)!;
    const v2 = versions.find((v) => v.number === 2)!;
    const cmp = await backend.compareVersions({ projectId: EXP, fromSha: v2.sha, toSha: v3.sha });
    const ork = cmp.files.find((f) => f.path === 'Experimental Rocket.ork')!.ork!;
    const fins = ork.components.find((c) => c.name === 'Pinne trapezoidali')!;
    expect(fins.kind).toBe('modified');
    const root = fins.params.find((p) => p.key === 'rootchord')!;
    expect(root.before?.display).toBe('80 mm');
    expect(root.after?.display).toBe('95 mm');
    expect(ork.simulations[0]).toMatchObject({ name: 'Volo nominale', dataUpdated: true });
    // csv files get a text diff
    const v4 = versions.find((v) => v.number === 4)!;
    const cmp2 = await backend.compareVersions({ projectId: EXP, fromSha: v3.sha, toSha: v4.sha });
    expect(cmp2.files[0]).toMatchObject({ path: 'Dati banco prova.csv', change: 'added' });
    expect(cmp2.files[0]!.textDiff).toContain('+tempo_s');
  });

  it('flags uninterpreted changes', async () => {
    const { backend } = await setup();
    const versions = await backend.listVersions({ projectId: EXP });
    const v7 = versions.find((v) => v.number === 7)!;
    const v6 = versions.find((v) => v.number === 6)!;
    const cmp = await backend.compareVersions({ projectId: EXP, fromSha: v6.sha, toSha: v7.sha });
    expect(cmp.files[0]!.ork!.uninterpreted.length).toBeGreaterThan(0);
    expect(v7.changelog[0]!.lines.join(' ')).toContain('non interpretat');
  });

  it('restoring creates a new version and never deletes history', async () => {
    const { backend } = await setup();
    await backend.discardChanges({ projectId: EXP, paths: ['Experimental Rocket.ork', 'Dati banco prova.csv'] });
    const before = await backend.listVersions({ projectId: EXP });
    const v5 = before.find((v) => v.number === 5)!;
    const status = await backend.restoreVersion({ projectId: EXP, sha: v5.sha });
    expect(status.headVersion).toBe(13);
    const after = await backend.listVersions({ projectId: EXP });
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]).toMatchObject({ number: 13, kind: 'restore', restoredFrom: 5 });
    expect(after.slice(1).map((v) => v.sha)).toEqual(before.map((v) => v.sha));
  });

  it('refuses to restore over unpublished changes', async () => {
    const { backend } = await setup();
    const versions = await backend.listVersions({ projectId: EXP });
    const v5 = versions.find((v) => v.number === 5)!;
    await expect(backend.restoreVersion({ projectId: EXP, sha: v5.sha })).rejects.toMatchObject({ code: 'localChangesPresent' });
  });

  it('supports restoring a single file', async () => {
    const { backend } = await setup();
    await backend.discardChanges({ projectId: EXP, paths: ['Experimental Rocket.ork', 'Dati banco prova.csv'] });
    const versions = await backend.listVersions({ projectId: EXP });
    const v4 = versions.find((v) => v.number === 4)!;
    const status = await backend.restoreVersion({ projectId: EXP, sha: v4.sha, paths: ['Dati banco prova.csv'] });
    expect(status.headVersion).toBe(13);
    const [latest] = await backend.listVersions({ projectId: EXP, limit: 1 });
    expect(latest!.files.map((f) => f.path)).toEqual(['Dati banco prova.csv']);
  });
});

describe('mock data service', () => {
  it('keeps the Activity Log at the configured retention without touching versions', async () => {
    const { data, world } = await setup();
    const project = world.project(EXP);
    await data.updateProject(EXP, { settings: { activityRetention: 10 } });
    for (let i = 0; i < 15; i++) await data.emitEvent(EXP, 'card.created', { title: `Card ${i}` });
    const log = await data.listActivity(EXP);
    expect(log).toHaveLength(10);
    expect(project.settings.activityRetention).toBe(10);
    expect((await backendVersions(world)).length).toBeGreaterThan(10);
  });

  it('notifies the user only for events by others and honours preferences', async () => {
    const { data, world } = await setup();
    const unread = await data.unreadNotificationCount();
    expect(unread).toBeGreaterThan(0);
    await data.emitEvent(EXP, 'conflict.detected', { files: 'x' }); // by me: no notification
    expect(await data.unreadNotificationCount()).toBe(unread);
    controls.colleaguePublish(world, AURORA);
    expect(await data.unreadNotificationCount()).toBe(unread + 1);
    await data.setPreference({ eventType: 'version.published', inApp: false, desktop: false });
    controls.colleaguePublish(world, AURORA);
    expect(await data.unreadNotificationCount()).toBe(unread + 1);
    await data.markNotificationsRead();
    expect(await data.unreadNotificationCount()).toBe(0);
  });

  it('rejects event types the client may not write', async () => {
    const { data } = await setup();
    await expect(data.emitEvent(EXP, 'version.published', {})).rejects.toMatchObject({ code: 'internal' });
  });

  it('protects the last admin and hides admin actions from members', async () => {
    const { data } = await setup();
    await expect(data.setMemberRole(EXP, 'u-simone', 'member')).rejects.toMatchObject({ message: expect.stringContaining('almeno un amministratore') });
    await expect(data.removeMember(AURORA, 'u-luca')).rejects.toMatchObject({ code: 'authFailed' });
    await expect(data.setDiscordWebhook(AURORA, 'https://discord.com/api/webhooks/1/abc')).rejects.toMatchObject({ code: 'authFailed' });
  });

  it('invites by GitHub username and validates the webhook url', async () => {
    const { data } = await setup();
    await data.addMember(EXP, 'nuovoutente', 'member');
    expect((await data.listInvitations(EXP)).map((i) => i.githubLogin)).toContain('nuovoutente');
    await expect(data.addMember(EXP, 'nuovoutente', 'member')).rejects.toBeDefined();
    await expect(data.addMember(EXP, 'non valido!', 'member')).rejects.toBeDefined();
    await expect(data.setDiscordWebhook(EXP, 'http://example.com')).rejects.toBeDefined();
    await data.setDiscordWebhook(EXP, 'https://discord.com/api/webhooks/123/abc-DEF');
    expect((await data.getDiscordSettings(EXP)).webhookConfigured).toBe(true);
    await data.sendDiscordTest(EXP);
  });
});

async function backendVersions(world: MockWorld) {
  return world.sim(EXP).versions();
}

describe('mock backend: linking', () => {
  beforeEach(() => undefined);
  it('links a project from a fresh state and reports progress', async () => {
    const world = createMockWorld({ seed: 'fresh', speed: 0, timers: false, persist: false });
    await world.ready;
    const backend = new MockBackend(world);
    expect((await backend.authStatus()).signedIn).toBe(false);
    expect((await backend.authSignIn()).signedIn).toBe(true);
    const progress = collect(world, 'operation-progress');
    const status = await backend.linkProject({ projectId: AURORA, repoFullName: 'rocketsync-team/aurora-sounding', folder: 'C:\\Users\\simone\\RocketSync\\Aurora Sounding' });
    expect(status.state).toBe('synced');
    expect(status.headVersion).toBe(7);
    expect(progress.at(-1)).toMatchObject({ step: 'done', percent: 100 });
    expect(await backend.listLocalProjects()).toHaveLength(1);
    expect(mainFile(world, AURORA)).toBe('Aurora.ork');
    const check = await backend.checkFolder('C:\\Users\\simone\\OneDrive\\Razzi');
    expect(check.inSyncedDrive).toBe('onedrive');
  });
});

describe('mock backend: notify_remote_changed', () => {
  it('fetches and applies a colleague version right away', async () => {
    const { backend, world } = await setup();
    controls.colleaguePublish(world, AURORA);
    expect((await backend.getProjectStatus(AURORA)).headVersion).toBe(7);
    await backend.notifyRemoteChanged(AURORA);
    expect((await backend.getProjectStatus(AURORA)).headVersion).toBe(8);
  });
});

/** In-memory "git" primitives for the mock backend: trees, commits, change descriptions. */
import type {
  ChangelogGroup,
  FileChange,
  FileComparison,
  VersionInfo,
  VersionKind,
} from '../types/ipc';
import { approxSize, changelogFromDiff, cloneDoc, diffOrk, type OrkDoc } from './ork';
import { unifiedDiff } from './textdiff';

export type FileContent =
  | { kind: 'ork'; doc: OrkDoc }
  | { kind: 'text'; text: string }
  | { kind: 'binary'; size: number; tag: string };

export type Tree = Record<string, FileContent>;

export type Person = { id: string; login: string; name: string; email: string; color: string };

export type Commit = {
  sha: string;
  number: number | null;
  kind: VersionKind;
  title: string;
  description: string | null;
  authorId: string;
  date: string;
  tree: Tree;
  /** Tree this local (pending) commit was built on, used to rebase it before sending. */
  baseTree?: Tree | undefined;
  parentSha: string | null;
  restoredFrom: number | null;
  conflictId: string | null;
  published: boolean;
  changelog: ChangelogGroup[];
  files: FileChange[];
};

export function contentSize(c: FileContent | undefined): number | null {
  if (!c) return null;
  if (c.kind === 'ork') return approxSize(c.doc);
  if (c.kind === 'text') return new TextEncoder().encode(c.text).length;
  return c.size;
}

export function contentEquals(a: FileContent | undefined, b: FileContent | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'ork' && b.kind === 'ork') return JSON.stringify(a.doc) === JSON.stringify(b.doc);
  if (a.kind === 'text' && b.kind === 'text') return a.text === b.text;
  if (a.kind === 'binary' && b.kind === 'binary') return a.tag === b.tag && a.size === b.size;
  return false;
}

export function cloneContent(c: FileContent): FileContent {
  if (c.kind === 'ork') return { kind: 'ork', doc: cloneDoc(c.doc) };
  return { ...c };
}

export function cloneTree(tree: Tree): Tree {
  const out: Tree = {};
  for (const [k, v] of Object.entries(tree)) out[k] = cloneContent(v);
  return out;
}

export function isBinary(c: FileContent | undefined): boolean {
  return !c || c.kind !== 'text';
}

/** Paths whose content differs between two trees. */
export function changedPaths(a: Tree, b: Tree): string[] {
  const paths = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...paths].filter((p) => !contentEquals(a[p], b[p])).sort();
}

export function describeFileChange(path: string, before: FileContent | undefined, after: FileContent | undefined): FileChange {
  return {
    path,
    change: !before ? 'added' : !after ? 'deleted' : 'modified',
    binary: isBinary(after ?? before),
    sizeBefore: contentSize(before),
    sizeAfter: contentSize(after),
  };
}

export function describeChanges(from: Tree, to: Tree): { files: FileChange[]; changelog: ChangelogGroup[] } {
  const files: FileChange[] = [];
  const changelog: ChangelogGroup[] = [];
  for (const path of changedPaths(from, to)) {
    const before = from[path];
    const after = to[path];
    files.push(describeFileChange(path, before, after));
    if ((before?.kind ?? after?.kind) === 'ork') {
      const diff = diffOrk(path, before?.kind === 'ork' ? before.doc : null, after?.kind === 'ork' ? after.doc : null);
      const lines = changelogFromDiff(diff);
      changelog.push({ path, lines: lines.length ? lines : ['Modificato (contenuto non interpretato)'], interpreted: lines.length > 0 });
    } else {
      const verb = !before ? 'Aggiunto' : !after ? 'Rimosso' : 'Modificato (contenuto non interpretato)';
      changelog.push({ path, lines: [verb], interpreted: false });
    }
  }
  return { files, changelog };
}

export function compareTrees(from: Tree, to: Tree): FileComparison[] {
  return changedPaths(from, to).map((path) => {
    const before = from[path];
    const after = to[path];
    const base = describeFileChange(path, before, after);
    let ork = null;
    let textDiff: string | null = null;
    let note: string | null = null;
    const kind = (after ?? before)?.kind;
    if (kind === 'ork') {
      ork = diffOrk(path, before?.kind === 'ork' ? before.doc : null, after?.kind === 'ork' ? after.doc : null);
    } else if (kind === 'text') {
      textDiff = unifiedDiff(
        before?.kind === 'text' ? before.text : '',
        after?.kind === 'text' ? after.text : '',
        before ? path : '/dev/null',
        after ? path : '/dev/null',
      );
    } else {
      note = 'File binario: cambiata solo la dimensione';
    }
    return { ...base, ork, textDiff, note };
  });
}

// ---- Identifiers -----------------------------------------------------------

function fnv(seed: string, salt: number): number {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic fake sha-1 (40 hex chars). */
export function makeSha(seed: string): string {
  let out = '';
  for (let i = 0; out.length < 40; i++) out += fnv(seed, i * 7919 + 13).toString(16).padStart(8, '0');
  return out.slice(0, 40);
}

export function randomId(length = 6): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export function conflictId(now: Date = new Date()): string {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `${d}-${randomId(6)}`;
}

// ---- Version info ----------------------------------------------------------

export function toVersionInfo(commit: Commit, person: Person): VersionInfo {
  return {
    number: commit.number,
    sha: commit.sha,
    kind: commit.kind,
    title: commit.title,
    description: commit.description,
    changelog: commit.changelog,
    author: { name: person.name, email: person.email, githubLogin: person.login },
    date: commit.date,
    files: commit.files,
    restoredFrom: commit.restoredFrom,
    conflictId: commit.conflictId,
    published: commit.published,
  };
}

/** Title generated when the user does not write one ("Modificato Razzo.ork"). */
export function generatedTitle(paths: string[]): string {
  if (paths.length === 1) return `Modificato ${paths[0]}`;
  return `Modificati ${paths.length} file`;
}

export function copyName(path: string, owner: string, date: string): string {
  const dot = path.lastIndexOf('.');
  const base = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : '';
  return `${base} - versione ${owner} ${date}${ext}`;
}

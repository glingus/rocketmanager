/** Minimal line-based unified diff (LCS), enough for small text files such as CSV logs. */
export function unifiedDiff(
  before: string,
  after: string,
  fromName = 'a',
  toName = 'b',
  context = 3,
): string | null {
  if (before === after) return null;
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  type Op = { t: ' ' | '-' | '+'; line: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ t: ' ', line: a[i]!, ai: i, bi: j });
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      ops.push({ t: '+', line: b[j]!, ai: i, bi: j });
      j++;
    } else {
      ops.push({ t: '-', line: a[i]!, ai: i, bi: j });
      i++;
    }
  }
  // group into hunks
  const changed = ops.map((o, idx) => (o.t === ' ' ? -1 : idx)).filter((x) => x >= 0);
  if (changed.length === 0) return null;
  const hunks: Array<[number, number]> = [];
  let start = Math.max(0, changed[0]! - context);
  let end = Math.min(ops.length - 1, changed[0]! + context);
  for (const idx of changed.slice(1)) {
    if (idx - context <= end + 1) end = Math.min(ops.length - 1, idx + context);
    else {
      hunks.push([start, end]);
      start = Math.max(0, idx - context);
      end = Math.min(ops.length - 1, idx + context);
    }
  }
  hunks.push([start, end]);

  const out = [`--- ${fromName}`, `+++ ${toName}`];
  for (const [s, e] of hunks) {
    const slice = ops.slice(s, e + 1);
    const aStart = slice.find((o) => o.t !== '+')?.ai ?? slice[0]!.ai;
    const bStart = slice.find((o) => o.t !== '-')?.bi ?? slice[0]!.bi;
    const aLen = slice.filter((o) => o.t !== '+').length;
    const bLen = slice.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aStart + 1},${aLen} +${bStart + 1},${bLen} @@`);
    for (const o of slice) out.push(`${o.t}${o.line}`);
  }
  return out.join('\n');
}

/**
 * FQ-workspace.markdown: a stale save in the code editor (src/workspace-editor-api.ts) no longer
 * has to be refused outright. When the version on disk changed since the file was opened, this
 * does a line-based three-way merge of the base text (what was opened), "mine" (the edit being
 * saved) and "theirs" (what is on disk now). If the two sides changed different lines, the merge
 * succeeds and both edits land; if they touched the same lines, it returns null and the caller
 * still refuses the save, exactly as before.
 */

interface Hunk {
  /** The half-open range of BASE lines this hunk replaces, `[start, end)`. */
  start: number;
  end: number;
  /** The lines that replace that range. */
  lines: string[];
}

const splitLines = (text: string): string[] => text.split("\n");

/**
 * The classic LCS-backed line diff: a minimal set of replace hunks that turns `a` into `b`.
 * `O(n*m)`, which is fine at the editor's own 32 KiB file limit.
 */
function diffLines(a: string[], b: string[]): Hunk[] {
  const n = a.length, m = b.length;
  const dp: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!, next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0, j = 0;
  let hunkStart = -1, deleteCount = 0, insert: string[] = [];
  const flush = (): void => {
    if (hunkStart >= 0) hunks.push({ start: hunkStart, end: hunkStart + deleteCount, lines: insert });
    hunkStart = -1; deleteCount = 0; insert = [];
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) { flush(); i++; j++; continue; }
    if (hunkStart < 0) hunkStart = i;
    if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { deleteCount++; i++; } else { insert.push(b[j]!); j++; }
  }
  if (i < n) { if (hunkStart < 0) hunkStart = i; deleteCount += n - i; i = n; }
  if (j < m) { if (hunkStart < 0) hunkStart = i; insert.push(...b.slice(j)); j = m; }
  flush();
  return hunks;
}

const overlaps = (x: Hunk, y: Hunk): boolean => x.start < y.end && y.start < x.end;

/**
 * Merges `mine` and `theirs`, both edited from the same `base`. Returns the merged text when the
 * two sides' changed line ranges do not overlap, or `null` when they do (a real conflict — the
 * caller keeps refusing the save in that case).
 */
export function mergeThreeWay(base: string, mine: string, theirs: string): string | null {
  if (mine === theirs) return mine;
  const baseLines = splitLines(base);
  const mineHunks = diffLines(baseLines, splitLines(mine));
  const theirsHunks = diffLines(baseLines, splitLines(theirs));
  if (!mineHunks.length) return theirs;
  if (!theirsHunks.length) return mine;
  for (const a of mineHunks) for (const b of theirsHunks) if (overlaps(a, b)) return null;
  const all = [...mineHunks, ...theirsHunks].sort((x, y) => x.start - y.start || x.end - y.end);
  const out: string[] = [];
  let pos = 0;
  for (const hunk of all) {
    out.push(...baseLines.slice(pos, hunk.start));
    out.push(...hunk.lines);
    pos = hunk.end;
  }
  out.push(...baseLines.slice(pos));
  return out.join("\n");
}
